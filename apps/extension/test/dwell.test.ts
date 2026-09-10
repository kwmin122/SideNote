import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CaptionDwell } from '../src/offscreen/dwell';

describe('자막 잔류 시간', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('말이 끊기면 정해진 시간 뒤에 화면을 비운다', () => {
    const expire = vi.fn();
    const dwell = new CaptionDwell(expire, 5000);
    dwell.touch('안녕하세요');
    vi.advanceTimersByTime(4999);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('자막이 계속 들어오는 동안에는 비우지 않는다', () => {
    const expire = vi.fn();
    const dwell = new CaptionDwell(expire, 5000);
    for (let i = 0; i < 10; i += 1) {
      dwell.touch(`줄 ${i}`);
      vi.advanceTimersByTime(4000);
    }
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('빈 글자는 이미 비운 것이므로 다시 비우지 않는다', () => {
    const expire = vi.fn();
    const dwell = new CaptionDwell(expire, 5000);
    dwell.touch('안녕하세요');
    dwell.touch('');
    vi.advanceTimersByTime(60_000);
    expect(expire).not.toHaveBeenCalled();
  });

  it('한 번 비우면 다시 부르지 않는다', () => {
    const expire = vi.fn();
    const dwell = new CaptionDwell(expire, 1000);
    dwell.touch('안녕하세요');
    vi.advanceTimersByTime(10_000);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('자막을 멈추면 예약된 비우기도 취소된다', () => {
    const expire = vi.fn();
    const dwell = new CaptionDwell(expire, 5000);
    dwell.touch('안녕하세요');
    dwell.cancel();
    vi.advanceTimersByTime(60_000);
    expect(expire).not.toHaveBeenCalled();
  });
});
