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

/**
 * 자막 한 줄씩 번역한다. 실패는 전부 빈 문자열로 돌려준다 —
 * 번역이 안 되는 것이 자막이 끊기는 이유가 되어서는 안 된다.
 */
export class CaptionTranslator {
  private instance?: TranslatorInstance;
  private creating?: Promise<void>;
  private nextTryAt = 0;
  private closed = false;

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

  async translate(text: string): Promise<string> {
    const trimmed = text.trim();
    if (!trimmed) return '';
    await this.ensure();
    if (!this.instance) return '';
    try {
      return (await this.instance.translate(trimmed)).trim();
    } catch {
      // 모델이 내려가거나 조합이 막히면 인스턴스를 버리고 잠시 뒤 다시 만든다.
      this.instance?.destroy?.();
      this.instance = undefined;
      this.nextTryAt = Date.now() + RETRY_DELAY_MS;
      return '';
    }
  }

  destroy(): void {
    this.closed = true;
    this.instance?.destroy?.();
    this.instance = undefined;
  }
}
