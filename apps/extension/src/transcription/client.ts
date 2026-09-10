import { config } from '../config';

/** 로컬 STT 게이트웨이 기본 주소. 이 파일을 쓰는 빌드에서만 의미가 있다. */
const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:8787/v1/transcription';
import type { ErrorCode, STTConnectionStatus } from '../shared/contracts';
import type { SttProvider, SttSession } from './provider';

/** 서버가 보내는 자막 1건 (명세 §14). sequence 는 커넥션 단위이므로 호출측이 재부여한다. */
export interface ProviderTranscript {
  text: string;
  sequence: number;
  isFinal: boolean;
  startedAtMs: number;
  endedAtMs: number;
}

export interface SttClientHandlers {
  onTranscript: (result: ProviderTranscript) => void;
  /** 확정 전 진행 중인 자막. 저장하지 않고 영상 위 오버레이에만 쓴다. */
  onPartial?: (text: string) => void;
  onStatus: (status: STTConnectionStatus, errorCode?: ErrorCode) => void;
  onError?: (code: ErrorCode, message: string) => void;
  /** 실패가 아닌 진행 상황(예: 언어팩 다운로드). 오류 배너가 아니라 알림 줄로 나간다. */
  onNotice?: (message: string) => void;
}

export interface SttClientOptions {
  url?: string;
  backoffMs?: number[];
  maxBufferedFrames?: number;
  /** 테스트에서 가짜 소켓을 주입하기 위한 팩토리. */
  socketFactory?: (url: string) => WebSocket;
  connectTimeoutMs?: number;
}

type Sink = Pick<WebSocket, 'send' | 'close' | 'readyState'> & Partial<WebSocket>;

/**
 * 로컬 STT 게이트웨이와의 WebSocket 세션.
 * - 끊긴 동안 오디오 프레임을 버퍼에 쌓고, 재연결 후 session.init 을 다시 보낸 뒤 flush 한다.
 * - 버퍼 상한을 넘으면 가장 오래된 프레임부터 버린다(무한 증가 방지).
 */
export class StreamingSTTClient implements SttProvider {
  private ws?: Sink;
  readonly wantsPcmFrames = true;
  private handlers?: SttClientHandlers;
  private readonly url: string;
  private readonly backoff: number[];
  private readonly maxBufferedFrames: number;
  private readonly connectTimeoutMs: number;
  private readonly socketFactory: (url: string) => WebSocket;

  private buffer: ArrayBuffer[] = [];
  private attempt = 0;
  private closedByUser = false;
  private status: STTConnectionStatus = 'DISCONNECTED';
  private sessionId = '';
  private language = 'auto';
  private contextPrompt = '';
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private endResolve?: () => void;

  droppedFrames = 0;

  constructor(options: SttClientOptions = {}) {
    this.url = options.url ?? DEFAULT_GATEWAY_URL;
    this.backoff = options.backoffMs ?? config.sttReconnectBackoffMs;
    this.maxBufferedFrames = options.maxBufferedFrames ?? config.maxBufferedFrames;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
  }

  getStatus(): STTConnectionStatus {
    return this.status;
  }

  bufferedFrames(): number {
    return this.buffer.length;
  }

  isOpen(): boolean {
    return this.ws?.readyState === 1;
  }

  /** 연결 실패해도 예외를 던지지 않는다. 자막만 실패하고 메모/캡처는 계속 동작해야 한다. */
  async connect(session: SttSession, handlers: SttClientHandlers): Promise<boolean> {
    this.handlers = handlers;
    this.sessionId = session.sessionId;
    this.language = session.language ?? 'auto';
    this.contextPrompt = session.contextPrompt ?? '';
    this.closedByUser = false;
    this.attempt = 0;
    return this.open();
  }

  private setStatus(next: STTConnectionStatus, errorCode?: ErrorCode) {
    if (this.status === next && !errorCode) return;
    this.status = next;
    this.handlers?.onStatus(next, errorCode);
  }

  private async open(): Promise<boolean> {
    this.setStatus(this.attempt === 0 ? 'CONNECTING' : 'RECONNECTING');
    let socket: WebSocket;
    try {
      socket = this.socketFactory(this.url);
    } catch (err) {
      this.handlers?.onError?.('STT_CONNECTION_FAILED', String(err));
      this.scheduleReconnect();
      return false;
    }
    socket.binaryType = 'arraybuffer';
    this.ws = socket;

    const connected = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        this.handlers?.onError?.('STT_CONNECTION_FAILED', 'STT 서버 연결 시간 초과');
        done(false);
      }, this.connectTimeoutMs);

      socket.onopen = () => {
        this.attempt = 0;
        this.sendJson({ type: 'session.init', sessionId: this.sessionId, language: this.language, prompt: this.contextPrompt });
        done(true);
      };
      socket.onmessage = (event) => this.handleMessage(event);
      socket.onerror = () => {
        this.handlers?.onError?.('STT_CONNECTION_FAILED', 'STT 서버에 연결할 수 없습니다 (127.0.0.1:8787).');
        done(false);
      };
      socket.onclose = () => {
        done(false);
        if (this.ws === socket) this.ws = undefined;
        if (!this.closedByUser) this.scheduleReconnect();
      };
    });

    if (!connected && !this.closedByUser && this.ws) this.scheduleReconnect();
    return connected;
  }

  private handleMessage(event: MessageEvent) {
    let msg: any;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (msg?.type === 'session.ready') {
      this.setStatus('CONNECTED');
      this.flush();
      return;
    }
    if (msg?.type === 'session.ended') {
      this.endResolve?.();
      return;
    }
    if (msg?.type === 'transcript.partial') {
      const payload = msg.payload ?? msg;
      if (typeof payload?.text === 'string') this.handlers?.onPartial?.(payload.text);
      return;
    }
    if (msg?.type === 'transcript') {
      const payload = msg.payload ?? msg;
      if (typeof payload?.text === 'string') {
        this.handlers?.onTranscript({
          text: payload.text,
          sequence: Number(payload.sequence ?? 0),
          isFinal: payload.isFinal !== false,
          startedAtMs: Number(payload.startedAtMs ?? 0),
          endedAtMs: Number(payload.endedAtMs ?? 0)
        });
      }
      return;
    }
    if (msg?.type === 'error') {
      const code: ErrorCode = msg.code ?? 'STT_PROVIDER_FAILED';
      this.handlers?.onError?.(code, String(msg.message ?? ''));
    }
  }

  private scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    if (this.attempt >= this.backoff.length) {
      this.setStatus('FAILED', 'STT_CONNECTION_FAILED');
      return;
    }
    const delay = this.backoff[this.attempt];
    this.attempt += 1;
    this.setStatus('RECONNECTING');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closedByUser) void this.open();
    }, delay);
  }

  /**
   * 일시정지/재개. 이 경로는 오프스크린이 프레임 전송 자체를 멈추므로 여기서 할 일이 없다.
   * (트랙을 직접 먹는 Chrome 제공자는 인식기를 stop/start 해야 해서 인터페이스에 남겨둔다.)
   */
  pause(): void {
    /* no-op: 프레임이 안 오면 서버도 새 window 를 만들지 않는다. */
  }

  resume(): void {
    /* no-op */
  }

  /** 연결돼 있으면 즉시 전송, 아니면 버퍼에 쌓는다. */
  send(frame: ArrayBuffer) {
    if (this.isOpen() && this.status === 'CONNECTED' && this.buffer.length === 0) {
      this.ws!.send(frame);
      return;
    }
    this.buffer.push(frame);
    while (this.buffer.length > this.maxBufferedFrames) {
      this.buffer.shift();
      this.droppedFrames += 1;
    }
    if (this.isOpen() && this.status === 'CONNECTED') this.flush();
  }

  private flush() {
    if (!this.isOpen()) return;
    const pending = this.buffer;
    this.buffer = [];
    for (const frame of pending) this.ws!.send(frame);
  }

  sendJson(value: unknown) {
    if (this.isOpen()) this.ws!.send(JSON.stringify(value));
  }

  /**
   * 정지 시 서버에 남은 꼬리 오디오를 인식하라고 요청하고 마지막 자막을 기다린다.
   * 응답이 없어도 graceMs 후에는 반환하므로 정지가 막히지 않는다.
   */
  endSession(graceMs = 2500): Promise<void> {
    if (!this.isOpen()) return Promise.resolve();
    this.flush();
    this.sendJson({ type: 'session.end', sessionId: this.sessionId });
    return new Promise<void>((resolve) => {
      const timer = setTimeout(finish, graceMs);
      function finish() {
        clearTimeout(timer);
        resolve();
      }
      this.endResolve = finish;
    }).finally(() => {
      this.endResolve = undefined;
    });
  }

  close() {
    this.closedByUser = true;
    this.endResolve?.();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.buffer = [];
    try {
      this.ws?.close();
    } catch {
      /* 이미 닫힘 */
    }
    this.ws = undefined;
    this.setStatus('DISCONNECTED');
  }
}
