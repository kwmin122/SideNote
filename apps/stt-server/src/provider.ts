/**
 * STT 제공자 어댑터.
 * 나중에 다른 엔진(클라우드 API 등)으로 갈아끼울 때 이 인터페이스만 구현하면 된다.
 * 게이트웨이 코드는 whisper 를 직접 알지 않는다.
 */
export interface TranscribeRequest {
  /** 16-bit LE mono PCM. */
  pcm: Buffer;
  sampleRate: number;
  language: string;
  /** 강의 제목 등 인식 정확도를 높이는 문맥. */
  prompt?: string;
}

export interface TranscribeResult {
  text: string;
  language?: string;
}

export interface SpeechToTextProvider {
  readonly name: string;
  /** 모델을 메모리에 올린다. 여러 번 호출해도 한 번만 수행한다. */
  start(): Promise<void>;
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
  stop(): Promise<void>;
  isReady(): boolean;
  describe(): Record<string, unknown>;
}

export class SttProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'STT_PROVIDER_FAILED' | 'STT_CONNECTION_FAILED' | 'STT_RATE_LIMITED' = 'STT_PROVIDER_FAILED',
    readonly retryable = true
  ) {
    super(message);
    this.name = 'SttProviderError';
  }
}
