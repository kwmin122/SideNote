import { describe, expect, it } from 'vitest';
import {
  buildAiContext,
  condenseLines,
  contextCharCount,
  type ContextPick,
  type ContextSources
} from '../src/ai/context';

const ALL: ContextPick = { script: true, transcript: true, memo: true, captures: true };
const NONE: ContextPick = { script: false, transcript: false, memo: false, captures: false };

function sources(patch: Partial<ContextSources> = {}): ContextSources {
  return {
    title: '선형대수 3강',
    pageUrl: 'https://example.com/watch?v=abc',
    memo: '고윳값 부분 다시 볼 것',
    transcripts: [
      { startedAtMs: 0, text: 'first spoken line' },
      { startedAtMs: 65000, text: 'second spoken line', translation: '두 번째 줄' }
    ],
    script: [
      { startSec: 0, text: '영상 자막 첫 줄' },
      { startSec: 12, text: '영상 자막 둘째 줄' }
    ],
    captures: [{ videoTimeSec: 42, memo: '이 슬라이드가 핵심' }, { memo: '' }],
    ...patch
  };
}

describe('예산에 맞춰 줄 접기', () => {
  it('예산 안이면 그대로 둔다', () => {
    const lines = ['a', 'b', 'c'];
    expect(condenseLines(lines, 100)).toEqual(lines);
  });

  it('넘치면 앞뒤를 남기고 가운데를 한 줄로 접는다', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const out = condenseLines(lines, 100);
    expect(out.length).toBeLessThan(lines.length);
    expect(out[0]).toBe('line 0');
    expect(out[out.length - 1]).toBe('line 49');
    expect(out.join('\n')).toMatch(/omitted/);
  });

  it('줄이 두 개뿐이면 접지 않는다 (접어 봐야 남는 게 없다)', () => {
    const lines = ['x'.repeat(500), 'y'.repeat(500)];
    expect(condenseLines(lines, 10)).toEqual(lines);
  });
});

describe('AI 에게 넘길 글 만들기', () => {
  it('제목과 주소는 항상 앞에 붙는다', () => {
    const text = buildAiContext(sources(), NONE);
    expect(text).toContain('선형대수 3강');
    expect(text).toContain('https://example.com/watch?v=abc');
  });

  it('고르지 않은 자료는 한 글자도 넘어가지 않는다', () => {
    const text = buildAiContext(sources(), NONE);
    expect(text).not.toContain('영상 자막 첫 줄');
    expect(text).not.toContain('first spoken line');
    expect(text).not.toContain('고윳값');
    expect(text).not.toContain('이 슬라이드가 핵심');
  });

  it('고른 자료만 골라 넣는다', () => {
    const text = buildAiContext(sources(), { ...NONE, script: true });
    expect(text).toContain('영상 자막 첫 줄');
    expect(text).not.toContain('first spoken line');
    expect(text).not.toContain('고윳값');
  });

  it('전부 고르면 네 덩이가 모두 들어간다', () => {
    const text = buildAiContext(sources(), ALL);
    expect(text).toContain('영상 자막 첫 줄');
    expect(text).toContain('first spoken line');
    expect(text).toContain('고윳값 부분 다시 볼 것');
    expect(text).toContain('이 슬라이드가 핵심');
  });

  it('자막에 번역이 있으면 번역을 넣는다 (사용자가 읽는 언어와 같게)', () => {
    const text = buildAiContext(sources(), { ...NONE, transcript: true });
    expect(text).toContain('두 번째 줄');
    expect(text).not.toContain('second spoken line');
  });

  it('자막에는 재생 위치가 시:분:초로 붙는다', () => {
    const text = buildAiContext(sources(), { ...NONE, transcript: true });
    expect(text).toContain('[00:01:05]');
  });

  it('메모가 비어 있으면 그 덩이 자체를 넣지 않는다', () => {
    const text = buildAiContext(sources({ memo: '   ' }), ALL);
    expect(text).not.toContain('## My note');
  });

  it('스크립트와 자막이 둘 다면 스크립트에 예산을 더 준다', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ startSec: i, text: `script line ${i}` }));
    const spoken = Array.from({ length: 400 }, (_, i) => ({ startedAtMs: i * 1000, text: `spoken line ${i}` }));
    const both = buildAiContext(sources({ script: many, transcripts: spoken }), { ...NONE, script: true, transcript: true }, 4000);
    const scriptOnly = both.split('##')[1] ?? '';
    const transcriptOnly = both.split('##')[2] ?? '';
    expect(scriptOnly.length).toBeGreaterThan(transcriptOnly.length);
  });

  it('아주 긴 강의를 넣어도 예산 근처에서 멈춘다', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ startSec: i, text: `아주 긴 강의 자막 줄 ${i}` }));
    const text = buildAiContext(sources({ script: many }), { ...NONE, script: true }, 4000);
    expect(text.length).toBeLessThan(6000);
  });
});

describe('넘어갈 글자 수 세기', () => {
  it('고른 자료의 글자만 센다', () => {
    const only = contextCharCount(sources(), { ...NONE, memo: true });
    expect(only).toBe('고윳값 부분 다시 볼 것'.length);
  });

  it('아무것도 안 고르면 0 이다', () => {
    expect(contextCharCount(sources(), NONE)).toBe(0);
  });

  it('메모가 없는 캡처는 세지 않는다', () => {
    expect(contextCharCount(sources(), { ...NONE, captures: true })).toBe('이 슬라이드가 핵심'.length);
  });
});
