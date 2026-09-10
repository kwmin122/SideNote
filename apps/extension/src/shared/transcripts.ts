import type { TranscriptSegment } from './contracts';

/** 같은 sequence 는 덮어쓰고, 항상 sequence 오름차순으로 정렬한다. */
export function mergeSegment(list: TranscriptSegment[], incoming: TranscriptSegment): TranscriptSegment[] {
  const index = list.findIndex((item) => item.sequence === incoming.sequence);
  const next = index < 0 ? [...list, incoming] : list.map((item, i) => (i === index ? incoming : item));
  next.sort((a, b) => a.sequence - b.sequence);
  return next;
}

/** 메모리 상한을 넘으면 오래된 자막부터 버린다 (DB 에는 이미 저장돼 있다). */
export function capSegments(list: TranscriptSegment[], max: number): TranscriptSegment[] {
  return list.length <= max ? list : list.slice(list.length - max);
}

/** (음악) [박수] 처럼 인식기가 말이 아닌 소리에 붙이는 토큰. 자막으로 저장하지 않는다. */
const NON_SPEECH = /^\s*[（(\[【][^)\]】）]*[)\]】）]\s*$/;

/** 빈 자막/공백/구두점만 있는 자막, 비음성 토큰은 저장하지 않는다. */
export function isMeaningfulTranscript(text: string | undefined | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed || NON_SPEECH.test(trimmed)) return false;
  return /[\p{L}\p{N}]/u.test(trimmed);
}

export function transcriptToText(list: TranscriptSegment[]): string {
  return list
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n');
}

/** 오버레이 한 줄에 넣을 최대 글자 수. 유튜브 자막처럼 짧게 끊는다. */
const OVERLAY_LINE_CHARS = 42;
/** 오버레이에 동시에 띄울 최대 줄 수. */
const OVERLAY_MAX_LINES = 2;

/** 공백을 기준으로 maxChars 이하 줄로 나눈다. 한 단어가 그보다 길면 그대로 자른다. */
function wrapWords(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = '';
  const push = () => {
    while (line.length > maxChars) {
      lines.push(line.slice(0, maxChars));
      line = line.slice(maxChars);
    }
  };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line = `${line} ${word}`;
    else {
      push();
      if (line) lines.push(line);
      line = word;
    }
    push();
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * 영상 위 오버레이에 띄울 문구.
 * 확정된 직전 줄과 진행 중인 줄을 이어 붙인 뒤 마지막 두 줄만 남긴다.
 * 진행 중인 줄은 문장이 끝날 때까지 계속 길어지므로 반드시 뒤에서 잘라야 한다.
 */
export function buildOverlayText(finalLine: string, partialLine: string): string {
  const combined = [finalLine.trim(), partialLine.trim()].filter(Boolean).join(' ');
  if (!combined) return '';
  return wrapWords(combined, OVERLAY_LINE_CHARS).slice(-OVERLAY_MAX_LINES).join('\n');
}
