import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveTranslation } from '../src/transcription/live-translation';

/** 실제 번역기처럼 곧바로 끝나지 않게, 해석을 우리가 잡고 있는 가짜 번역기. */
function fakeTranslator() {
  const calls: string[] = [];
  const pending: ((value: string) => void)[] = [];
  const translate = vi.fn((text: string) => {
    calls.push(text);
    return new Promise<string>((resolve) => pending.push(resolve));
  });
  return {
    translate,
    calls,
    /** 아직 답하지 않은 번역 요청에 순서대로 답한다. */
    settle(...values: string[]) {
      for (const value of values) pending.shift()?.(value);
    }
  };
}

let updates: string[];

beforeEach(() => {
  vi.useFakeTimers();
  updates = [];
});

afterEach(() => {
  vi.useRealTimers();
});

const make = (fake: ReturnType<typeof fakeTranslator>, intervalMs = 400) =>
  new LiveTranslation(fake.translate, (text) => updates.push(text), intervalMs);

describe('확정 전 자막 흘려보내기', () => {
  it('말이 끝나기 전에도 번역이 화면으로 나간다', async () => {
    const fake = fakeTranslator();
    const live = make(fake);

    live.push('hello there');
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.calls).toEqual(['hello there']);

    fake.settle('안녕하세요');
    await vi.advanceTimersByTimeAsync(0);
    expect(updates).toEqual(['안녕하세요']);
    expect(live.translation).toBe('안녕하세요');
  });

  it('간격 안에 들어온 중간 결과는 마지막 것만 넘긴다', async () => {
    const fake = fakeTranslator();
    const live = make(fake);

    live.push('a');
    live.push('a b');
    live.push('a b c');
    await vi.advanceTimersByTimeAsync(400);

    expect(fake.calls).toEqual(['a b c']);
  });

  it('번역이 도는 동안 붙은 말은 끝난 뒤에 이어서 넘긴다', async () => {
    const fake = fakeTranslator();
    const live = make(fake);

    live.push('a b c');
    await vi.advanceTimersByTimeAsync(400);
    live.push('a b c d');
    fake.settle('가 나 다');
    await vi.advanceTimersByTimeAsync(400);

    expect(fake.calls).toEqual(['a b c', 'a b c d']);
  });

  it('같은 글자를 다시 받으면 번역기를 부르지 않는다', async () => {
    const fake = fakeTranslator();
    const live = make(fake);

    live.push('a b c');
    await vi.advanceTimersByTimeAsync(400);
    fake.settle('가 나 다');
    await vi.advanceTimersByTimeAsync(0);
    live.push('a b c');
    await vi.advanceTimersByTimeAsync(400);

    expect(fake.calls).toEqual(['a b c']);
  });

  it('줄이 확정되면 흘려보낸 번역을 넘겨주고 비운다', async () => {
    const fake = fakeTranslator();
    const live = make(fake);

    live.push('hello there');
    await vi.advanceTimersByTimeAsync(400);
    fake.settle('안녕하세요');
    await vi.advanceTimersByTimeAsync(0);

    expect(live.flush()).toBe('안녕하세요');
    expect(live.translation).toBe('');
  });

  it('확정된 뒤에 도착한 번역은 화면을 건드리지 않는다', async () => {
    const fake = fakeTranslator();
    const live = make(fake);

    live.push('hello there');
    await vi.advanceTimersByTimeAsync(400);
    live.flush(); // 그 사이 줄이 확정됨
    fake.settle('안녕하세요');
    await vi.advanceTimersByTimeAsync(0);

    expect(updates).toEqual([]);
    expect(live.translation).toBe('');
  });

  it('멈춘 뒤에는 예약된 번역이 돌지 않는다', async () => {
    const fake = fakeTranslator();
    const live = make(fake);

    live.push('hello there');
    live.clear();
    await vi.advanceTimersByTimeAsync(1000);

    expect(fake.calls).toEqual([]);
  });

  it('번역이 빈 문자열이면 화면을 건드리지 않는다 (모델 내려받는 중)', async () => {
    const fake = fakeTranslator();
    const live = make(fake);

    live.push('hello there');
    await vi.advanceTimersByTimeAsync(400);
    fake.settle('');
    await vi.advanceTimersByTimeAsync(0);

    expect(updates).toEqual([]);
    expect(live.translation).toBe('');
  });

  it('빈 중간 결과는 번역기를 부르지 않는다', async () => {
    const fake = fakeTranslator();
    const live = make(fake);

    live.push('   ');
    await vi.advanceTimersByTimeAsync(1000);

    expect(fake.calls).toEqual([]);
  });
});
