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
