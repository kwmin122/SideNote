import { AUDIO_FRAME_SAMPLES, AUDIO_SAMPLE_RATE, config } from '../config';
import type { ErrorCode, STTConnectionStatus, SttEngine, TranscriptSegment } from '../shared/contracts';
import { buildOverlayText, isMeaningfulTranscript } from '../shared/transcripts';
import { db, lastTranscriptSequence } from '../storage/db';
import { createSttProvider, type SttProvider } from '../transcription/provider';

interface RunState {
  sessionId: string;
  stream: MediaStream;
  /** 사용자가 강의 소리를 계속 들을 수 있게 하는 원본 샘플레이트 컨텍스트. */
  playbackContext: AudioContext;
  /** PCM 프레임을 요구하는 제공자용 16kHz 다운샘플 컨텍스트. Chrome 내장 인식기는 쓰지 않는다. */
  sttContext?: AudioContext;
  processor?: ScriptProcessorNode;
  /** Chrome 내장 인식기에 넘기는 사본 트랙. 재생 경로와 서로 영향을 주지 않게 복제한다. */
  recognizerTrack?: MediaStreamTrack;
  provider: SttProvider;
  sequence: number;
  startedAtMs: number;
  /** 오버레이 윗줄로 쓸 직전 확정 자막. 서비스워커는 잠들 수 있어 여기서 들고 있는다. */
  lastFinalText: string;
}

let run: RunState | undefined;
/** 정지 후 꼬리 자막을 기다리는 동안의 세션. persist 가 이 세션 자막을 계속 받아야 한다. */
let finishing: RunState | undefined;
let paused = false;
let starting: Promise<void> | undefined;

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case 'OFFSCREEN_START':
      starting = start(
        message.streamId,
        message.sessionId,
        message.contextPrompt ?? '',
        message.engine === 'chrome' ? 'chrome' : config.defaultSttEngine
      ).catch((err) => {
        report('TAB_CAPTURE_FAILED', String(err?.message ?? err));
      });
      break;
    case 'OFFSCREEN_PAUSE':
      paused = true;
      run?.provider.pause();
      break;
    case 'OFFSCREEN_RESUME':
      paused = false;
      run?.provider.resume();
      break;
    case 'OFFSCREEN_STOP':
      void (starting ?? Promise.resolve()).then(() => stop({ flushTail: true }));
      break;
  }
  return false;
});

function report(errorCode: ErrorCode, message: string) {
  void chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', errorCode, message }).catch(() => {});
}

/** 실패가 아닌 진행 상황. 사이드패널의 알림 줄에 뜬다. */
function notify(message: string) {
  void chrome.runtime.sendMessage({ type: 'OFFSCREEN_NOTICE', message }).catch(() => {});
}

function broadcastSttStatus(stt: STTConnectionStatus, errorCode?: ErrorCode) {
  void chrome.runtime.sendMessage({ type: 'STT_STATUS', stt, errorCode }).catch(() => {});
}

/** 영상 위 오버레이에 그릴 문구를 보낸다. 저장하지 않는 휘발성 메시지다. */
function broadcastCaptionLive(state: RunState, partialText: string) {
  const text = buildOverlayText(state.lastFinalText, partialText);
  void chrome.runtime.sendMessage({ type: 'CAPTION_LIVE', sessionId: state.sessionId, text }).catch(() => {});
}

async function start(streamId: string, sessionId: string, contextPrompt: string, engine: SttEngine) {
  stop();
  paused = false;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as unknown as MediaTrackConstraints,
    video: false
  });

  // 1) 재생 경로: tabCapture 는 원래 탭 소리를 음소거하므로 그대로 스피커로 흘려보낸다.
  const playbackContext = new AudioContext();
  playbackContext.createMediaStreamSource(stream).connect(playbackContext.destination);

  // 2) 인식 경로: 제공자가 무엇을 먹는지에 따라 갈린다(엔진 이름을 여기서 알 필요는 없다).
  //    PCM 계열 = 16kHz mono PCM 프레임을 send() 로 스트리밍
  //    트랙 계열(Chrome 내장) = 오디오 트랙을 그대로 넘김
  const provider = createSttProvider(engine);
  let sttContext: AudioContext | undefined;
  let processor: ScriptProcessorNode | undefined;
  let recognizerTrack: MediaStreamTrack | undefined;

  if (provider.wantsPcmFrames) {
    // 브라우저가 컨텍스트 샘플레이트로 리샘플링해준다.
    sttContext = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
    const sttSource = sttContext.createMediaStreamSource(stream);
    processor = sttContext.createScriptProcessor(AUDIO_FRAME_SAMPLES, 1, 1);
    // ScriptProcessor 는 destination 에 연결돼야 콜백이 돈다. 소리가 두 번 나지 않도록 gain 0 을 거친다.
    const mute = sttContext.createGain();
    mute.gain.value = 0;
    sttSource.connect(processor);
    processor.connect(mute);
    mute.connect(sttContext.destination);
  } else {
    // 인식기가 트랙을 끝내도 재생 경로가 죽지 않도록 사본을 넘긴다.
    recognizerTrack = stream.getAudioTracks()[0]?.clone();
  }

  const state: RunState = {
    sessionId,
    stream,
    playbackContext,
    sttContext,
    processor,
    recognizerTrack,
    provider,
    sequence: await safeLastSequence(sessionId),
    startedAtMs: Date.now(),
    lastFinalText: ''
  };
  run = state;

  if (processor) {
    processor.onaudioprocess = (event) => {
      if (paused || run !== state) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i += 1) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      provider.send(pcm.buffer);
    };
  }

  // STT 연결 실패는 치명적이지 않다. 오디오 패스스루/메모/캡처는 계속 동작한다.
  await provider.connect(
    { sessionId, language: 'auto', contextPrompt, audioTrack: recognizerTrack },
    {
      onTranscript: (result) => void persist(state, result),
      onPartial: (text) => {
        if (run !== state && finishing !== state) return;
        broadcastCaptionLive(state, text);
      },
      onStatus: (status, errorCode) => broadcastSttStatus(status, errorCode),
      onError: (code, message) => report(code, message),
      onNotice: (message) => notify(message)
    }
  );
}

async function safeLastSequence(sessionId: string): Promise<number> {
  try {
    return await lastTranscriptSequence(sessionId);
  } catch {
    return 0;
  }
}

async function persist(state: RunState, result: { text: string; isFinal: boolean; startedAtMs: number; endedAtMs: number }) {
  if (run !== state && finishing !== state) return;
  const text = result.text.trim();
  if (!isMeaningfulTranscript(text)) return;
  if (!result.isFinal && !config.featureFlags.savePartialTranscript) return;

  state.sequence += 1;
  const segment: TranscriptSegment = {
    id: crypto.randomUUID(),
    sessionId: state.sessionId,
    sequence: state.sequence,
    text,
    startedAtMs: result.startedAtMs,
    endedAtMs: result.endedAtMs,
    createdAt: Date.now(),
    status: result.isFinal ? 'FINAL' : 'PARTIAL'
  };

  // 사이드패널이 닫혀 있어도 자막이 남도록 오프스크린이 직접 저장한다.
  try {
    await db.transcripts.put(segment);
  } catch (err) {
    report('STORAGE_WRITE_FAILED', String(err));
  }
  void chrome.runtime.sendMessage({ type: 'TRANSCRIPT', payload: segment }).catch(() => {});
  if (result.isFinal) {
    state.lastFinalText = text;
    broadcastCaptionLive(state, '');
  }
}

function stop(options: { flushTail?: boolean } = {}) {
  const state = run;
  run = undefined;
  paused = false;
  if (!state) return;
  if (state.processor) {
    state.processor.onaudioprocess = null;
    try {
      state.processor.disconnect();
    } catch {
      /* 이미 해제됨 */
    }
  }
  state.stream.getTracks().forEach((track) => track.stop());
  void state.playbackContext.close().catch(() => {});
  void state.sttContext?.close().catch(() => {});
  if (options.flushTail) {
    // 마지막 window 에 못 채운 오디오도 자막으로 남긴다.
    finishing = state;
    void state.provider
      .endSession()
      .catch(() => {})
      .finally(() => {
        if (finishing === state) finishing = undefined;
        state.provider.close();
        state.recognizerTrack?.stop();
        broadcastSttStatus('DISCONNECTED');
      });
    return;
  }
  state.provider.close();
  state.recognizerTrack?.stop();
  broadcastSttStatus('DISCONNECTED');
}
