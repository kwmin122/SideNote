/** 비교용 정규화: 공백·구두점 제거 후 소문자화. Whisper 는 같은 말을 조금씩 다르게 적는다. */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s]+/g, '')
    .replace(/[.,!?;:~"'`·…‥「」『』（）()[\]{}<>\-—]/g, '');
}

export function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

const MAX_OVERLAP_TOKENS = 24;
/** 글자 단위 중복 비교 범위. 너무 짧게 잡으면 정상적인 반복까지 지운다. */
const MIN_OVERLAP_CHARS = 6;
const MAX_OVERLAP_CHARS = 60;

/** 정규화 기준 앞 normCount 글자를 원문에서 잘라낸다(공백·구두점은 세지 않는다). */
function sliceAfterNormalized(text: string, normCount: number): string {
  let consumed = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (normalizeForCompare(text[i])) consumed += 1;
    if (consumed >= normCount) return text.slice(i + 1).trim();
  }
  return '';
}

/**
 * window 가 겹치는 만큼 앞부분이 직전 자막과 중복된다.
 * 직전 자막의 "끝 k토큰"과 새 자막의 "앞 k토큰"이 같으면 그만큼 잘라낸다.
 * Whisper 가 같은 구간을 다르게 적는 경우가 많아 완벽하진 않지만, 눈에 띄는 반복을 대부분 없앤다.
 */
export function dedupAgainstPrevious(previous: string, incoming: string): string {
  const next = incoming.trim();
  if (!next) return '';
  const prev = previous.trim();
  if (!prev) return next;

  const normPrev = normalizeForCompare(prev);
  const normNext = normalizeForCompare(next);
  if (!normNext) return '';
  // 새 자막이 직전 자막에 통째로 들어있으면 완전 중복이다.
  if (normPrev.includes(normNext)) return '';

  const prevTokens = tokenize(prev);
  const nextTokens = tokenize(next);
  const max = Math.min(MAX_OVERLAP_TOKENS, prevTokens.length, nextTokens.length);
  for (let k = max; k > 0; k -= 1) {
    const tail = normalizeForCompare(prevTokens.slice(prevTokens.length - k).join(' '));
    const head = normalizeForCompare(nextTokens.slice(0, k).join(' '));
    if (tail && tail === head) {
      const rest = nextTokens.slice(k).join(' ').trim();
      return rest;
    }
  }

  // window 경계에서 단어가 잘리면 토큰이 어긋나 위 비교가 실패한다.
  // 글자 단위로 "직전의 끝 == 새 자막의 앞"을 찾아 한 번 더 걸러낸다.
  const maxChars = Math.min(normPrev.length, normNext.length, MAX_OVERLAP_CHARS);
  for (let k = maxChars; k >= MIN_OVERLAP_CHARS; k -= 1) {
    if (normPrev.endsWith(normNext.slice(0, k))) return sliceAfterNormalized(next, k);
  }
  return next;
}

const NON_SPEECH = /^[\s]*[（(\[【][^)\]】]*[)\]】）][\s]*$/;

/** 음악/박수 같은 비음성 토큰과 빈 문자열을 걸러낸다. */
export function isUsableTranscript(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (NON_SPEECH.test(trimmed)) return false;
  return /[\p{L}\p{N}]/u.test(trimmed);
}
