import type { SttEngine } from '../shared/contracts';

/** 명세 §22 AppConfig. 값은 전부 이 파일에서만 바꾼다. */
export interface AppConfig {
  /** ScriptProcessor 버퍼(2048 @16kHz) 기준 실제 프레임 길이 ≈128ms. */
  audioFrameDurationMs: number;
  /** 16kHz mono PCM16 기준 1프레임 = 4096 bytes. 80프레임 ≈ 10초 버퍼. */
  maxBufferedFrames: number;
  memoSaveDebounceMs: number;
  sttReconnectBackoffMs: number[];
  maxTranscriptSegmentsInMemory: number;
  /** 한 번에 DOM 에 렌더링할 자막 수. 1000개 이상에서도 멈추지 않게 한다. */
  transcriptRenderWindow: number;
  /** 자막 리스트가 하단에서 이 픽셀 이내이면 자동 스크롤을 유지한다. */
  autoScrollThresholdPx: number;
  /** 사용자가 고른 값이 없을 때 쓰는 자막 엔진. */
  defaultSttEngine: SttEngine;
  /**
   * 사이드패널에서 고른 자막 언어가 전달되지 않았을 때 쓰는 최후의 기본값.
   * 평소에는 shared/languages.ts 의 목록에서 고른 값이 여기까지 오지 않는다.
   */
  chromeSpeechLang: string;
  featureFlags: {
    cropVideoRegion: boolean;
    savePartialTranscript: boolean;
    transcriptEnhancer: boolean;
  };
}

export const config: AppConfig = {
  audioFrameDurationMs: 128,
  maxBufferedFrames: 80,
  memoSaveDebounceMs: 600,
  sttReconnectBackoffMs: [1000, 2000, 5000],
  maxTranscriptSegmentsInMemory: 2000,
  transcriptRenderWindow: 300,
  autoScrollThresholdPx: 48,
  defaultSttEngine: 'chrome',
  chromeSpeechLang: 'en-US',
  featureFlags: {
    cropVideoRegion: true,
    savePartialTranscript: false,
    transcriptEnhancer: false
  }
};

/** PCM 프레임을 요구하는 인식기(SttProvider.wantsPcmFrames)에 넘길 오디오 스펙. 16kHz mono. */
export const AUDIO_SAMPLE_RATE = 16000;
export const AUDIO_FRAME_SAMPLES = 2048;

