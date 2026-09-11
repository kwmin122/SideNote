import { describe, expect, it } from 'vitest';
import {
  CAPTION_LANGUAGES,
  TRANSLATION_TARGETS,
  defaultTranslationTarget,
  normalizeTranslationTarget,
  translationSourceOf
} from '../src/shared/languages';

describe('자막 언어 기본값', () => {
  it('브라우저 언어로 옮겨 본다', () => {
    expect(defaultTranslationTarget('ko')).toBe('ko');
    expect(defaultTranslationTarget('ko-KR')).toBe('ko');
    expect(defaultTranslationTarget('ja')).toBe('ja');
  });

  it('번역기가 모르는 브라우저 언어면 영어로 간다', () => {
    expect(defaultTranslationTarget('sw-KE')).toBe('en');
    expect(defaultTranslationTarget('')).toBe('en');
  });

  it('고른 값은 언제나 자막 언어 목록 안에 있다', () => {
    for (const ui of ['ko', 'en-GB', 'ja', 'zh-TW', 'xx']) {
      const picked = defaultTranslationTarget(ui);
      expect(normalizeTranslationTarget(picked)).toBe(picked);
    }
  });
});

describe('자막 언어 값 검증', () => {
  it('목록에 없는 값은 빈 값으로 돌린다', () => {
    expect(normalizeTranslationTarget('kr')).toBe('');
    expect(normalizeTranslationTarget(undefined)).toBe('');
    expect(normalizeTranslationTarget(7)).toBe('');
  });

  it('말하는 언어는 전부 자막 언어로도 고를 수 있다', () => {
    // 말하는 언어와 자막 언어를 같게 고르면 옮기지 않고 말한 그대로 보여 준다.
    // 그 조합이 되려면 음성 언어의 번역 코드가 자막 언어 목록에 있어야 한다.
    const targets = new Set(TRANSLATION_TARGETS.map((item) => item.code));
    for (const item of CAPTION_LANGUAGES) {
      expect(targets.has(translationSourceOf(item.code))).toBe(true);
    }
  });
});
