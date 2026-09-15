import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UI_LANGUAGES, loadUiLanguage, normalizeUiLanguage, selectedUiLanguage, t, uiLanguage } from '../src/shared/i18n';

// chrome.runtime.getURL 이 파일 경로를 주므로, fetch 는 그 파일을 읽어 주기만 하면 된다.
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url: unknown) => ({
    json: async () => JSON.parse(readFileSync(String(url), 'utf-8'))
  })) as unknown as typeof fetch;
});

afterEach(async () => {
  await loadUiLanguage('');
  globalThis.fetch = realFetch;
});

describe('화면 언어 값 검증', () => {
  it('목록에 있는 언어는 그대로 쓴다', () => {
    expect(normalizeUiLanguage('ko')).toBe('ko');
    expect(normalizeUiLanguage('ja')).toBe('ja');
    expect(normalizeUiLanguage('zh-CN')).toBe('zh-CN');
  });

  it('지역 표기가 붙어도 같은 언어로 본다', () => {
    expect(normalizeUiLanguage('ko-KR')).toBe('ko');
    expect(normalizeUiLanguage('en-GB')).toBe('en');
  });

  it('모르는 값은 브라우저 언어 따르기(빈 값)로 둔다', () => {
    expect(normalizeUiLanguage('sw-KE')).toBe('');
    expect(normalizeUiLanguage(undefined)).toBe('');
    expect(normalizeUiLanguage(3)).toBe('');
  });

  it('목록 맨 앞은 브라우저 언어 따르기다', () => {
    expect(UI_LANGUAGES[0].code).toBe('');
    expect(UI_LANGUAGES.map((item) => item.code)).toContain('zh-CN');
  });
});

describe('고른 화면 언어로 글자 바꾸기', () => {
  it('고르기 전에는 브라우저 언어(chrome.i18n)를 쓴다', () => {
    expect(selectedUiLanguage()).toBe('');
    expect(uiLanguage()).toBe('en-US');
    expect(t('uiStartCaption')).toBe('Start captions');
  });

  it('고른 언어의 messages.json 을 읽어 화면 글자를 바꾼다', async () => {
    expect(await loadUiLanguage('ja')).toBe('ja');
    expect(t('uiStartCaption')).toBe('字幕を開始');
    expect(uiLanguage()).toBe('ja');
  });

  it('폴더 이름이 다른 언어(zh-CN → zh_CN)도 찾아 읽는다', async () => {
    expect(await loadUiLanguage('zh-CN')).toBe('zh-CN');
    expect(t('uiStartCaption')).toBe('开始字幕');
  });

  it('자리표시자에 값을 끼워 넣는다', async () => {
    await loadUiLanguage('ko');
    expect(t('uiCopiedTranscriptLines', 12)).toBe('자막 12줄을 복사했습니다.');
    expect(t('exportSummary', 1, 2, 3)).toBe('캡처 1장 · 메모 2개 · 자막 3줄');
  });

  it('빈 값을 주면 브라우저 언어로 되돌아간다', async () => {
    await loadUiLanguage('ja');
    expect(await loadUiLanguage('')).toBe('');
    expect(t('uiStartCaption')).toBe('Start captions');
  });

  it('파일을 못 읽으면 브라우저 언어를 그대로 쓴다', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await loadUiLanguage('ja')).toBe('');
    expect(t('uiStartCaption')).toBe('Start captions');
  });

  it('없는 키는 키 이름을 그대로 돌려준다', async () => {
    await loadUiLanguage('ja');
    expect(t('uiNoSuchKey')).toBe('uiNoSuchKey');
  });
});

describe('언어 파일 짝 맞추기', () => {
  const LOCALES = ['en', 'ko', 'ja', 'zh_CN'];
  const tables = Object.fromEntries(
    LOCALES.map((locale) => [
      locale,
      JSON.parse(readFileSync(`public/_locales/${locale}/messages.json`, 'utf-8')) as Record<
        string,
        { message: string; placeholders?: Record<string, { content?: string }> }
      >
    ])
  );

  it('네 언어가 모두 같은 키를 가진다', () => {
    const base = Object.keys(tables.en).sort();
    for (const locale of LOCALES) {
      expect({ locale, keys: Object.keys(tables[locale]).sort() }).toEqual({ locale, keys: base });
    }
  });

  it('빈 문구가 없다', () => {
    for (const locale of LOCALES) {
      for (const [key, entry] of Object.entries(tables[locale])) {
        expect(`${locale}.${key}=${entry.message.trim()}`).not.toMatch(/=$/);
      }
    }
  });

  it('자리표시자 개수가 언어마다 같다 (번역하다 $p2$ 를 빠뜨리면 화면에 빈칸이 남는다)', () => {
    for (const key of Object.keys(tables.en)) {
      const want = Object.keys(tables.en[key].placeholders ?? {}).length;
      for (const locale of LOCALES) {
        const entry = tables[locale][key];
        expect(`${locale}.${key}:${Object.keys(entry.placeholders ?? {}).length}`).toBe(`${locale}.${key}:${want}`);
        for (let i = 1; i <= want; i += 1) {
          expect(`${locale}.${key} has $p${i}$: ${entry.message.includes(`$p${i}$`)}`).toBe(
            `${locale}.${key} has $p${i}$: true`
          );
        }
      }
    }
  });
});
