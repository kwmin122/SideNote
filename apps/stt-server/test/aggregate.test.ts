import { describe, expect, it } from 'vitest';
import { LineAggregator, endsSentence } from '../src/aggregate.js';

const opts = { maxLineMs: 15000, maxLineChars: 90, gapMs: 200 };
const frag = (text: string, startedAtMs: number, endedAtMs: number) => ({ text, startedAtMs, endedAtMs });

describe('문장 끝 판정', () => {
  it('종결어미로 끝나면 문장 끝으로 본다', () => {
    expect(endsSentence('프로세스 스케줄링입니다')).toBe(true);
    expect(endsSentence('한번 살펴볼까요')).toBe(true);
    expect(endsSentence('그렇게 하면 됩니다.')).toBe(true);
    expect(endsSentence('여기까지 하겠죠')).toBe(true);
  });

  it('명사로 끝나면 문장 끝이 아니다', () => {
    // '필요', '중요' 처럼 요/다 로 끝나는 명사를 문장 끝으로 오인하면 자막이 또 잘게 쪼개진다
    expect(endsSentence('이 부분이 아주 중요')).toBe(false);
    expect(endsSentence('전세계적으로 보안 기초 및 인공지능')).toBe(false);
    expect(endsSentence('보안 가이드와 규제를 수립하고 있는')).toBe(false);
    expect(endsSentence('')).toBe(false);
  });

  it('구두점으로 끝나면 문장 끝이다', () => {
    expect(endsSentence('그래서 어떻게 될까?')).toBe(true);
    expect(endsSentence('자 다음 장으로…')).toBe(true);
  });
});

describe('자막 줄 묶기', () => {
  it('문장이 끝날 때까지 조각을 모아 한 줄로 낸다', () => {
    const a = new LineAggregator(opts);
    expect(a.push(frag('전세계적으로 보안 기초 및', 0, 5000))).toEqual([]);
    expect(a.push(frag('인공지능 보안 가이드를', 3800, 8800))).toEqual([]);
    const done = a.push(frag('수립하고 있습니다', 7600, 12600));
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({
      text: '전세계적으로 보안 기초 및 인공지능 보안 가이드를 수립하고 있습니다',
      startedAtMs: 0,
      endedAtMs: 12600
    });
    expect(a.pending).toBeNull();
  });

  it('진행 중인 줄은 pending 으로 즉시 읽을 수 있다', () => {
    const a = new LineAggregator(opts);
    a.push(frag('오늘 다룰 내용은', 0, 5000));
    expect(a.pending).toMatchObject({ text: '오늘 다룰 내용은', startedAtMs: 0, endedAtMs: 5000 });
    a.push(frag('세 가지입니다', 3800, 8800));
    expect(a.pending).toBeNull();
  });

  it('조각 사이가 비면(무음) 앞 줄을 끊는다', () => {
    const a = new LineAggregator(opts);
    a.push(frag('앞 문장 조각', 0, 5000));
    const done = a.push(frag('한참 뒤에 나온 말', 9000, 14000));
    expect(done).toHaveLength(1);
    expect(done[0].text).toBe('앞 문장 조각');
    expect(a.pending?.text).toBe('한참 뒤에 나온 말');
  });

  it('겹치는 window 의 음수 간격은 끊김으로 보지 않는다', () => {
    const a = new LineAggregator(opts);
    a.push(frag('앞 조각', 0, 5000));
    // 다음 window 는 3800ms 전진 → 시작(3800) < 직전 끝(5000)
    expect(a.push(frag('뒤 조각', 3800, 8800))).toEqual([]);
    expect(a.pending?.text).toBe('앞 조각 뒤 조각');
  });

  it('문장이 안 끝나도 최대 길이를 넘으면 끊는다', () => {
    const a = new LineAggregator({ ...opts, maxLineMs: 8000 });
    a.push(frag('계속 이어지는 말이고', 0, 5000));
    const done = a.push(frag('여전히 안 끝나는 말이고', 3800, 8800));
    expect(done).toHaveLength(1);
    expect(done[0].endedAtMs).toBe(8800);
  });

  it('글자 수 상한을 넘어도 끊는다', () => {
    const a = new LineAggregator({ ...opts, maxLineChars: 12 });
    const done = a.push(frag('열두 글자가 넘는 조각입니당', 0, 5000));
    expect(done).toHaveLength(1);
  });

  it('빈 조각은 무시한다', () => {
    const a = new LineAggregator(opts);
    expect(a.push(frag('   ', 0, 5000))).toEqual([]);
    expect(a.pending).toBeNull();
  });

  it('flush 는 남은 줄을 확정하고 비운다', () => {
    const a = new LineAggregator(opts);
    a.push(frag('마무리 안 된 말', 0, 5000));
    expect(a.flush()?.text).toBe('마무리 안 된 말');
    expect(a.flush()).toBeNull();
  });

  it('reset 은 남은 조각을 버린다', () => {
    const a = new LineAggregator(opts);
    a.push(frag('버려질 말', 0, 5000));
    a.reset();
    expect(a.flush()).toBeNull();
  });
});
