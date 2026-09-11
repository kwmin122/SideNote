import { describe, expect, it } from 'vitest';
import {
  CAPTION_MODES,
  defaultTranslationTarget,
  normalizeCaptionMode,
  normalizeTranslationTarget,
  translationSourceOf
} from '../src/shared/languages';

describe('자막 모드 값 검증', () => {
  it('세 가지 모드를 화면 순서대로 준다', () => {
    expect(CAPTION_MODES).toEqual(['original', 'translated', 'both']);
  });

  it('저장된 값이 목록에 있으면 그대로 쓴다', () => {
    expect(normalizeCaptionMode('translated')).toBe('translated');
    expect(normalizeCaptionMode('both')).toBe('both');
  });

  it('예전 값이나 손상된 값은 원문으로 되돌린다', () => {
    expect(normalizeCaptionMode(undefined)).toBe('original');
    expect(normalizeCaptionMode('')).toBe('original');
    expect(normalizeCaptionMode('bilingual')).toBe('original');
    expect(normalizeCaptionMode(3)).toBe('original');
  });
});

describe('처음 번역을 켤 때 고르는 언어', () => {
  it('브라우저 언어로 옮겨 본다', () => {
    expect(defaultTranslationTarget('ko', 'en')).toBe('ko');
    expect(defaultTranslationTarget('ko-KR', 'en')).toBe('ko');
    expect(defaultTranslationTarget('ja', 'en')).toBe('ja');
  });

  it('말하는 언어와 같으면 다른 언어로 간다', () => {
    expect(defaultTranslationTarget('ko', 'ko')).toBe('en');
    expect(defaultTranslationTarget('en-US', 'en')).toBe('ko');
  });

  it('번역기가 모르는 브라우저 언어면 영어로 간다', () => {
    expect(defaultTranslationTarget('sw-KE', 'ko')).toBe('en');
  });

  it('고른 값은 언제나 번역 목록 안에 있다', () => {
    for (const ui of ['ko', 'en-GB', 'ja', 'zh-TW', 'xx']) {
      const picked = defaultTranslationTarget(ui, translationSourceOf('en-US'));
      expect(normalizeTranslationTarget(picked)).toBe(picked);
    }
  });
});
