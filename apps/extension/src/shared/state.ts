import type { SessionStatus } from './contracts';

export type CaptureCommand = 'START' | 'PAUSE' | 'RESUME' | 'STOP' | 'FAIL' | 'RESET';

export interface TransitionResult {
  /** 다음 상태. 무시된 명령이면 현재 상태와 같다. */
  status: SessionStatus;
  /** 명령이 실제로 상태를 바꿨는지. false 면 side effect 를 실행하면 안 된다. */
  changed: boolean;
  /** 이 전이에서 수행해야 하는 부수효과. */
  effect: 'NONE' | 'START_CAPTURE' | 'PAUSE_CAPTURE' | 'RESUME_CAPTURE' | 'STOP_CAPTURE';
  reason?: string;
}

const ignore = (status: SessionStatus, reason: string): TransitionResult => ({
  status,
  changed: false,
  effect: 'NONE',
  reason
});

/**
 * 명세 §20.5 상태 전이 규칙.
 * - READY/STOPPED/ERROR + START  → CAPTURING (새 캡처 시작)
 * - CAPTURING + START            → 무시 (중복 캡처 스트림 금지)
 * - CAPTURING + PAUSE            → PAUSED
 * - PAUSED + RESUME              → CAPTURING
 * - 어떤 상태든 STOP 은 안전하다 (이미 STOPPED 면 무시).
 */
export function transition(current: SessionStatus, command: CaptureCommand): TransitionResult {
  switch (command) {
    case 'START':
      if (current === 'CAPTURING') return ignore(current, '이미 자막을 수신 중입니다.');
      if (current === 'PAUSED') return ignore(current, '일시정지 상태입니다. 계속하기를 누르세요.');
      return { status: 'CAPTURING', changed: true, effect: 'START_CAPTURE' };
    case 'PAUSE':
      if (current !== 'CAPTURING') return ignore(current, '자막 수신 중이 아닙니다.');
      return { status: 'PAUSED', changed: true, effect: 'PAUSE_CAPTURE' };
    case 'RESUME':
      if (current !== 'PAUSED') return ignore(current, '일시정지 상태가 아닙니다.');
      return { status: 'CAPTURING', changed: true, effect: 'RESUME_CAPTURE' };
    case 'STOP':
      if (current === 'STOPPED' || current === 'READY') return ignore(current, '이미 종료된 상태입니다.');
      return { status: 'STOPPED', changed: true, effect: 'STOP_CAPTURE' };
    case 'FAIL':
      if (current === 'ERROR') return ignore(current, '이미 오류 상태입니다.');
      return { status: 'ERROR', changed: true, effect: 'STOP_CAPTURE' };
    case 'RESET':
      if (current === 'READY') return ignore(current, '이미 준비 상태입니다.');
      return { status: 'READY', changed: true, effect: 'NONE' };
  }
}

export const COMMAND_BY_MESSAGE: Record<string, CaptureCommand> = {
  CAPTION_START: 'START',
  CAPTION_PAUSE: 'PAUSE',
  CAPTION_RESUME: 'RESUME',
  CAPTION_STOP: 'STOP'
};

/** 자막을 받는 중(수신/일시정지)인가. 이 동안에는 노트를 갈아타지 않는다. */
export function isCaptureLive(status: SessionStatus): boolean {
  return status === 'CAPTURING' || status === 'PAUSED';
}

/**
 * 자막이 방금 끝났으니 현재 탭의 노트로 다시 맞춰야 하는가.
 *
 * 자막을 받는 동안에는 탭 주소가 바뀌어도 노트를 갈아타지 않는다(자막이 엉뚱한 노트에 쌓이는 것을 막는다).
 * 그래서 재생 중에 다음 영상으로 넘어가면, 배경이 자막을 끊은 뒤에도 화면에는 이전 영상의 노트가 남는다.
 * 그대로 [자막 시작] 을 다시 누르면 새 영상 자막이 이전 노트에 쌓인다. 끝난 그 순간 한 번 더 맞춘다.
 */
export function shouldResyncTab(prev: SessionStatus, next: SessionStatus): boolean {
  return isCaptureLive(prev) && !isCaptureLive(next);
}
