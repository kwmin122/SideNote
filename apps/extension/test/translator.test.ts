import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CaptionTranslator,
  prepareTranslator,
  splitForTranslation,
  translationNeeded,
  translatorAvailability,
  translatorSupported
} from '../src/transcription/translator';
import { CAPTION_LANGUAGES, TRANSLATION_TARGETS, normalizeTranslationTarget, translationSourceOf } from '../src/shared/languages';
import { lineToText, transcriptToText } from '../src/shared/transcripts';
import type { TranscriptSegment } from '../src/shared/contracts';

const g = globalThis as any;

function installTranslator(options: {
  availability?: string;
  translate?: (text: string) => Promise<string>;
  createFails?: boolean;
} = {}) {
  const destroy = vi.fn();
  const translate = options.translate ?? (async (text: string) => `[번역] ${text}`);
  const create = vi.fn(async () => {
    if (options.createFails) throw new DOMException('needs a user gesture', 'NotAllowedError');
    return { translate, destroy };
  });
  g.Translator = {
    availability: vi.fn(async () => options.availability ?? 'available'),
    create
  };
  return { create, destroy };
}

afterEach(() => {
  delete g.Translator;
  vi.restoreAllMocks();
});

describe('언어 코드', () => {
  it('자막 언어마다 번역기 코드가 붙어 있다', () => {
    for (const item of CAPTION_LANGUAGES) expect(item.translate).toBeTruthy();
  });

  it('중국어는 앞부분을 자르지 않고 따로 적어 둔 코드를 쓴다', () => {
    expect(translationSourceOf('cmn-Hans-CN')).toBe('zh');
    expect(translationSourceOf('cmn-Hant-TW')).toBe('zh-Hant');
    expect(translationSourceOf('ko-KR')).toBe('ko');
  });

  it('모르는 태그는 앞부분만 잘라 쓴다', () => {
    expect(translationSourceOf('cs-CZ')).toBe('cs');
  });

  it('번역 대상 목록에 없는 값은 번역 안 함으로 되돌린다', () => {
    expect(normalizeTranslationTarget('ko')).toBe('ko');
    expect(normalizeTranslationTarget('없는코드')).toBe('');
    expect(normalizeTranslationTarget(undefined)).toBe('');
  });

  it('번역 대상은 모두 자막 언어로도 만들 수 있는 언어다', () => {
    const sources = new Set(CAPTION_LANGUAGES.map((l) => l.translate));
    for (const target of TRANSLATION_TARGETS) expect(sources.has(target.code)).toBe(true);
  });

  it('같은 언어로는 번역하지 않는다', () => {
    expect(translationNeeded('en', 'en')).toBe(false);
    expect(translationNeeded('en', '')).toBe(false);
    expect(translationNeeded('en', 'ko')).toBe(true);
  });
});

describe('번역기가 없는 Chrome', () => {
  it('지원하지 않는다고 답하고 번역은 빈 문자열이다', async () => {
    expect(translatorSupported()).toBe(false);
    expect(await translatorAvailability('en', 'ko')).toBe('unsupported');
    expect(await new CaptionTranslator('en', 'ko').translate('hello')).toBe('');
  });
});

describe('CaptionTranslator', () => {
  it('정상 경로에서는 옮긴 문장을 돌려준다', async () => {
    const { create } = installTranslator();
    const translator = new CaptionTranslator('en', 'ko');
    expect(await translator.translate('hello')).toBe('[번역] hello');
    expect(create).toHaveBeenCalledWith({ sourceLanguage: 'en', targetLanguage: 'ko' });
  });

  it('인스턴스를 한 번만 만든다', async () => {
    const { create } = installTranslator();
    const translator = new CaptionTranslator('en', 'ko');
    await translator.translate('one');
    await translator.translate('two');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('만들기에 실패해도 예외를 던지지 않고, 잠시 동안 다시 만들지 않는다', async () => {
    const { create } = installTranslator({ createFails: true });
    const translator = new CaptionTranslator('en', 'ko');
    expect(await translator.translate('hello')).toBe('');
    expect(await translator.translate('hello')).toBe('');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('번역 중 오류가 나면 빈 문자열을 주고 인스턴스를 버린다', async () => {
    const translate = vi.fn(async () => {
      throw new Error('model gone');
    });
    const { destroy } = installTranslator({ translate });
    const translator = new CaptionTranslator('en', 'ko');
    expect(await translator.translate('hello')).toBe('');
    expect(destroy).toHaveBeenCalled();
  });

  it('닫은 뒤에는 다시 만들지 않는다', async () => {
    const { create } = installTranslator();
    const translator = new CaptionTranslator('en', 'ko');
    await translator.translate('hello');
    translator.destroy();
    expect(await translator.translate('again')).toBe('');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('빈 줄은 번역기를 부르지 않는다', async () => {
    const { create } = installTranslator();
    expect(await new CaptionTranslator('en', 'ko').translate('   ')).toBe('');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('prepareTranslator (사용자 클릭 안에서 부른다)', () => {
  it('이미 준비된 조합이면 모델을 만들지 않는다', async () => {
    const { create } = installTranslator({ availability: 'available' });
    expect(await prepareTranslator('en', 'ko')).toBe('available');
    expect(create).not.toHaveBeenCalled();
  });

  it('내려받을 수 있으면 만들어서 내려받기를 시작하고 곧바로 닫는다', async () => {
    const { create, destroy } = installTranslator({ availability: 'downloadable' });
    expect(await prepareTranslator('en', 'ko')).toBe('available');
    expect(create).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalled();
  });

  it('지원하지 않는 조합이면 만들지 않는다', async () => {
    const { create } = installTranslator({ availability: 'unavailable' });
    expect(await prepareTranslator('en', 'ko')).toBe('unavailable');
    expect(create).not.toHaveBeenCalled();
  });

  it('같은 언어면 아무것도 하지 않는다', async () => {
    const { create } = installTranslator();
    expect(await prepareTranslator('ko', 'ko')).toBe('unsupported');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('번역문이 붙은 자막 글자', () => {
  const line = (over: Partial<TranscriptSegment>): TranscriptSegment => ({
    id: 'x',
    sessionId: 's',
    sequence: 1,
    text: 'hello there',
    startedAtMs: 0,
    endedAtMs: 1,
    createdAt: 0,
    status: 'FINAL',
    ...over
  });

  it('번역이 있으면 원문 아래 줄에 붙인다', () => {
    expect(lineToText(line({ translation: '안녕하세요' }))).toBe('hello there\n안녕하세요');
  });

  it('번역이 없으면 원문만 남는다', () => {
    expect(lineToText(line({}))).toBe('hello there');
  });

  it('전체 복사에도 번역이 함께 담긴다', () => {
    const list = [line({ sequence: 1, translation: '안녕하세요' }), line({ id: 'y', sequence: 2, text: 'bye' })];
    expect(transcriptToText(list)).toBe('hello there\n안녕하세요\nbye');
  });
});

/** 실제로 문제가 됐던 모양: 쉬지 않고 말해서 구두점 없이 한 덩어리로 확정된 줄. */
const RUN_ON =
  'So Jeffrey Hinton British Canadian computer scientist as you know Nobel Prize winner known for ' +
  'his work on AI which earned him the title The Godfather of AI and I know they all say that but ' +
  'he actually is the Godfather I asked him whether he thinks there is a greater than 10 chance ' +
  'that AI could kill all humans potentially within a decade';

describe('번역 조각 나누기', () => {
  it('짧은 줄은 자르지 않는다', () => {
    expect(splitForTranslation('hello there')).toEqual(['hello there']);
  });

  it('문장 부호가 있으면 문장 단위로 끊는다', () => {
    expect(splitForTranslation('First one. Second one! Third one?', 20)).toEqual([
      'First one.',
      'Second one!',
      'Third one?'
    ]);
  });

  it('구두점 없이 길게 이어진 받아쓰기도 단어 경계로 끊는다', () => {
    const chunks = splitForTranslation(RUN_ON);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(140);
    // 단어가 쪼개지거나 사라지면 안 된다.
    expect(chunks.join(' ').split(/\s+/)).toEqual(RUN_ON.split(/\s+/));
  });

  it('공백이 없는 언어는 길이로 끊는다', () => {
    const chunks = splitForTranslation('가'.repeat(50), 20);
    expect(chunks).toEqual(['가'.repeat(20), '가'.repeat(20), '가'.repeat(10)]);
  });

  it('빈 줄은 조각이 없다', () => {
    expect(splitForTranslation('   ')).toEqual([]);
  });
});

describe('진행 중인 줄 번역 (자막이 확정되기 전에 흘려보내기)', () => {
  it('긴 줄은 조각으로 나눠 넘긴다. 통째로 넘기면 번역기가 뒤를 흘린다', async () => {
    const translate = vi.fn(async (text: string) => `[${text}]`);
    installTranslator({ translate });
    const translator = new CaptionTranslator('en', 'ko');
    const out = await translator.translate(RUN_ON);
    expect(translate.mock.calls.length).toBe(splitForTranslation(RUN_ON).length);
    expect(out).toContain('Jeffrey Hinton');
    expect(out).toContain('within a decade');
  });

  it('말이 길어져도 이미 번역한 앞 조각은 다시 번역하지 않는다', async () => {
    const translate = vi.fn(async (text: string) => `[${text}]`);
    installTranslator({ translate });
    const translator = new CaptionTranslator('en', 'ko');

    await translator.translate(RUN_ON);
    const first = translate.mock.calls.length;
    // 인식이 계속되면서 뒤에 말이 더 붙은 상태
    await translator.translate(`${RUN_ON} and that is why he left Google`);
    const added = translate.mock.calls.length - first;

    expect(first).toBeGreaterThan(1);
    expect(added).toBe(1);
  });

  it('같은 줄을 다시 번역해 달라고 하면 번역기를 부르지 않는다', async () => {
    const translate = vi.fn(async (text: string) => `[${text}]`);
    installTranslator({ translate });
    const translator = new CaptionTranslator('en', 'ko');
    await translator.translate('hello there');
    await translator.translate('hello there');
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('조각 하나가 실패하면 반쪽짜리 번역을 남기지 않는다', async () => {
    let calls = 0;
    const translate = vi.fn(async (text: string) => {
      calls += 1;
      if (calls > 1) throw new Error('model gone');
      return `[${text}]`;
    });
    installTranslator({ translate });
    const translator = new CaptionTranslator('en', 'ko');
    expect(await translator.translate(RUN_ON)).toBe('');
  });
});
