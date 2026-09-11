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

/** 자막 한 줄을 글자로. 번역이 붙어 있으면 원문 아래 줄에 같이 담는다. */
export function lineToText(item: TranscriptSegment): string {
  const text = item.text.trim();
  const translation = item.translation?.trim();
  return translation ? `${text}\n${translation}` : text;
}

export function transcriptToText(list: TranscriptSegment[]): string {
  return list
    .map(lineToText)
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
 *
 * separateLines 는 번역이 켜져 있을 때 쓴다. 그때 위는 확정된 줄의 번역문,
 * 아래는 아직 확정되지 않은 원문이라 언어가 서로 다르다. 한 문장처럼 이어 붙이면
 * 두 언어가 한 줄에서 섞이므로 줄을 나누고 각각의 마지막 줄만 남긴다.
 */
export function buildOverlayText(finalLine: string, partialLine: string, separateLines = false): string {
  const final = finalLine.trim();
  const partial = partialLine.trim();
  if (separateLines) {
    const finalLines = wrapWords(final, OVERLAY_LINE_CHARS);
    const partialLines = wrapWords(partial, OVERLAY_LINE_CHARS);
    if (!partialLines.length) return finalLines.slice(-OVERLAY_MAX_LINES).join('\n');
    if (!finalLines.length) return partialLines.slice(-OVERLAY_MAX_LINES).join('\n');
    return [finalLines[finalLines.length - 1], partialLines[partialLines.length - 1]].join('\n');
  }
  const combined = [final, partial].filter(Boolean).join(' ');
  if (!combined) return '';
  return wrapWords(combined, OVERLAY_LINE_CHARS).slice(-OVERLAY_MAX_LINES).join('\n');
}

/**
 * 화면에 무엇을 그릴지 고른다.
 *
 * text 는 영상 위 오버레이(두 줄까지), partial 은 사이드패널에 흘려보낼 '아직 확정 전의 줄'이다.
 * 옮겨서 보는 중에는 확정 전의 줄을 내보내지 않는다. 번역은 줄이 확정된 뒤에 나오므로,
 * 원문 중간 결과까지 그리면 한 화면에서 두 언어가 번갈아 깜빡인다.
 * 말하는 언어와 자막 언어가 같아 옮길 것이 없으면(translating=false) 말한 그대로 흘려보낸다.
 */
export function buildCaptionView(input: {
  finalText: string;
  translation: string;
  partial: string;
  translating: boolean;
}): { text: string; partial: string } {
  const { finalText, translation, partial, translating } = input;
  if (!translating) return { text: buildOverlayText(finalText, partial), partial };
  // 번역이 도착하기 전에는 원문이라도 보여 준다. 모델을 받는 동안 화면이 비지 않게.
  return { text: buildOverlayText(translation || finalText, ''), partial: '' };
}
