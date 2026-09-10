import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { SttProviderError, type SpeechToTextProvider, type TranscribeRequest, type TranscribeResult } from './provider.js';
import { pcm16ToWav } from './wav.js';

export interface WhisperServerOptions {
  binary: string;
  model: string;
  host: string;
  port: number;
  language: string;
  threads: number;
  /** beam search 폭. 1 이하면 whisper-server 기본값(greedy)을 쓴다. */
  beamSize?: number;
  startupTimeoutMs: number;
  /** 이미 실행 중인 서버 주소. 주어지면 프로세스를 띄우지 않고 붙기만 한다. */
  externalUrl?: string;
  log?: (message: string) => void;
}

/**
 * whisper-server 를 "한 번만" 띄우고 모델을 메모리에 유지한 채
 * 3초 window 마다 HTTP /inference 로만 호출하는 제공자.
 * (whisper-cli 를 매 chunk 마다 새로 spawn 하지 않는다.)
 */
export class WhisperServerProvider implements SpeechToTextProvider {
  readonly name = 'whisper.cpp/whisper-server';
  private child?: ChildProcessByStdio<null, Readable, Readable>;
  private ready = false;
  private starting?: Promise<void>;
  private stopped = false;
  private readonly baseUrl: string;
  private readonly log: (message: string) => void;
  /** whisper-server 는 요청을 직렬 처리한다. 클라이언트 쪽에서도 큐를 하나로 유지한다. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: WhisperServerOptions) {
    this.baseUrl = options.externalUrl?.replace(/\/$/, '') || `http://${options.host}:${options.port}`;
    this.log = options.log ?? (() => {});
  }

  isReady() {
    return this.ready;
  }

  describe() {
    return {
      provider: this.name,
      url: this.baseUrl,
      model: this.options.model,
      language: this.options.language,
      threads: this.options.threads,
      beamSize: this.options.beamSize ?? 0,
      managed: !this.options.externalUrl,
      ready: this.ready
    };
  }

  async start(): Promise<void> {
    if (this.ready) return;
    this.starting ??= this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.stopped = false;
    if (!this.options.externalUrl) {
      if (!existsSync(this.options.binary)) {
        throw new SttProviderError(
          `whisper-server 실행 파일이 없습니다: ${this.options.binary}\nnpm run setup:whisper 를 먼저 실행하세요.`,
          'STT_CONNECTION_FAILED',
          false
        );
      }
      if (!existsSync(this.options.model)) {
        throw new SttProviderError(
          `Whisper 모델 파일이 없습니다: ${this.options.model}\nnpm run setup:whisper 를 먼저 실행하세요.`,
          'STT_CONNECTION_FAILED',
          false
        );
      }
      this.spawnServer();
    }
    await this.waitUntilReady();
    this.ready = true;
    this.log(`whisper-server 준비 완료: ${this.baseUrl}`);
  }

  private spawnServer() {
    const args = [
      '-m', this.options.model,
      '-l', this.options.language,
      '-t', String(this.options.threads),
      '--host', this.options.host,
      '--port', String(this.options.port),
      '--inference-path', '/inference',
      '-nt',
      // 무음 구간에서 "(음악)" 같은 비음성 토큰이 자막으로 새어나오지 않게 한다.
      '-sns'
    ];
    const child = spawn(this.options.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', (data) => this.log(`[whisper] ${String(data).trimEnd()}`));
    child.stderr.on('data', (data) => {
      const line = String(data).trimEnd();
      if (/error|fail/i.test(line)) this.log(`[whisper] ${line}`);
    });
    child.on('exit', (code, signal) => {
      this.ready = false;
      this.child = undefined;
      if (!this.stopped) this.log(`whisper-server 가 종료되었습니다 (code=${code} signal=${signal}). 다음 요청 시 재시작합니다.`);
    });
    child.on('error', (err) => {
      this.ready = false;
      this.log(`whisper-server 실행 실패: ${String(err)}`);
    });
  }

  /** 모델 로딩이 끝나 포트가 열릴 때까지 기다린다. whisper-server 는 별도 health 엔드포인트가 없다. */
  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      if (!this.options.externalUrl && !this.child) throw new SttProviderError('whisper-server 프로세스가 시작되지 못했습니다.', 'STT_CONNECTION_FAILED', false);
      try {
        const res = await fetch(`${this.baseUrl}/`, { method: 'GET', signal: AbortSignal.timeout(2000) });
        // 모델 로드가 끝난 뒤에야 listen 하므로, 응답이 오면 준비된 것이다.
        if (res.status > 0) return;
      } catch (err) {
        lastError = String((err as Error)?.message ?? err);
      }
      await delay(500);
    }
    throw new SttProviderError(`whisper-server 준비 시간 초과 (${this.options.startupTimeoutMs}ms). ${lastError}`, 'STT_CONNECTION_FAILED', false);
  }

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    const run = this.chain.then(
      () => this.doTranscribe(request),
      () => this.doTranscribe(request)
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doTranscribe(request: TranscribeRequest): Promise<TranscribeResult> {
    if (!this.ready) await this.start();

    const wav = pcm16ToWav(request.pcm, request.sampleRate);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'chunk.wav');
    form.append('temperature', '0.0');
    form.append('temperature_inc', '0.2');
    form.append('response_format', 'json');
    form.append('language', request.language || this.options.language);
    form.append('no_timestamps', 'true');
    form.append('suppress_nst', 'true');
    // greedy 디코딩은 짧은 window 에서 한국어를 자주 틀린다. beam search 로 후보를 더 본다.
    if ((this.options.beamSize ?? 0) > 1) form.append('beam_size', String(this.options.beamSize));
    if (request.prompt) {
      form.append('prompt', request.prompt);
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    } catch (err) {
      this.ready = false;
      throw new SttProviderError(`whisper-server 요청 실패: ${String((err as Error)?.message ?? err)}`, 'STT_CONNECTION_FAILED');
    }
    if (res.status === 429) throw new SttProviderError('whisper-server 가 요청을 제한했습니다.', 'STT_RATE_LIMITED');
    if (!res.ok) {
      throw new SttProviderError(`whisper-server 오류 ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const body = (await res.json()) as { text?: string; language?: string; error?: string };
    if (body?.error) throw new SttProviderError(`whisper 오류: ${body.error}`);
    return { text: cleanTranscript(body?.text ?? ''), language: body?.language };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      delay(3000).then(() => false)
    ]);
    if (!exited) child.kill('SIGKILL');
  }
}

/** whisper 출력에서 타임스탬프 잔재와 여분 공백을 제거한다. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/^\s*\[[0-9:.\s\->]+\]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
