/**
 * 자막(음성 인식) 언어 목록.
 *
 * 확장 UI 언어와는 별개다. UI 가 한국어라도 영어 강의를 들을 수 있어야 한다.
 * Chrome 은 기기 내 인식이 가능한 언어를 열거하는 API 를 주지 않는다. 그래서 흔히 쓰는 언어를 적어 두고,
 * 실제로 쓸 수 있는지는 시작할 때 SpeechRecognition.available() 로 확인한다(없으면 언어팩을 받는다).
 * 이름은 그 언어 화자가 읽는 이름 그대로 둔다. UI 언어가 무엇이든 자기 언어를 찾을 수 있어야 하기 때문이다.
 */
export interface CaptionLanguage {
  /** BCP-47 태그. SpeechRecognition.lang 에 그대로 넣는다. */
  code: string;
  label: string;
}

export const CAPTION_LANGUAGES: readonly CaptionLanguage[] = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'ko-KR', label: '한국어' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'cmn-Hans-CN', label: '中文 (简体)' },
  { code: 'cmn-Hant-TW', label: '中文 (繁體)' },
  { code: 'es-ES', label: 'Español (España)' },
  { code: 'es-US', label: 'Español (América)' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'it-IT', label: 'Italiano' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'ru-RU', label: 'Русский' },
  { code: 'hi-IN', label: 'हिन्दी' },
  { code: 'ar-EG', label: 'العربية' },
  { code: 'id-ID', label: 'Bahasa Indonesia' },
  { code: 'vi-VN', label: 'Tiếng Việt' },
  { code: 'th-TH', label: 'ไทย' },
  { code: 'tr-TR', label: 'Türkçe' },
  { code: 'nl-NL', label: 'Nederlands' },
  { code: 'pl-PL', label: 'Polski' },
  { code: 'sv-SE', label: 'Svenska' }
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
