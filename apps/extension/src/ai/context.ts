/**
 * AI 에게 넘길 강의 자료를 한 덩이 글로 만든다. 순수 함수만 두어 그대로 단위 테스트한다.
 *
 * 내장 모델의 문맥 창은 넉넉하지 않다(대체로 몇천 토큰). 한 시간짜리 강의 스크립트를 통째로 넣으면
 * 앞부분만 들어가고 잘려 나가므로, 넘칠 때는 앞과 뒤를 남기고 가운데를 접는다.
 * 강의는 도입과 결론에 요점이 몰려 있어, 가운데를 접는 편이 뒤를 통째로 버리는 것보다 낫다.
 */
import type { ScriptLine, TranscriptSegment } from '../shared/contracts';
import { formatScriptClock } from '../shared/script';
import { t } from '../shared/i18n';

/** 무엇을 넣을지. 사용자가 화면에서 직접 켜고 끈다(켜지 않은 것은 절대 넘어가지 않는다). */
export interface ContextPick {
  script: boolean;
  transcript: boolean;
  memo: boolean;
  captures: boolean;
}

export interface ContextSources {
  title: string;
  pageUrl: string;
  memo: string;
  transcripts: Pick<TranscriptSegment, 'startedAtMs' | 'text' | 'translation'>[];
  script: ScriptLine[];
  captures: Array<{ videoTimeSec?: number; memo: string }>;
}

/** 기본 예산(글자 수). 내장 모델 문맥 창을 넘지 않도록 넉넉히 잡은 값이다. */
export const DEFAULT_CONTEXT_BUDGET = 8000;

/**
 * 줄 목록을 예산 안으로 줄인다. 넘치면 앞뒤를 남기고 가운데를 한 줄로 접는다.
 * 접었다는 사실을 글 안에 적어 둬야 모델이 "중간이 빠졌다"는 걸 알고 답한다.
 */
export function condenseLines(lines: string[], budget: number): string[] {
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= budget || lines.length < 3) return lines.slice();
  const half = Math.max(1, Math.floor(budget / 2));
  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > half) break;
    head.push(line);
    used += line.length + 1;
  }
  const tail: string[] = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i -= 1) {
    const line = lines[i];
    if (used + line.length + 1 > half) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  const skipped = lines.length - head.length - tail.length;
  if (skipped <= 0) return lines.slice();
  return [...head, t('aiContextElided', skipped), ...tail];
}

function transcriptLines(items: ContextSources['transcripts']): string[] {
  return items
    .map((item) => {
      const text = (item.translation?.trim() || item.text || '').trim();
      if (!text) return '';
      return `[${formatScriptClock(Math.floor(item.startedAtMs / 1000))}] ${text}`;
    })
    .filter(Boolean);
}

function scriptLines(lines: ScriptLine[]): string[] {
  return lines.map((line) => `[${formatScriptClock(line.startSec)}] ${line.text}`);
}

function captureLines(captures: ContextSources['captures']): string[] {
  return captures
    .map((capture) => {
      const memo = capture.memo?.trim();
      if (!memo) return '';
      const at = capture.videoTimeSec != null ? `[${formatScriptClock(capture.videoTimeSec)}] ` : '';
      return `${at}${memo}`;
    })
    .filter(Boolean);
}

/**
 * 고른 자료만 모아 한 덩이 글로 만든다.
 * 스크립트와 실시간 자막이 둘 다 켜져 있으면 스크립트를 본문으로 삼고 자막에는 예산을 적게 준다.
 * 같은 말을 두 번 넣어 문맥을 낭비하지 않기 위해서다.
 */
export function buildAiContext(
  sources: ContextSources,
  pick: ContextPick,
  budget = DEFAULT_CONTEXT_BUDGET
): string {
  const blocks: string[] = [];
  blocks.push(`${t('aiContextLecture')}: ${sources.title || t('defaultLectureTitle')}`);
  if (sources.pageUrl) blocks.push(`URL: ${sources.pageUrl}`);

  const script = pick.script ? scriptLines(sources.script) : [];
  const transcript = pick.transcript ? transcriptLines(sources.transcripts) : [];
  const bodyBudget = Math.max(500, budget - 800);
  const scriptBudget = script.length && transcript.length ? Math.floor(bodyBudget * 0.7) : bodyBudget;
  const transcriptBudget = script.length && transcript.length ? bodyBudget - scriptBudget : bodyBudget;

  if (script.length) {
    blocks.push(`\n## ${t('aiContextScript')}\n${condenseLines(script, scriptBudget).join('\n')}`);
  }
  if (transcript.length) {
    blocks.push(`\n## ${t('aiContextCaptions')}\n${condenseLines(transcript, transcriptBudget).join('\n')}`);
  }
  if (pick.memo && sources.memo.trim()) {
    blocks.push(`\n## ${t('aiContextMemo')}\n${condenseLines(sources.memo.trim().split('\n'), 1500).join('\n')}`);
  }
  if (pick.captures) {
    const notes = captureLines(sources.captures);
    if (notes.length) blocks.push(`\n## ${t('aiContextCaptureMemos')}\n${condenseLines(notes, 1500).join('\n')}`);
  }
  return blocks.join('\n');
}

/** 지금 고른 자료가 대략 몇 글자인지. 화면에 보여 줘서 "무엇이 넘어가는지" 알게 한다. */
export function contextCharCount(sources: ContextSources, pick: ContextPick): number {
  let count = 0;
  if (pick.script) count += sources.script.reduce((sum, line) => sum + line.text.length, 0);
  if (pick.transcript) count += sources.transcripts.reduce((sum, item) => sum + (item.translation || item.text || '').length, 0);
  if (pick.memo) count += sources.memo.trim().length;
  if (pick.captures) count += sources.captures.reduce((sum, capture) => sum + (capture.memo?.trim().length ?? 0), 0);
  return count;
}
