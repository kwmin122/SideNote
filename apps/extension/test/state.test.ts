import { describe, expect, it } from 'vitest';
import { badgeTextFor, isCaptureLive, shouldResyncTab, shouldStopOnPanelClose, transition } from '../src/shared/state';

describe('캡처 상태 전이 (명세 §20.5)', () => {
  it('READY → START 는 캡처를 시작한다', () => {
    const result = transition('READY', 'START');
    expect(result).toMatchObject({ status: 'CAPTURING', changed: true, effect: 'START_CAPTURE' });
  });

  it('CAPTURING 에서 START 를 또 눌러도 중복 캡처가 생기지 않는다', () => {
    const result = transition('CAPTURING', 'START');
    expect(result.changed).toBe(false);
    expect(result.effect).toBe('NONE');
    expect(result.status).toBe('CAPTURING');
  });

  it('CAPTURING → PAUSE → RESUME → CAPTURING 왕복', () => {
    const paused = transition('CAPTURING', 'PAUSE');
    expect(paused).toMatchObject({ status: 'PAUSED', effect: 'PAUSE_CAPTURE' });
    const resumed = transition(paused.status, 'RESUME');
    expect(resumed).toMatchObject({ status: 'CAPTURING', effect: 'RESUME_CAPTURE' });
  });

  it('PAUSED 에서 START 는 무시된다 (RESUME 을 써야 한다)', () => {
    expect(transition('PAUSED', 'START').changed).toBe(false);
  });

  it('STOP 을 두 번 눌러도 안전하다', () => {
    const first = transition('CAPTURING', 'STOP');
    expect(first).toMatchObject({ status: 'STOPPED', changed: true, effect: 'STOP_CAPTURE' });
    const second = transition(first.status, 'STOP');
    expect(second.changed).toBe(false);
    expect(second.effect).toBe('NONE');
  });

  it('READY 상태에서 PAUSE/RESUME 은 무시된다', () => {
    expect(transition('READY', 'PAUSE').changed).toBe(false);
    expect(transition('READY', 'RESUME').changed).toBe(false);
  });

  it('STOPPED 이후 START 하면 새 캡처가 시작된다', () => {
    expect(transition('STOPPED', 'START')).toMatchObject({ status: 'CAPTURING', effect: 'START_CAPTURE' });
  });

  it('오류가 나면 ERROR 로 가고 캡처를 정리한다', () => {
    expect(transition('CAPTURING', 'FAIL')).toMatchObject({ status: 'ERROR', effect: 'STOP_CAPTURE' });
  });
});

describe('자막이 끝난 뒤 현재 탭에 다시 맞추기', () => {
  it('자막을 받는 중에 영상이 바뀌어 자막이 끊기면 다시 맞춘다', () => {
    // 재생 중 다음 영상으로 이동 → 배경이 STOPPED 로 내린다. 이때 화면은 아직 이전 영상 노트다.
    expect(shouldResyncTab('CAPTURING', 'STOPPED')).toBe(true);
    expect(shouldResyncTab('PAUSED', 'STOPPED')).toBe(true);
    expect(shouldResyncTab('CAPTURING', 'ERROR')).toBe(true);
  });

  it('자막을 받는 중인 상태끼리의 이동은 노트를 갈아타지 않는다', () => {
    expect(shouldResyncTab('CAPTURING', 'PAUSED')).toBe(false);
    expect(shouldResyncTab('PAUSED', 'CAPTURING')).toBe(false);
  });

  it('자막을 받고 있지 않다가 바뀐 경우는 이미 탭 이벤트가 맞춰 두었으므로 건드리지 않는다', () => {
    expect(shouldResyncTab('READY', 'CAPTURING')).toBe(false);
    expect(shouldResyncTab('READY', 'STOPPED')).toBe(false);
    expect(shouldResyncTab('STOPPED', 'READY')).toBe(false);
  });

  it('isCaptureLive 는 수신 중과 일시정지만 참이다', () => {
    expect(isCaptureLive('CAPTURING')).toBe(true);
    expect(isCaptureLive('PAUSED')).toBe(true);
    expect(isCaptureLive('READY')).toBe(false);
    expect(isCaptureLive('STOPPED')).toBe(false);
    expect(isCaptureLive('ERROR')).toBe(false);
  });
});

describe('아이콘 배지 (사이드패널을 닫아도 돌고 있는지 보여 준다)', () => {
  it('자막을 받는 중에는 점을 찍는다', () => {
    expect(badgeTextFor('CAPTURING')).toBe('●');
  });

  it('잠시 멈춤은 다른 표시를 쓴다', () => {
    expect(badgeTextFor('PAUSED')).toBe('❚❚');
  });

  it('돌지 않을 때는 아무것도 찍지 않는다', () => {
    expect(badgeTextFor('READY')).toBe('');
    expect(badgeTextFor('STOPPED')).toBe('');
    expect(badgeTextFor('ERROR')).toBe('');
  });
});

describe('사이드패널을 닫았을 때 자막을 멈출지', () => {
  it('"닫아도 계속"이 켜져 있으면 받던 자막을 그대로 둔다', () => {
    expect(shouldStopOnPanelClose('CAPTURING', true)).toBe(false);
    expect(shouldStopOnPanelClose('PAUSED', true)).toBe(false);
  });

  it('꺼져 있으면 닫는 순간 멈춘다', () => {
    expect(shouldStopOnPanelClose('CAPTURING', false)).toBe(true);
    expect(shouldStopOnPanelClose('PAUSED', false)).toBe(true);
  });

  it('원래 돌고 있지 않았다면 멈출 것도 없다', () => {
    expect(shouldStopOnPanelClose('READY', false)).toBe(false);
    expect(shouldStopOnPanelClose('STOPPED', false)).toBe(false);
    expect(shouldStopOnPanelClose('ERROR', false)).toBe(false);
  });
});
