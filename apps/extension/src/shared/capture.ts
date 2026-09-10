import type { CaptureType, VideoRect } from './contracts';

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * captureVisibleTab 결과는 물리 픽셀(devicePixelRatio 반영), getBoundingClientRect 는 CSS 픽셀이다.
 * dpr 로 환산한 뒤 이미지 경계로 clamp 한다. 유효 영역이 남지 않으면 null → 뷰포트 전체로 폴백.
 */
export function computeCropRect(rect: VideoRect | null | undefined, imageWidth: number, imageHeight: number): CropRect | null {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null;
  const dpr = Number(rect.dpr) > 0 ? Number(rect.dpr) : 1;
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(imageWidth - sx, Math.round(rect.width * dpr));
  const sh = Math.min(imageHeight - sy, Math.round(rect.height * dpr));
  // 화면 밖으로 스크롤된 영상 등 실질 영역이 없으면 crop 하지 않는다.
  if (sw < 16 || sh < 16) return null;
  return { sx, sy, sw, sh };
}

export function captureTypeFor(cropped: boolean): CaptureType {
  return cropped ? 'VIDEO_REGION' : 'VIEWPORT';
}

export interface FrameVideoResult {
  frameId: number;
  result: VideoRect | null | undefined;
}

/**
 * 모든 프레임의 영상 탐색 결과에서 쓸 값을 고른다.
 * - 자르기 좌표는 최상위 프레임(frameId 0)만 유효하다. iframe 의 getBoundingClientRect 는
 *   그 프레임 기준이라 탭 스크린샷에 그대로 적용하면 엉뚱한 영역이 잘린다.
 * - 재생 위치는 프레임 좌표와 무관하므로 iframe 플레이어 값도 그대로 쓴다.
 */
export function pickVideoFromFrames(frames: FrameVideoResult[]): { topRect: VideoRect | null; anyVideo: VideoRect | null } {
  const topRect = frames.find((frame) => frame.frameId === 0)?.result ?? null;
  const anyVideo = topRect ?? frames.map((frame) => frame.result).find((rect) => rect != null) ?? null;
  return { topRect, anyVideo };
}
