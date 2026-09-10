/**
 * "고정확도 엔진 설치 프로그램을 지금 내려받을 수 있는가" 한 곳에서만 판단한다.
 * 사이드패널 카드와 설치 안내 페이지가 서로 다른 말을 하지 않게 하기 위한 것이다.
 */
/**
 * 지금 배포판(Chrome 기기 내 음성인식 전용)은 이 모듈을 import 하지 않는다.
 * 나중에 별도 엔진을 다시 붙일 때 쓰려고 남겨 둔 파일이라, 빌드 상수도 여기서 직접 읽는다.
 */
const ENGINE_PKG_HOSTED_URL = String(import.meta.env?.VITE_ENGINE_PKG_URL ?? '').trim();
/** '0' 으로 빌드하면 확장 안에 pkg 가 없다고 본다. */
const ENGINE_PKG_BUNDLED = String(import.meta.env?.VITE_ENGINE_BUNDLED ?? '1') !== '0';

export const ENGINE_PKG_FILENAME = 'SideNoteEngine.pkg';

/** 받을 수 있는 주소. 빈 문자열이면 지금은 배포본이 없다는 뜻이다. */
export function enginePkgUrl(): string {
  if (ENGINE_PKG_HOSTED_URL) return ENGINE_PKG_HOSTED_URL;
  if (ENGINE_PKG_BUNDLED && typeof chrome !== 'undefined' && typeof chrome.runtime?.getURL === 'function') {
    return chrome.runtime.getURL(`engine/${ENGINE_PKG_FILENAME}`);
  }
  return '';
}

/** 배포본이 아직 없을 때 보여 줄 문구. */
export const ENGINE_PKG_UNAVAILABLE = '고정확도(Whisper) 엔진 설치 프로그램은 아직 배포 준비 중입니다.';

/** 위 문구와 짝으로 쓴다. 엔진이 없어도 자막을 쓸 방법이 있다는 사실을 반드시 같이 말한다. */
export const ENGINE_FALLBACK_HINT = '지금은 빠른 모드(Chrome)로 자막을 사용해 주세요.';

/**
 * "엔진이 없다" 고 알릴 때 쓰는 문구.
 *
 * 설치 프로그램을 실제로 건네줄 수 있는 빌드에서만 [고정확도 엔진 설치] 버튼 이름을 말한다.
 * 스토어 빌드에는 그 버튼이 없어서, 그대로 두면 화면에 없는 버튼을 누르라고 하는 셈이 된다.
 */
export function engineMissingMessage(): string {
  return enginePkgUrl()
    ? '고정확도 엔진이 아직 설치되지 않았습니다. [고정확도 엔진 설치] 를 눌러 한 번만 설치하면 다음부터는 자동으로 연결됩니다.'
    : ENGINE_PKG_UNAVAILABLE;
}
