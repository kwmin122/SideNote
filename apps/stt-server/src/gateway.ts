import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from './config.js';
import { SttProviderError, type SpeechToTextProvider } from './provider.js';
import { PcmWindower, rms } from './window.js';
import { dedupAgainstPrevious, isUsableTranscript } from './text.js';
import { LineAggregator, type Fragment } from './aggregate.js';

/** 이만큼 조용하면 앞뒤 문맥이 이어지지 않는다고 보고 프롬프트 문맥을 버린다. */
const CONTEXT_RESET_MS = 30000;
/** 강의 제목 등 고정 프롬프트에서 가져올 최대 길이. 나머지는 직전 자막에 양보한다. */
const BASE_PROMPT_CHARS = 140;
/**
 * window 끝이 이만큼 조용하면 말이 끊긴 것으로 보고 그 자리에서 줄을 확정한다.
 * window(5초)보다 짧은 쉼표 정도의 멈춤은 window 전체 RMS 로는 잡히지 않는다.
 */
const SILENCE_TAIL_MS = 1000;

/**
 * STT 게이트웨이. 제공자(provider)를 주입받으므로 whisper 없이도 테스트할 수 있다.
 *
 * 자막은 두 갈래로 나간다.
 * - transcript.partial : window 하나가 인식될 때마다. 저장하지 않는다. 영상 위 오버레이용.
 * - transcript         : 문장 단위로 묶인 확정 자막. 사이드패널이 저장/표시한다.
 */
export async function createGateway(provider: SpeechToTextProvider, serverConfig: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(websocket);

  app.get('/health', async () => ({
    ok: provider.isReady(),
    provider: provider.describe(),
    binaryExists: existsSync(serverConfig.whisperServerBin),
    modelExists: existsSync(serverConfig.whisperModel),
    window: { windowMs: serverConfig.windowMs, overlapMs: serverConfig.overlapMs, sampleRate: serverConfig.sampleRate },
    line: { maxMs: serverConfig.lineMaxMs, maxChars: serverConfig.lineMaxChars }
  }));

  app.get('/v1/transcription', { websocket: true }, (socket) => {
    let sessionId = '';
    let language = serverConfig.language;
    let basePrompt = '';
    let sequence = 0;
    let previousText = '';
    /** Whisper 에 되돌려줄 직전 인식 결과. 문맥이 있으면 이어지는 말을 훨씬 잘 받아쓴다. */
    let contextText = '';
    let lastAudioEndMs = -1;
    let draining = false;
    let closed = false;
    let backlogWarned = false;
    /** session.end 를 받으면 남은 꼬리 오디오까지 인식하고 session.ended 를 보낸다. */
    let ending = false;

    const windower = new PcmWindower({
      sampleRate: serverConfig.sampleRate,
      windowMs: serverConfig.windowMs,
      overlapMs: serverConfig.overlapMs,
      maxBacklogMs: serverConfig.maxBacklogSec * 1000
    });

    const aggregator = new LineAggregator({
      maxLineMs: serverConfig.lineMaxMs,
      maxLineChars: serverConfig.lineMaxChars,
      // 이어지는 window 는 overlap 때문에 간격이 음수다. 양수 간격 = 무음으로 건너뛴 window.
      gapMs: 200
    });

    const send = (payload: unknown) => {
      if (closed) return;
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        /* 이미 닫힌 소켓 */
      }
    };

    const sendError = (code: string, message: string, retryable: boolean) =>
      send({ type: 'error', code, message, retryable });

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg?.type === 'session.end') {
          void drain(true);
          return;
        }
        if (msg?.type === 'session.init') {
          sessionId = String(msg.sessionId ?? randomUUID());
          // 'auto' 는 whisper 자동 감지. 한국어 강의는 서버 기본값(ko)이 더 정확하다.
          language = msg.language && msg.language !== 'auto' ? String(msg.language) : serverConfig.language;
          // 강의 페이지 제목 등을 Whisper 프롬프트로 넘긴다. 전문 용어 인식률이 올라간다.
          // 다만 Whisper 는 프롬프트를 "직전에 이미 말한 문장"으로 취급하므로,
          // 오디오 첫머리가 프롬프트와 같은 단어로 시작하면 그 부분을 건너뛴다(README '알려진 한계' 참고).
          basePrompt = String(msg.prompt ?? '').slice(0, BASE_PROMPT_CHARS);
          sequence = 0;
          previousText = '';
          contextText = '';
          lastAudioEndMs = -1;
          aggregator.reset();
          send({ type: 'session.ready', sessionId });
          // 모델 로딩은 여기서 시작해 첫 window 지연을 줄인다.
          void provider.start().catch((err) => {
            const code = err instanceof SttProviderError ? err.code : 'STT_PROVIDER_FAILED';
            sendError(code, String(err?.message ?? err), false);
          });
        }
        return;
      }
      windower.push(Buffer.from(data));
      if (windower.droppedMs > 0 && !backlogWarned) {
        backlogWarned = true;
        sendError('STT_RATE_LIMITED', `인식이 지연되어 오디오 ${Math.round(windower.droppedMs / 1000)}초를 건너뛰었습니다.`, true);
      }
      void drain();
    });

    socket.on('close', () => {
      closed = true;
    });

    async function drain(final = false) {
      if (final) ending = true;
      // 이미 처리 중이면 그 루프가 ending 플래그를 보고 마무리한다.
      if (draining || closed) return;
      draining = true;
      try {
        for (;;) {
          const window = windower.next();
          if (!window) break;
          await handleWindow(window.pcm, window.startedAtMs, window.endedAtMs);
          if (closed) break;
        }
        if (ending && !closed) {
          ending = false;
          // windowMs 에 못 미치는 마지막 구간도 버리지 않는다(단, 환각을 유발할 만큼 짧으면 flush 가 버린다).
          // flush 로 나오는 꼬리는 앞쪽 overlapMs 가 이미 인식된 구간이다.
          // 새 오디오가 1초도 안 되면 같은 말을 한 번 더 받아쓴 줄만 남으므로 버린다.
          const tail = windower.flush(serverConfig.overlapMs + 1200);
          if (tail) await handleWindow(tail.pcm, tail.startedAtMs, tail.endedAtMs);
          // 아직 문장이 안 끝났어도 종료 시점의 마지막 줄은 반드시 내보낸다.
          emitLine(aggregator.flush());
          send({ type: 'session.ended', sessionId });
        }
      } finally {
        draining = false;
      }
    }

    /** 확정된 한 줄을 사이드패널로 보낸다. */
    function emitLine(line: Fragment | null) {
      if (!line || !isUsableTranscript(line.text)) return;
      sequence += 1;
      send({
        type: 'transcript',
        payload: {
          id: randomUUID(),
          sessionId,
          sequence,
          text: line.text,
          isFinal: true,
          startedAtMs: line.startedAtMs,
          endedAtMs: line.endedAtMs,
          createdAt: Date.now()
        }
      });
    }

    /** 진행 중인 줄을 오버레이로 보낸다. 저장하지 않는다. */
    function sendPartial() {
      const pending = aggregator.pending;
      send({
        type: 'transcript.partial',
        payload: {
          sessionId,
          text: pending?.text ?? '',
          startedAtMs: pending?.startedAtMs ?? 0,
          endedAtMs: pending?.endedAtMs ?? 0
        }
      });
    }

    /** 무음 구간을 만나면 문장이 끝난 것으로 보고 진행 중인 줄을 확정한다. */
    function closeOnSilence() {
      previousText = '';
      const line = aggregator.flush();
      if (!line) return;
      emitLine(line);
      sendPartial();
    }

    /** window 끝부분만 따로 본 무음 판정. 문장 사이의 멈춤을 줄 경계로 삼기 위한 것이다. */
    function tailIsSilent(pcm: Buffer): boolean {
      const bytes = Math.min(pcm.length, Math.floor((serverConfig.sampleRate * 2 * SILENCE_TAIL_MS) / 1000));
      if (bytes <= 0) return false;
      return rms(pcm.subarray(pcm.length - bytes)) < serverConfig.minRms;
    }

    function buildPrompt(): string {
      return [basePrompt, contextText].filter(Boolean).join(' ').trim();
    }

    async function handleWindow(pcm: Buffer, startedAtMs: number, endedAtMs: number) {
      if (rms(pcm) < serverConfig.minRms) {
        closeOnSilence();
        return;
      }
      // 오래 조용했으면 직전 문맥이 더는 이어지지 않는다.
      if (lastAudioEndMs >= 0 && startedAtMs - lastAudioEndMs > CONTEXT_RESET_MS) {
        contextText = '';
        previousText = '';
      }
      lastAudioEndMs = endedAtMs;

      let text: string;
      try {
        const result = await provider.transcribe({ pcm, sampleRate: serverConfig.sampleRate, language, prompt: buildPrompt() });
        text = result.text;
      } catch (err) {
        const code = err instanceof SttProviderError ? err.code : 'STT_PROVIDER_FAILED';
        const retryable = err instanceof SttProviderError ? err.retryable : true;
        sendError(code, String((err as Error)?.message ?? err), retryable);
        return;
      }
      if (!isUsableTranscript(text)) return;
      // window 가 겹치는 만큼 앞부분이 직전 자막과 중복된다.
      const deduped = dedupAgainstPrevious(previousText, text);
      previousText = text;
      if (!isUsableTranscript(deduped)) return;

      contextText = `${contextText} ${deduped}`.replace(/\s+/g, ' ').trim().slice(-serverConfig.promptContextChars);
      for (const line of aggregator.push({ text: deduped, startedAtMs, endedAtMs })) emitLine(line);
      // window 끝이 조용하면 말이 끊긴 지점이다. 다음 window 를 기다리지 않고 줄을 확정한다.
      if (tailIsSilent(pcm)) closeOnSilence();
      else sendPartial();
    }
  });

  return app;
}
