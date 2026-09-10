import { config } from '../config';
import type { ErrorCode, STTConnectionStatus } from '../shared/contracts';
import type { SttClientHandlers } from './client';
import type { SttProvider, SttSession } from './provider';

/**
 * Chrome 내장 on-device 음성 인식(Web Speech API) 제공자.
 *
 * 핵심 원칙: processLocally 를 보장할 수 없으면 아예 시작하지 않는다.
 * Web Speech API 는 기본값(processLocally=false)에서 오디오를 구글 서버로 보내므로,
 * 로컬 처리를 확인하지 못한 상태에서 인식기를 켜면 이 프로젝트의 전제(로컬 전용)가 깨진다.
 */

/** TS 5.9 lib.dom 에는 processLocally / available / install / start(track) 가 없어 최소한만 직접 선언한다. */
interface SpeechAlternativeLike {
  transcript: string;
}
interface SpeechResultLike {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechAlternativeLike;
}
interface SpeechResultListLike {
  readonly length: number;
  [index: number]: SpeechResultLike;
}
interface SpeechResultEventLike {
  resultIndex: number;
  results: SpeechResultListLike;
}
interface SpeechErrorEventLike {
  error: string;
  message?: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  start(audioTrack?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: SpeechErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type AvailabilityQuery = { langs: string[]; processLocally?: boolean };
type SpeechRecognitionCtor = (new () => SpeechRecognitionLike) & {
  available?: (query: AvailabilityQuery) => Promise<string>;
  install?: (query: AvailabilityQuery) => Promise<boolean>;
};

export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  const scope = globalThis as unknown as Record<string, unknown>;
  return (scope.SpeechRecognition ?? scope.webkitSpeechRecognition) as SpeechRecognitionCtor | undefined;
}

/** offscreen 문서에서 Web Speech API 가 없을 때 사용자에게 그대로 보여줄 문구. */
export const CHROME_STT_UNSUPPORTED =
  '이 컨텍스트에서 Chrome 내장 음성인식을 쓸 수 없습니다 (offscreen 미지원).';
export const CHROME_STT_NOT_LOCAL =
  '이 Chrome 은 기기 내 음성인식(processLocally)을 지원하지 않습니다. 오디오를 밖으로 내보내지 않기 위해 자막을 시작하지 않았습니다. Chrome 을 최신 버전(139 이상)으로 업데이트해 주세요. 메모와 캡처는 그대로 쓸 수 있습니다.';

/**
 * 언어팩 설치를 "사용자 클릭 안에서" 시작한다.
 *
 * Chrome 은 availability 가 'downloadable' 일 때 install() 에 사용자 제스처를 요구한다
 * (NotAllowedError: Requires handling a user gesture). offscreen 문서에는 제스처가 없으므로
 * 설치 시작은 사이드패널의 클릭 핸들러가 맡는다. 반드시 첫 await 보다 먼저,
 * 동기적으로 호출해야 클릭의 일시적 활성화(transient activation)가 살아 있다.
 *
 * 실패해도 던지지 않는다. 언어팩이 이미 있으면 자막은 그대로 시작돼야 하기 때문이다.
 */
export function requestLanguagePack(lang: string): Promise<boolean> {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor || typeof Ctor.install !== 'function') return Promise.resolve(false);
  try {
    return Promise.resolve(Ctor.install({ langs: [lang], processLocally: true })).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/** 재시작이 무한 루프가 되지 않도록 하는 상한. */
const MAX_RESTARTS = 20;

/** 언어팩 다운로드를 기다릴 때 쓰는 값. 테스트에서만 바꾼다. */
export interface ChromeSpeechOptions {
  /** available() 을 다시 물어보는 간격. */
  packPollMs?: number;
  /** 언어팩 다운로드를 기다리는 상한. 수백 MB 라 넉넉히 잡는다. */
  packTimeoutMs?: number;
  /** 'downloadable' 이 'downloading' 으로 바뀌기를 기다리는 상한. 안 바뀌면 기다려도 소용없다. */
  packStartTimeoutMs?: number;
}

export class ChromeSpeechProvider implements SttProvider {
  private readonly packPollMs: number;
  private readonly packTimeoutMs: number;
  private readonly packStartTimeoutMs: number;
  private recognition?: SpeechRecognitionLike;
  private handlers?: SttClientHandlers;
  private track?: MediaStreamTrack;
  private status: STTConnectionStatus = 'DISCONNECTED';
  private closedByUser = false;
  private paused = false;
  private running = false;
  private restarts = 0;
  private sequence = 0;
  private startedAtMs = 0;
  private utteranceStartMs?: number;
  private lastFinalText = '';
  private endResolve?: () => void;
  /** 언어팩을 기다린다고 알렸는지. 알렸다면 준비됐을 때도 알려줘야 한다. */
  private waitedForPack = false;

  constructor(options: ChromeSpeechOptions = {}) {
    this.packPollMs = options.packPollMs ?? 3000;
    this.packTimeoutMs = options.packTimeoutMs ?? 15 * 60 * 1000;
    this.packStartTimeoutMs = options.packStartTimeoutMs ?? 20_000;
  }

  getStatus(): STTConnectionStatus {
    return this.status;
  }

  private setStatus(next: STTConnectionStatus, errorCode?: ErrorCode) {
    if (this.status === next && !errorCode) return;
    this.status = next;
    this.handlers?.onStatus(next, errorCode);
  }

  private fail(code: ErrorCode, message: string): false {
    this.handlers?.onError?.(code, message);
    this.setStatus('FAILED', code);
    return false;
  }

  /** 실패가 아닌 진행 상황. 오류 배너가 아니라 알림 줄로 나가야 한다. */
  private notice(message: string) {
    this.handlers?.onNotice?.(message);
  }

  async connect(session: SttSession, handlers: SttClientHandlers): Promise<boolean> {
    this.handlers = handlers;
    this.closedByUser = false;
    this.paused = false;
    this.restarts = 0;
    this.sequence = 0;
    this.startedAtMs = Date.now();
    this.utteranceStartMs = undefined;
    this.lastFinalText = '';
    this.waitedForPack = false;
    this.setStatus('CONNECTING');

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return this.fail('STT_PROVIDER_FAILED', CHROME_STT_UNSUPPORTED);
    // on-device 여부를 확인할 수 없으면 클라우드로 나갈 수 있으므로 시작하지 않는다.
    if (typeof Ctor.available !== 'function') return this.fail('STT_PROVIDER_FAILED', CHROME_STT_NOT_LOCAL);

    const lang = session.language && session.language !== 'auto' ? session.language : config.chromeSpeechLang;
    const query: AvailabilityQuery = { langs: [lang], processLocally: true };

    let availability: string;
    try {
      availability = await Ctor.available(query);
    } catch (err) {
      return this.fail('STT_PROVIDER_FAILED', `음성 인식 사용 가능 여부를 확인하지 못했습니다: ${String(err)}`);
    }
    if (availability === 'unavailable') {
      return this.fail('STT_PROVIDER_FAILED', `이 기기에서 ${lang} 기기 내 음성인식을 쓸 수 없습니다. Chrome 설정 → 언어에서 해당 언어를 추가한 뒤 다시 시도해 주세요. 메모와 캡처는 그대로 쓸 수 있습니다.`);
    }
    if (availability !== 'available') {
      // 첫 실행에는 언어팩(수백 MB)을 내려받아야 한다. 이건 실패가 아니라 진행 상황이므로
      // 오류로 알리지 않고, 다 받을 때까지 여기서 기다렸다가 자막을 자동으로 시작한다.
      if (!(await this.ensureLanguagePack(Ctor, query, lang))) return false;
    }
    if (this.closedByUser) return false;
    if (this.waitedForPack) this.notice(`${lang} 음성 인식 언어팩이 준비됐습니다. 자막을 시작합니다.`);

    const track = session.audioTrack;
    if (!track || track.kind !== 'audio' || track.readyState !== 'live') {
      return this.fail('TAB_CAPTURE_FAILED', '인식에 쓸 오디오 트랙이 없습니다.');
    }
    this.track = track;

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Ctor();
    } catch (err) {
      return this.fail('STT_PROVIDER_FAILED', `음성 인식기를 만들지 못했습니다: ${String(err)}`);
    }
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.processLocally = true;
    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => this.handleError(event);
    recognition.onend = () => this.handleEnd();
    recognition.onstart = () => this.setStatus('CONNECTED');
    this.recognition = recognition;

    // 언어팩을 기다리는 동안 사용자가 일시정지를 눌렀을 수 있다. 그때는 여기서 시작하지 않고
    // resume() 이 시작하게 둔다. 안 그러면 화면은 "일시정지"인데 자막이 계속 쌓인다.
    if (this.paused) {
      this.setStatus('CONNECTED');
      return true;
    }

    if (!this.startRecognition()) {
      return this.fail('STT_PROVIDER_FAILED', '음성 인식을 시작하지 못했습니다.');
    }
    // onstart 를 못 받는 구현도 있으므로 시작 성공 시점에 연결됨으로 본다.
    this.setStatus('CONNECTED');
    return true;
  }

  /**
   * 언어팩이 없을 때의 처리. 여기서는 절대 install() 을 부르지 않는다.
   *
   * install() 은 availability 가 'downloadable' 일 때 사용자 제스처를 요구하는데
   * offscreen 문서에는 제스처가 없어 NotAllowedError 로 죽는다. 그래서 설치 시작은
   * 사이드패널의 클릭 핸들러(requestLanguagePack)가 맡고, 여기서는 상태만 지켜본다.
   */
  private async ensureLanguagePack(Ctor: SpeechRecognitionCtor, query: AvailabilityQuery, lang: string): Promise<boolean> {
    this.waitedForPack = true;
    this.notice(`${lang} 음성 인식 언어팩을 내려받는 중입니다 (첫 실행에만, 수백 MB). 다 받으면 자막이 자동으로 시작됩니다.`);
    return this.waitForPack(Ctor, query, lang);
  }

  /** available() 이 'available' 이 될 때까지 기다린다. 사용자가 멈추면 즉시 빠져나온다. */
  private async waitForPack(Ctor: SpeechRecognitionCtor, query: AvailabilityQuery, lang: string): Promise<boolean> {
    const deadline = Date.now() + this.packTimeoutMs;
    // 'downloadable' 은 "아직 아무도 안 받고 있다" 는 뜻이다. 클릭 쪽 install() 이 붙었다면
    // 곧 'downloading' 으로 바뀐다. 안 바뀌면 오래 기다려도 소용없으므로 짧게 끊고 다시 누르라고 한다.
    const startDeadline = Date.now() + this.packStartTimeoutMs;
    for (;;) {
      if (this.closedByUser) return false;
      let state: string;
      try {
        state = await Ctor.available!(query);
      } catch {
        state = 'unavailable';
      }
      if (state === 'available') return true;
      if (state === 'unavailable') {
        return this.fail('STT_PROVIDER_FAILED', `${lang} 언어팩을 쓸 수 없습니다. Chrome 설정 → 언어에서 해당 언어를 추가한 뒤 다시 시도해 주세요.`);
      }
      if (state === 'downloadable' && Date.now() >= startDeadline) {
        return this.fail(
          'STT_PROVIDER_FAILED',
          `${lang} 언어팩 다운로드가 시작되지 않았습니다. [자막 시작] 을 한 번 더 눌러 주세요.`
        );
      }
      if (Date.now() >= deadline) {
        return this.fail('STT_PROVIDER_FAILED', `${lang} 언어팩 다운로드가 끝나지 않았습니다. 다 받은 뒤 다시 시작해 주세요.`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.packPollMs));
    }
  }

  private startRecognition(): boolean {
    if (!this.recognition || !this.track) return false;
    if (this.track.readyState !== 'live') return false;
    try {
      this.recognition.start(this.track);
      this.running = true;
      return true;
    } catch {
      this.running = false;
      return false;
    }
  }

  private elapsed(): number {
    return Date.now() - this.startedAtMs;
  }

  private handleResult(event: SpeechResultEventLike) {
    if (this.closedByUser) return;
    // 결과가 나왔다면 정상 동작 중이다. 상한은 "연속 실패"에만 걸어야 한다.
    // (continuous 여도 Chrome 은 문장/무음마다 세션을 끝내므로 누적 카운터로 두면 긴 강의 중간에 멈춘다.)
    this.restarts = 0;
    const results = event.results;
    const from = Number(event.resultIndex ?? 0);
    let interim = '';
    for (let i = from; i < results.length; i += 1) {
      const result = results[i];
      if (!result) continue;
      const text = String(result[0]?.transcript ?? '');
      if (result.isFinal) {
        this.emitFinal(text);
      } else {
        this.utteranceStartMs ??= this.elapsed();
        interim += text;
      }
    }
    if (interim.trim()) this.handlers?.onPartial?.(interim.trim());
  }

  private emitFinal(raw: string) {
    const text = raw.trim();
    const endedAtMs = this.elapsed();
    const startedAtMs = this.utteranceStartMs ?? endedAtMs;
    this.utteranceStartMs = undefined;
    if (!text) return;
    // 재시작 직후 같은 문장이 다시 확정되는 경우를 막는다(overlap dedup 과 같은 목적).
    if (text === this.lastFinalText) return;
    this.lastFinalText = text;
    this.sequence += 1;
    this.handlers?.onTranscript({
      text,
      sequence: this.sequence,
      isFinal: true,
      startedAtMs,
      endedAtMs
    });
    this.endResolve?.();
  }

  private handleError(event: SpeechErrorEventLike) {
    const kind = String(event?.error ?? '');
    // 말이 없거나 우리가 stop() 한 경우는 정상 흐름이다. onend 에서 재시작한다.
    if (kind === 'no-speech' || kind === 'aborted') return;
    if (kind === 'language-not-supported' || kind === 'service-not-allowed' || kind === 'not-allowed') {
      this.closedByUser = true;
      this.fail('STT_PROVIDER_FAILED', `음성 인식을 사용할 수 없습니다 (${kind}). 메모와 캡처는 그대로 쓸 수 있습니다.`);
      return;
    }
    if (kind === 'network') {
      this.handlers?.onError?.('STT_CONNECTION_FAILED', '음성 인식이 네트워크를 요구했습니다. on-device 인식이 아닐 수 있습니다.');
      return;
    }
    this.handlers?.onError?.('STT_PROVIDER_FAILED', `음성 인식 오류: ${kind}${event?.message ? ` (${event.message})` : ''}`);
  }

  /** continuous 여도 Chrome 은 무음 구간에서 세션을 끝낸다. 사용자가 멈춘 게 아니면 다시 켠다. */
  private handleEnd() {
    this.running = false;
    if (this.closedByUser || this.paused) return;
    if (!this.track || this.track.readyState !== 'live') return;
    if (this.restarts >= MAX_RESTARTS) {
      this.setStatus('FAILED', 'STT_PROVIDER_FAILED');
      this.handlers?.onError?.('STT_PROVIDER_FAILED', '음성 인식이 반복해서 끊겨 중단했습니다. [자막 시작] 을 다시 눌러 주세요.');
      return;
    }
    this.restarts += 1;
    if (!this.startRecognition()) {
      // start() 가 던지면 다음 onend 도 오지 않는다. 여기서 끝내지 않으면 영원히 "재연결 중"이 된다.
      this.setStatus('FAILED', 'STT_PROVIDER_FAILED');
      this.handlers?.onError?.('STT_PROVIDER_FAILED', '음성 인식을 다시 시작하지 못했습니다. [자막 시작] 을 다시 눌러 주세요.');
    }
  }

  /** 트랙을 직접 먹으므로 PCM 프레임은 쓰지 않는다. */
  send(_frame: ArrayBuffer): void {
    /* no-op */
  }

  pause(): void {
    this.paused = true;
    if (!this.running) return;
    try {
      this.recognition?.stop();
    } catch {
      /* 이미 멈춤 */
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.restarts = 0;
    if (this.running) return;
    if (this.startRecognition()) this.setStatus('CONNECTED');
  }

  /** stop() 이후 확정되는 마지막 문장을 잠깐 기다린다. */
  endSession(graceMs = 1500): Promise<void> {
    if (!this.recognition || !this.running) return Promise.resolve();
    this.paused = true; // onend 에서 재시작하지 않도록 한다.
    try {
      this.recognition.stop();
    } catch {
      /* 이미 멈춤 */
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(finish, graceMs);
      const self = this;
      function finish() {
        clearTimeout(timer);
        self.endResolve = undefined;
        resolve();
      }
      this.endResolve = finish;
    });
  }

  close(): void {
    this.closedByUser = true;
    this.endResolve?.();
    this.endResolve = undefined;
    const recognition = this.recognition;
    this.recognition = undefined;
    this.running = false;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      try {
        recognition.abort();
      } catch {
        /* 이미 멈춤 */
      }
    }
    this.track = undefined;
    this.setStatus('DISCONNECTED');
  }
}
