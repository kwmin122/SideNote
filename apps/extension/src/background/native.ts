/**
 * Native Messaging 동반 앱(apps/native-host)과의 연결.
 *
 * 확장이 포트를 열면 Chrome 이 네이티브 프로세스를 대신 띄우고, 포트를 닫으면 죽인다.
 * 그 프로세스가 하는 일은 로컬 STT 게이트웨이(ws://127.0.0.1:8787)를 띄우고 같이 죽는 것뿐이라,
 * 오디오 경로(StreamingSTTClient)는 그대로 두고 "서버를 손으로 켜는 일"만 없앤다.
 */

// 문구는 engine-dist 가 만든다. 이 빌드에 설치 버튼이 있는지에 따라 말이 달라져야 하기 때문이다.
import { engineMissingMessage } from '../shared/engine-dist';

export const NATIVE_HOST_NAME = 'com.study.whisper';

export const NATIVE_HOST_SLOW = 'STT 서버가 아직 응답하지 않습니다. 자막이 늦게 붙을 수 있습니다.';

interface NativeEvent<T> {
  addListener(callback: T): void;
}

export interface NativePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: NativeEvent<(message: any) => void>;
  onDisconnect: NativeEvent<() => void>;
}

export interface WhisperHostResult {
  ok: boolean;
  /** 호스트가 서버를 새로 띄웠는지(false = 이미 떠 있는 서버에 붙었다). */
  spawned?: boolean;
  message?: string;
}

/** "엔진이 깔려 있는가" 만 보는 가벼운 확인 결과. 서버를 띄우지 않는다. */
export interface WhisperHostProbe {
  installed: boolean;
  /** missing = 등록된 호스트가 없음, slow = 등록은 돼 있는데 제때 대답하지 않음. 안내 문구가 달라진다. */
  reason?: 'missing' | 'slow';
  message?: string;
}

export interface WhisperHostOptions {
  connect?: () => NativePortLike | undefined;
  readyTimeoutMs?: number;
}

function lastErrorMessage(): string {
  try {
    return String((globalThis as any).chrome?.runtime?.lastError?.message ?? '');
  } catch {
    return '';
  }
}

export class WhisperHost {
  private port?: NativePortLike;
  private pending?: Promise<WhisperHostResult>;
  private ready?: WhisperHostResult;
  private readonly connectPort: () => NativePortLike | undefined;
  private readonly readyTimeoutMs: number;

  constructor(options: WhisperHostOptions = {}) {
    this.connectPort =
      options.connect ?? (() => chrome.runtime.connectNative(NATIVE_HOST_NAME) as unknown as NativePortLike);
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15000;
  }

  isConnected(): boolean {
    return this.port !== undefined;
  }

  /**
   * 서버가 뜰 때까지 기다린다. 실패해도 예외를 던지지 않는다.
   * 사용자가 서버를 직접 띄워 둔 경우에도 자막이 붙어야 하므로, 호출측은 결과와 무관하게 계속 진행한다.
   */
  ensure(): Promise<WhisperHostResult> {
    if (this.port && this.ready?.ok) return Promise.resolve(this.ready);
    if (this.pending) return this.pending;
    this.pending = this.open().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /**
   * 고정확도 엔진(네이티브 동반 앱)이 설치돼 있는지만 확인한다.
   *
   * 호스트는 실행되자마자 status 를 보내고 나서 게이트웨이를 띄우므로, 첫 메시지 한 줄만 받고 바로 끊는다.
   * 끊기면 호스트는 스스로 종료한다. 설치돼 있지 않으면 Chrome 이 곧바로 포트를 끊는다 = 그게 "없음" 신호다.
   */
  probe(timeoutMs = 5000): Promise<WhisperHostProbe> {
    if (this.port && this.ready?.ok) return Promise.resolve({ installed: true });
    if (this.pending) {
      return this.pending.then((result) => ({
        installed: result.ok,
        reason: result.ok ? undefined : ('missing' as const),
        message: result.message,
      }));
    }

    let port: NativePortLike | undefined;
    try {
      port = this.connectPort();
    } catch (err) {
      return Promise.resolve({
        installed: false,
        reason: 'missing',
        message: `${engineMissingMessage()} (${String((err as Error)?.message ?? err)})`,
      });
    }
    if (!port) return Promise.resolve({ installed: false, reason: 'missing', message: engineMissingMessage() });

    const opened = port;
    return new Promise<WhisperHostProbe>((resolve) => {
      let settled = false;
      const finish = (result: WhisperHostProbe) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 확인용 포트다. 세션용 포트(this.port)와 섞이면 안 되므로 여기서만 닫는다.
        try {
          opened.disconnect();
        } catch {
          /* 이미 끊김 */
        }
        resolve(result);
      };
      const timer = setTimeout(() => finish({ installed: false, reason: 'slow', message: NATIVE_HOST_SLOW }), timeoutMs);
      opened.onMessage.addListener(() => finish({ installed: true }));
      opened.onDisconnect.addListener(() => {
        const detail = lastErrorMessage();
        finish({
          installed: false,
          reason: 'missing',
          message: detail ? `${engineMissingMessage()} (${detail})` : engineMissingMessage(),
        });
      });
    });
  }

  private open(): Promise<WhisperHostResult> {
    let port: NativePortLike | undefined;
    try {
      port = this.connectPort();
    } catch (err) {
      return Promise.resolve({ ok: false, message: `${engineMissingMessage()} (${String((err as Error)?.message ?? err)})` });
    }
    if (!port) return Promise.resolve({ ok: false, message: engineMissingMessage() });
    this.port = port;

    const opened = port;
    return new Promise<WhisperHostResult>((resolve) => {
      let settled = false;
      const finish = (result: WhisperHostResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ready = result.ok ? result : undefined;
        if (!result.ok) this.dropPort(opened);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, message: NATIVE_HOST_SLOW }), this.readyTimeoutMs);

      opened.onMessage.addListener((message: any) => {
        // heartbeat 는 서비스워커의 30초 유휴 타이머를 되돌리는 것 자체가 목적이라 따로 할 일이 없다.
        if (message?.type === 'ready') finish({ ok: true, spawned: message.spawned === true });
        else if (message?.type === 'error') {
          finish({ ok: false, message: String(message.message ?? 'STT 서버를 띄우지 못했습니다.') });
        }
      });
      opened.onDisconnect.addListener(() => {
        // 호스트가 등록돼 있지 않으면 Chrome 이 곧바로 끊는다. 그게 "설치 안 됨" 신호다.
        const detail = lastErrorMessage();
        if (this.port === opened) this.port = undefined;
        this.ready = undefined;
        finish({ ok: false, message: detail ? `${engineMissingMessage()} (${detail})` : engineMissingMessage() });
      });
    });
  }

  private dropPort(port: NativePortLike) {
    if (this.port === port) this.port = undefined;
    try {
      port.disconnect();
    } catch {
      /* 이미 끊김 */
    }
  }

  /** 포트를 닫으면 Chrome 이 네이티브 프로세스를 죽이고, 그 프로세스가 게이트웨이를 정리한다. */
  release(): void {
    const port = this.port;
    this.port = undefined;
    this.ready = undefined;
    if (!port) return;
    try {
      port.disconnect();
    } catch {
      /* 이미 끊김 */
    }
  }
}

/** 서비스워커 전역 인스턴스. 워커가 죽으면 포트도 닫히고 서버도 함께 정리된다. */
export const whisperHost = new WhisperHost();
