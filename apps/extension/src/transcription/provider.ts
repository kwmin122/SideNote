import type { SttEngine } from '../shared/contracts';
import { ChromeSpeechProvider } from './chrome-speech';
import type { SttClientHandlers } from './client';

/** 세션 1건의 인식 요청. 제공자에 따라 필요한 필드만 읽는다. */
export interface SttSession {
  sessionId: string;
  language?: string;
  contextPrompt?: string;
  /** Chrome 내장 인식기는 PCM 프레임 대신 오디오 트랙 자체를 받는다. PCM 계열 제공자는 이 값을 무시한다. */
  audioTrack?: MediaStreamTrack;
}

/**
 * STT 제공자 인터페이스 (명세 §14: 제공자 교체 가능해야 한다).
 * 지금 배포판이 쓰는 제공자는 ChromeSpeechProvider(브라우저 내장 on-device 인식) 하나뿐이다.
 * 오프스크린은 제공자 이름을 모르고 이 인터페이스만 보고 동작하므로, 다른 인식기로 갈아끼울 때 오프스크린은 그대로 둔다.
 */
export interface SttProvider {
  /**
   * true 면 오프스크린이 16kHz mono PCM16 프레임을 만들어 send() 로 흘려보낸다.
   * 오디오 트랙을 직접 먹는 제공자(Chrome 내장)는 이 값을 켜지 않아 다운샘플 그래프 자체를 만들지 않는다.
   */
  readonly wantsPcmFrames?: boolean;
  /** 실패해도 예외를 던지지 않는다. 자막만 실패하고 메모/캡처는 계속 동작해야 한다. */
  connect(session: SttSession, handlers: SttClientHandlers): Promise<boolean>;
  /** 16kHz mono PCM16 프레임. 트랙을 직접 먹는 제공자는 아무것도 하지 않는다. */
  send(frame: ArrayBuffer): void;
  pause(): void;
  resume(): void;
  /** 정지 직전 남은 오디오의 마지막 자막을 기다린다. */
  endSession(graceMs?: number): Promise<void>;
  close(): void;
}

/** 오프스크린이 엔진 이름만 알고 제공자를 만들 수 있게 하는 유일한 진입점. */
export function createSttProvider(engine: SttEngine): SttProvider {
  switch (engine) {
    case 'chrome':
    default:
      return new ChromeSpeechProvider();
  }
}
