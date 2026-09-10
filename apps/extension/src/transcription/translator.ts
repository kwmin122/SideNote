/**
 * Chrome 내장 번역기(Translator API, Chrome 138+).
 *
 * 번역 모델이 이 컴퓨터 안에서 돌아간다. API 키도, 호출당 과금도, 켜 둘 서버도 없다.
 * 처음 쓰는 언어 조합은 Chrome 이 모델을 내려받는데, 그동안에는 번역이 비고 자막은 원문 그대로 나간다.
 * 기기·언어 조합에 따라 아예 지원하지 않을 수도 있어서, 없으면 조용히 번역만 빠진다.
 */

export type TranslatorAvailability = 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface TranslatorInstance {
  translate(text: string): Promise<string>;
  destroy?(): void;
}

interface TranslatorPair {
  sourceLanguage: string;
  targetLanguage: string;
}

interface TranslatorFactory {
  availability(pair: TranslatorPair): Promise<string>;
  create(pair: TranslatorPair): Promise<TranslatorInstance>;
}

function factory(): TranslatorFactory | undefined {
  return (globalThis as { Translator?: TranslatorFactory }).Translator;
}

/** 이 Chrome 에 번역기가 있는가. 없으면 번역 기능 자체를 화면에서 감춘다. */
export function translatorSupported(): boolean {
  return typeof factory()?.create === 'function';
}

/** 번역할 필요가 없는 조합(끔, 같은 언어)인지. */
export function translationNeeded(source: string, target: string): boolean {
  return Boolean(target) && Boolean(source) && source !== target;
}

export async function translatorAvailability(source: string, target: string): Promise<TranslatorAvailability> {
  const api = factory();
  if (!api) return 'unsupported';
  if (!translationNeeded(source, target)) return 'unavailable';
  try {
    const value = await api.availability({ sourceLanguage: source, targetLanguage: target });
    if (value === 'available' || value === 'downloadable' || value === 'downloading') return value;
    return 'unavailable';
  } catch {
    return 'unsupported';
  }
}

/**
 * 번역 모델 내려받기를 시작한다. **사용자 클릭 안에서** 불러야 한다.
 * 오프스크린 문서에는 사용자 제스처가 없어 거기서 create() 를 부르면 NotAllowedError 가 난다.
 * 음성 언어팩과 똑같은 제약이라, 사이드패널 버튼에서 미리 한 번 깨워 둔다.
 */
export async function prepareTranslator(source: string, target: string): Promise<TranslatorAvailability> {
  const api = factory();
  if (!api || !translationNeeded(source, target)) return 'unsupported';
  const state = await translatorAvailability(source, target);
  if (state === 'unsupported' || state === 'unavailable') return state;
  if (state === 'available') return state;
  try {
    const instance = await api.create({ sourceLanguage: source, targetLanguage: target });
    instance.destroy?.();
    return 'available';
  } catch {
    // 내려받는 중이거나 제스처가 모자란 경우. 자막은 원문으로 계속 나가고 다음 기회에 다시 시도한다.
    return 'downloading';
  }
}

/** 만들기에 실패한 뒤 다시 시도하기까지 기다리는 시간. 모델을 내려받는 동안 계속 두드리지 않는다. */
const RETRY_DELAY_MS = 10_000;

/** 번역기에 한 번에 넘길 최대 글자 수. */
const CHUNK_CHARS = 140;

/**
 * 번역기에 넘길 조각으로 자른다. 문장 끝이 있으면 문장 단위로, 없으면 단어 경계로 끊는다.
 *
 * 두 가지 때문에 자른다.
 * 1) 받아쓰기는 구두점 없이 몇백 글자짜리 한 덩어리로 확정되는 일이 흔한데, 그대로 넘기면
 *    번역기가 뒷부분을 통째로 흘린다.
 * 2) 진행 중인 줄은 뒤로 계속 길어진다. 앞 조각이 그대로 유지되므로 캐시가 받아 주고,
 *    새로 번역할 것은 마지막 조각뿐이 된다.
 */
export function splitForTranslation(text: string, limit = CHUNK_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const sentences = trimmed.match(/[^.!?。！？…]+(?:[.!?。！？…]+|$)/g) ?? [trimmed];
  const chunks: string[] = [];
  for (const raw of sentences) {
    let rest = raw.trim();
    if (!rest) continue;
    while (rest.length > limit) {
      // 단어 중간에서 자르면 그 단어가 양쪽에서 다 깨진다. 공백이 너무 앞이면 그냥 길이로 자른다.
      const space = rest.lastIndexOf(' ', limit);
      const at = space > limit / 2 ? space : limit;
      chunks.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) chunks.push(rest);
  }
  return chunks.filter(Boolean);
}

/** 조각별 번역을 기억해 두는 최대 개수. 진행 중인 줄을 반복해서 번역하지 않기 위한 것이다. */
const CACHE_MAX = 200;

/**
 * 자막 한 줄씩 번역한다. 실패는 전부 빈 문자열로 돌려준다 —
 * 번역이 안 되는 것이 자막이 끊기는 이유가 되어서는 안 된다.
 */
export class CaptionTranslator {
  private instance?: TranslatorInstance;
  private creating?: Promise<void>;
  private nextTryAt = 0;
  private closed = false;
  /** 조각 → 번역. 같은 조각을 두 번 번역하지 않는다. */
  private readonly cache = new Map<string, string>();

  constructor(
    readonly source: string,
    readonly target: string
  ) {}

  private async ensure(): Promise<void> {
    if (this.closed || this.instance) return;
    if (!translatorSupported() || !translationNeeded(this.source, this.target)) return;
    if (Date.now() < this.nextTryAt) return;
    if (!this.creating) {
      this.creating = factory()!
        .create({ sourceLanguage: this.source, targetLanguage: this.target })
        .then((instance) => {
          this.instance = instance;
        })
        .catch(() => {
          this.nextTryAt = Date.now() + RETRY_DELAY_MS;
        })
        .finally(() => {
          this.creating = undefined;
        });
    }
    await this.creating;
  }

  private remember(chunk: string, translation: string) {
    this.cache.set(chunk, translation);
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  async translate(text: string): Promise<string> {
    const trimmed = text.trim();
    if (!trimmed) return '';
    await this.ensure();
    if (!this.instance) return '';
    const parts: string[] = [];
    for (const chunk of splitForTranslation(trimmed)) {
      const known = this.cache.get(chunk);
      if (known !== undefined) {
        parts.push(known);
        continue;
      }
      if (this.closed || !this.instance) return '';
      try {
        const translated = (await this.instance.translate(chunk)).trim();
        this.remember(chunk, translated);
        parts.push(translated);
      } catch {
        // 모델이 내려가거나 조합이 막히면 인스턴스를 버리고 잠시 뒤 다시 만든다.
        // 반쪽짜리 번역을 남기느니 통째로 비운다. 그래야 원문 자막이 그대로 보인다.
        this.instance?.destroy?.();
        this.instance = undefined;
        this.nextTryAt = Date.now() + RETRY_DELAY_MS;
        return '';
      }
    }
    return parts.join(' ').trim();
  }

  destroy(): void {
    this.closed = true;
    this.cache.clear();
    this.instance?.destroy?.();
    this.instance = undefined;
  }
}
