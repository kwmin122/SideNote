/**
 * 화면에 보이는 글자는 전부 여기를 거친다. 실제 문구는 public/_locales/<언어>/messages.json 에 있다.
 *
 * 평소에는 Chrome 이 브라우저 UI 언어에 맞는 파일을 골라 주고, 없는 언어는 manifest 의 default_locale(en)로 떨어진다.
 * 사용자가 화면에서 언어를 직접 고르면 chrome.i18n 을 다시 가리킬 방법이 없으므로,
 * 그 언어의 messages.json 을 직접 읽어 와 아래 표에 얹고 t() 가 그 표를 먼저 본다.
 */

/** 화면에서 고를 수 있는 UI 언어. ''(빈 값)은 브라우저 언어를 그대로 따른다는 뜻이다. */
export const UI_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: '', label: 'Auto' },
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
  { code: 'ja', label: '日本語' },
  { code: 'zh-CN', label: '中文(简体)' }
];

/** messages.json 한 줄의 모양. placeholders 는 $p1$ 같은 자리표시자를 $1 번째 인자에 묶어 준다. */
interface RawMessage {
  message: string;
  placeholders?: Record<string, { content?: string }>;
}

let overrideTable: Record<string, RawMessage> | undefined;
let overrideLang = '';

/** 고른 값이 지원 목록에 있으면 그 코드로, 아니면 ''(브라우저 언어 따르기)로 돌려준다. */
export function normalizeUiLanguage(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const want = value.toLowerCase();
  const base = want.split('-')[0];
  const exact = UI_LANGUAGES.find((item) => item.code && item.code.toLowerCase() === want);
  const sameLanguage = UI_LANGUAGES.find((item) => item.code && item.code.toLowerCase().split('-')[0] === base);
  return exact?.code ?? sameLanguage?.code ?? '';
}

/** BCP-47 코드를 _locales 폴더 이름으로 바꾼다. zh-CN → zh_CN. */
function localeFolder(code: string): string {
  return code.replace('-', '_');
}

function render(entry: RawMessage, subs: string[]): string {
  let out = entry.message;
  for (const [name, def] of Object.entries(entry.placeholders ?? {})) {
    const index = Number(String(def?.content ?? '').replace('$', '')) - 1;
    const value = Number.isInteger(index) && index >= 0 ? (subs[index] ?? '') : '';
    out = out.split(`$${name}$`).join(value);
  }
  return out;
}

export function t(key: string, ...subs: Array<string | number>): string {
  const list = subs.map(String);
  const entry = overrideTable?.[key];
  if (entry) return render(entry, list) || key;
  const api = (globalThis as { chrome?: typeof chrome }).chrome?.i18n;
  const message = api?.getMessage?.(key, list);
  // 키를 그대로 돌려주면 화면에서 바로 눈에 띈다. 빈 문자열로 조용히 사라지는 것보다 낫다.
  return message || key;
}

/**
 * 고른 언어의 문구 표를 읽어 온다. ''(브라우저 언어 따르기)이거나 읽기에 실패하면
 * 표를 비워서 chrome.i18n 이 고르던 언어로 되돌아간다. 실패해도 화면은 그대로 뜬다.
 */
export async function loadUiLanguage(code: string): Promise<string> {
  const wanted = normalizeUiLanguage(code);
  if (!wanted) {
    overrideTable = undefined;
    overrideLang = '';
    return '';
  }
  try {
    const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
    const url = runtime?.getURL?.(`_locales/${localeFolder(wanted)}/messages.json`);
    if (!url) throw new Error('no runtime');
    const res = await fetch(url);
    const table = (await res.json()) as Record<string, RawMessage>;
    if (!table || typeof table !== 'object') throw new Error('bad table');
    overrideTable = table;
    overrideLang = wanted;
  } catch {
    overrideTable = undefined;
    overrideLang = '';
  }
  return overrideLang;
}

/** 저장해 둔 UI 언어를 적용한다. 패널·백그라운드·오프스크린이 뜰 때 한 번씩 부른다. */
export async function applyStoredUiLanguage(): Promise<string> {
  try {
    const saved = await chrome.storage.local.get('uiLang');
    return await loadUiLanguage(normalizeUiLanguage(saved?.uiLang));
  } catch {
    return '';
  }
}

/** 지금 적용 중인 UI 언어. 고른 값이 없으면 ''(브라우저 언어 따르기). */
export function selectedUiLanguage(): string {
  return overrideLang;
}

/** 지금 화면에 쓰는 언어(ko, en-US ...). 직접 고른 값이 있으면 그 값이 먼저다. */
export function uiLanguage(): string {
  if (overrideLang) return overrideLang;
  const api = (globalThis as { chrome?: typeof chrome }).chrome?.i18n;
  try {
    return api?.getUILanguage?.() || 'en-US';
  } catch {
    return 'en-US';
  }
}
