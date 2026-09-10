import { describe, expect, it } from 'vitest';
import { buildOverlayText } from '../src/shared/transcripts';

describe('영상 위 자막 오버레이 문구', () => {
  it('확정된 줄과 진행 중인 줄을 이어 붙인다', () => {
    expect(buildOverlayText('앞 문장입니다.', '이어지는 말')).toBe('앞 문장입니다. 이어지는 말');
  });

  it('진행 중인 줄이 없으면 확정된 줄만 남긴다', () => {
    expect(buildOverlayText('앞 문장입니다.', '   ')).toBe('앞 문장입니다.');
  });

  it('둘 다 비어 있으면 빈 문자열이다(오버레이를 숨긴다)', () => {
    expect(buildOverlayText('', '')).toBe('');
  });

  it('길어진 진행 자막은 뒤쪽 두 줄만 남긴다', () => {
    // 서버는 문장이 끝날 때까지(최대 90자) 진행 자막을 계속 늘린다.
    const long = '가나다라마바사 아자차카타파하 노트북 스케줄링 우선순위 라운드로빈 문맥교환 비용 비교 실습 과제 시험 범위 안내';
    const out = buildOverlayText('앞 문장입니다.', long);
    const lines = out.split('\n');
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(42);
    // 최신 내용이 남아야 한다.
    expect(out.endsWith('시험 범위 안내')).toBe(true);
  });

  it('공백 없이 이어진 아주 긴 단어도 잘라서 두 줄 안에 넣는다', () => {
    const out = buildOverlayText('', '가'.repeat(200));
    const lines = out.split('\n');
    expect(lines.length).toBe(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(42);
  });
});

describe('번역이 켜져 있을 때 오버레이', () => {
  it('번역한 확정 줄과 원문 진행 줄을 다른 줄에 둔다', () => {
    const text = buildOverlayText('오늘은 AI 를 배웁니다.', "Today we're going", true);
    expect(text.split('\n')).toHaveLength(2);
    expect(text.split('\n')[0]).toBe('오늘은 AI 를 배웁니다.');
    expect(text.split('\n')[1]).toBe("Today we're going");
  });

  it('두 언어를 한 줄에 섞지 않는다', () => {
    const joined = buildOverlayText('오늘은 AI 를 배웁니다.', "Today we're going", false);
    expect(joined.split('\n')[0]).toContain("Today");
    const split = buildOverlayText('오늘은 AI 를 배웁니다.', "Today we're going", true);
    expect(split.split('\n')[0]).not.toContain('Today');
  });

  it('긴 줄은 각각 마지막 한 줄만 남겨 두 줄을 넘지 않는다', () => {
    const long = '가나다라마바사아자차카타파하'.repeat(8);
    const text = buildOverlayText(long, long, true);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    lines.forEach((line) => expect(line.length).toBeLessThanOrEqual(42));
  });

  it('진행 중인 줄이 없으면 확정 줄만 그린다', () => {
    expect(buildOverlayText('오늘은 AI 를 배웁니다.', '', true)).toBe('오늘은 AI 를 배웁니다.');
  });

  it('둘 다 비면 빈 글자를 돌려준다', () => {
    expect(buildOverlayText('', '', true)).toBe('');
  });
});
