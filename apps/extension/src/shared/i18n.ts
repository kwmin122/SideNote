/**
 * 화면에 보이는 글자는 전부 여기를 거친다. 실제 문구는 public/_locales/<언어>/messages.json 에 있다.
 *
 * Chrome 이 브라우저 UI 언어에 맞는 파일을 골라 주고, 없는 언어는 manifest 의 default_locale(en)로 떨어진다.
 * 새 언어를 지원하려면 _locales 아래에 폴더 하나를 추가하면 된다. 코드는 건드릴 필요가 없다.
 */
export function t(key: string, ...subs: Array<string | number>): string {
  const api = (globalThis as { chrome?: typeof chrome }).chrome?.i18n;
  const message = api?.getMessage?.(key, subs.map(String));
  // 키를 그대로 돌려주면 화면에서 바로 눈에 띈다. 빈 문자열로 조용히 사라지는 것보다 낫다.
  return message || key;
}

/** 브라우저 UI 언어(ko, en-US ...). i18n API 가 없으면 en-US 로 본다. */
export function uiLanguage(): string {
  const api = (globalThis as { chrome?: typeof chrome }).chrome?.i18n;
  try {
    return api?.getUILanguage?.() || 'en-US';
  } catch {
    return 'en-US';
  }
}
