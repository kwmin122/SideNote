/**
 * 자막(음성 인식) 언어 목록.
 *
 * 확장 UI 언어와는 별개다. UI 가 한국어라도 영어 강의를 들을 수 있어야 한다.
 * Chrome 은 기기 내 인식이 가능한 언어를 열거하는 API 를 주지 않는다. 그래서 흔히 쓰는 언어를 적어 두고,
 * 실제로 쓸 수 있는지는 시작할 때 SpeechRecognition.available() 로 확인한다(없으면 언어팩을 받는다).
 * 이름은 그 언어 화자가 읽는 이름 그대로 둔다. UI 언어가 무엇이든 자기 언어를 찾을 수 있어야 하기 때문이다.
 */
import type { CaptionMode } from './contracts';

/** 화면에 보여 줄 순서. 사이드패널의 라디오 버튼이 이 순서를 그대로 쓴다. */
export const CAPTION_MODES: readonly CaptionMode[] = ['original', 'translated', 'both'];

export interface CaptionLanguage {
  /** BCP-47 태그. SpeechRecognition.lang 에 그대로 넣는다. */
  code: string;
  label: string;
  /**
   * Chrome 번역기(Translator API)에 넘길 언어 코드.
   * 음성 태그와 규칙이 달라서(cmn-Hans-CN → zh) 앞부분을 잘라 쓰지 않고 하나씩 적어 둔다.
   */
  translate: string;
}

export const CAPTION_LANGUAGES: readonly CaptionLanguage[] = [
  { code: 'en-US', label: 'English (US)', translate: 'en' },
  { code: 'en-GB', label: 'English (UK)', translate: 'en' },
  { code: 'ko-KR', label: '한국어', translate: 'ko' },
  { code: 'ja-JP', label: '日本語', translate: 'ja' },
  { code: 'cmn-Hans-CN', label: '中文 (简体)', translate: 'zh' },
  { code: 'cmn-Hant-TW', label: '中文 (繁體)', translate: 'zh-Hant' },
  { code: 'es-ES', label: 'Español (España)', translate: 'es' },
  { code: 'es-US', label: 'Español (América)', translate: 'es' },
  { code: 'fr-FR', label: 'Français', translate: 'fr' },
  { code: 'de-DE', label: 'Deutsch', translate: 'de' },
  { code: 'it-IT', label: 'Italiano', translate: 'it' },
  { code: 'pt-BR', label: 'Português (Brasil)', translate: 'pt' },
  { code: 'ru-RU', label: 'Русский', translate: 'ru' },
  { code: 'hi-IN', label: 'हिन्दी', translate: 'hi' },
  { code: 'ar-EG', label: 'العربية', translate: 'ar' },
  { code: 'id-ID', label: 'Bahasa Indonesia', translate: 'id' },
  { code: 'vi-VN', label: 'Tiếng Việt', translate: 'vi' },
  { code: 'th-TH', label: 'ไทย', translate: 'th' },
  { code: 'tr-TR', label: 'Türkçe', translate: 'tr' },
  { code: 'nl-NL', label: 'Nederlands', translate: 'nl' },
  { code: 'pl-PL', label: 'Polski', translate: 'pl' },
  { code: 'sv-SE', label: 'Svenska', translate: 'sv' }
];

/**
 * 번역해서 볼 수 있는 언어. 자막 언어와 달리 지역 구분이 없다(번역기는 언어 단위로 동작한다).
 * '' 은 번역하지 않음이다.
 */
export interface TranslationTarget {
  code: string;
  label: string;
}

export const TRANSLATION_TARGETS: readonly TranslationTarget[] = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文 (简体)' },
  { code: 'zh-Hant', label: '中文 (繁體)' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ar', label: 'العربية' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'th', label: 'ไทย' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'sv', label: 'Svenska' }
];

const FALLBACK = 'en-US';

/**
 * 브라우저 UI 언어에 가장 가까운 자막 언어를 고른다.
 * 'ko' → ko-KR 처럼 지역이 없는 값도 받아야 해서, 정확히 같은 태그 → 같은 언어 → en-US 순으로 본다.
 */
export function defaultCaptionLanguage(uiLang: string): string {
  const want = (uiLang || '').toLowerCase();
  if (!want) return FALLBACK;
  const exact = CAPTION_LANGUAGES.find((l) => l.code.toLowerCase() === want);
  if (exact) return exact.code;
  const base = want.split('-')[0];
  const sameLanguage = CAPTION_LANGUAGES.find((l) => l.code.toLowerCase().split('-')[0] === base);
  return sameLanguage?.code ?? FALLBACK;
}

/** 저장된 값이 목록에 없으면(예전 값, 손상된 값) 기본값으로 되돌린다. */
export function normalizeCaptionLanguage(value: unknown, uiLang: string): string {
  if (typeof value === 'string' && CAPTION_LANGUAGES.some((l) => l.code === value)) return value;
  return defaultCaptionLanguage(uiLang);
}

/** 자막 언어 태그 → 번역기 언어 코드. 목록에 없으면 앞부분만 잘라 쓴다. */
export function translationSourceOf(captionCode: string): string {
  const found = CAPTION_LANGUAGES.find((l) => l.code === captionCode);
  return found?.translate ?? (captionCode || '').split('-')[0];
}

/** 저장된 번역 대상이 목록에 없으면 '번역 안 함'으로 되돌린다. */
export function normalizeTranslationTarget(value: unknown): string {
  if (typeof value === 'string' && TRANSLATION_TARGETS.some((l) => l.code === value)) return value;
  return '';
}

/** 저장된 자막 모드가 목록에 없으면(예전 값) 원문으로 되돌린다. */
export function normalizeCaptionMode(value: unknown): CaptionMode {
  return CAPTION_MODES.includes(value as CaptionMode) ? (value as CaptionMode) : 'original';
}

/**
 * 번역을 처음 켰을 때 고를 언어.
 * 대개 자기가 읽는 언어로 옮겨 보므로 브라우저 UI 언어를 따르고,
 * 그게 말하는 언어와 같으면(한국어 강의를 한국어로 옮길 일은 없다) 영어로, 영어면 한국어로 간다.
 */
export function defaultTranslationTarget(uiLang: string, source: string): string {
  const want = (uiLang || '').toLowerCase();
  const base = want.split('-')[0];
  const exact = TRANSLATION_TARGETS.find((l) => l.code.toLowerCase() === want);
  const sameLanguage = TRANSLATION_TARGETS.find((l) => l.code.toLowerCase().split('-')[0] === base);
  const guess = exact?.code ?? sameLanguage?.code ?? 'en';
  if (guess !== source) return guess;
  return source === 'en' ? 'ko' : 'en';
}
