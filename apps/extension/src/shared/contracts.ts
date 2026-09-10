// 명세 §7 상태 / §8 데이터 모델 / §14 STT 프로토콜 / §15 에러 코드
export type SessionStatus = 'READY' | 'CAPTURING' | 'PAUSED' | 'STOPPED' | 'ERROR';
export type STTConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'FAILED';
export type SaveStatus = 'IDLE' | 'SAVING' | 'SAVED' | 'FAILED';
/** MEMO 는 캡처 이미지 없이 메모만 남긴 항목(노트 타임라인). */
export type CaptureType = 'VIDEO_REGION' | 'VIEWPORT' | 'MEMO';
/**
 * 자막 엔진. 지금 배포판은 브라우저 내장 on-device 인식 하나뿐이다.
 * 값이 하나여도 타입을 남겨 두는 이유는, 인식기를 바꿔 끼울 자리(transcription/provider.ts)를 유지하기 위해서다.
 */
export type SttEngine = 'chrome';

export type ErrorCode =
  | 'TAB_NOT_FOUND'
  | 'TAB_CAPTURE_PERMISSION_DENIED'
  | 'TAB_CAPTURE_FAILED'
  | 'VIDEO_ELEMENT_NOT_FOUND'
  | 'SCREENSHOT_FAILED'
  | 'IMAGE_CROP_FAILED'
  | 'STORAGE_WRITE_FAILED'
  | 'STORAGE_READ_FAILED'
  | 'STT_CONNECTION_FAILED'
  | 'STT_PROVIDER_FAILED'
  | 'STT_RATE_LIMITED'
  | 'STT_AUTH_FAILED'
  | 'NETWORK_OFFLINE'
  | 'UNKNOWN';

export interface AppError {
  code: ErrorCode;
  component: string;
  operation: string;
  message: string;
  retryable: boolean;
  cause?: unknown;
}

export function appError(
  code: ErrorCode,
  component: string,
  operation: string,
  message: string,
  retryable = false,
  cause?: unknown
): AppError {
  return { code, component, operation, message, retryable, cause };
}

/** 사용자에게 보여줄 한국어 메시지 (명세 §15). */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  TAB_NOT_FOUND: '현재 탭을 찾을 수 없습니다.',
  TAB_CAPTURE_PERMISSION_DENIED: '탭 오디오 캡처 권한이 없습니다. 강의 탭에서 툴바의 확장 아이콘을 한 번 누른 뒤 다시 시도하세요.',
  TAB_CAPTURE_FAILED: '탭 오디오 캡처를 시작하지 못했습니다.',
  VIDEO_ELEMENT_NOT_FOUND: '재생 중인 영상을 찾지 못해 화면 전체를 저장했습니다.',
  SCREENSHOT_FAILED: '화면 캡처에 실패했습니다.',
  IMAGE_CROP_FAILED: '영상 영역 자르기에 실패해 화면 전체를 저장했습니다.',
  STORAGE_WRITE_FAILED: '저장에 실패했습니다. 잠시 후 다시 시도하세요.',
  STORAGE_READ_FAILED: '저장된 데이터를 불러오지 못했습니다.',
  STT_CONNECTION_FAILED: '자막 서버에 연결할 수 없습니다. STT 서버가 실행 중인지 확인하세요.',
  STT_PROVIDER_FAILED: '음성 인식에 실패했습니다.',
  STT_RATE_LIMITED: '음성 인식 요청이 많아 잠시 지연됩니다.',
  STT_AUTH_FAILED: '음성 인식 서버 인증에 실패했습니다.',
  NETWORK_OFFLINE: '네트워크가 오프라인입니다.',
  UNKNOWN: '알 수 없는 오류가 발생했습니다.'
};

export interface StudySession {
  id: string;
  /** 탭 재사용/새로고침에도 세션을 찾기 위한 키 (origin + pathname). */
  pageKey: string;
  tabOrigin: string;
  pageUrl: string;
  pageTitle: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  generalMemo: string;
  /** 런타임 바인딩용. 브라우저 재시작 시 tabId 는 재사용되므로 식별자로 쓰지 않는다. */
  tabId?: number;
}

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  sequence: number;
  text: string;
  startedAtMs: number;
  endedAtMs: number;
  videoTimeSec?: number;
  createdAt: number;
  status: 'PARTIAL' | 'FINAL';
}

export interface CaptureRecord {
  id: string;
  sessionId: string;
  /** v2: imageBlobs 스토어의 키. */
  imageBlobId?: string;
  /** v1 호환: 예전 레코드는 dataUrl 로 저장돼 있다. */
  dataUrl?: string;
  captureType: CaptureType;
  videoTimeSec?: number;
  pageUrl: string;
  createdAt: number;
  memo: string;
}

export interface StoredImageBlob {
  id: string;
  blob: Blob;
  createdAt: number;
}

export interface VideoRect {
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
  videoTimeSec?: number;
  durationSec?: number;
}

export interface CaptureResponse {
  ok: boolean;
  dataUrl?: string;
  /** 최상위 프레임에서 찾은 영상 영역. iframe 안의 영상은 좌표를 신뢰할 수 없어 담지 않는다. */
  videoRect?: VideoRect | null;
  /** iframe 안의 플레이어를 포함해 찾아낸 재생 위치(초). */
  videoTimeSec?: number;
  pageUrl?: string;
  error?: string;
  errorCode?: ErrorCode;
}

export interface VideoTimeResponse {
  ok: boolean;
  videoTimeSec?: number;
  durationSec?: number;
}

export interface StatusPayload {
  status: SessionStatus;
  stt: STTConnectionStatus;
  sessionId?: string;
  tabId?: number;
  /** 확장 아이콘 클릭으로 activeTab 이 부여된 탭. 페이지를 이동하면 무효가 되어 비워진다. */
  invokedTabId?: number;
  /** 영상 위 자막 오버레이 사용 여부. */
  overlay?: boolean;
  error?: string;
  errorCode?: ErrorCode;
}

export type ExtensionMessage =
  | { type: 'CAPTION_START'; tabId: number; sessionId: string; contextPrompt?: string; engine?: SttEngine }
  | { type: 'CAPTION_PAUSE' }
  | { type: 'CAPTION_RESUME' }
  | { type: 'CAPTION_STOP' }
  | { type: 'CAPTURE_REQUEST'; tabId: number }
  | { type: 'STATUS_GET' }
  | { type: 'OFFSCREEN_START'; streamId: string; sessionId: string; contextPrompt: string; engine?: SttEngine }
  | { type: 'OFFSCREEN_PAUSE' }
  | { type: 'OFFSCREEN_RESUME' }
  | { type: 'OFFSCREEN_STOP' }
  | { type: 'OFFSCREEN_ERROR'; errorCode: ErrorCode; message: string }
  | { type: 'OFFSCREEN_NOTICE'; message: string }
  | { type: 'TRANSCRIPT'; payload: TranscriptSegment }
  /** 확정 전 진행 중인 자막. 저장하지 않고 영상 위 오버레이에만 쓴다. */
  | { type: 'CAPTION_LIVE'; sessionId: string; text: string }
  | { type: 'OVERLAY_SET'; enabled: boolean }
  | { type: 'STT_STATUS'; stt: STTConnectionStatus; errorCode?: ErrorCode }
  | { type: 'STATUS'; payload: StatusPayload };
