/**
 * 세션 복원 키. 같은 강의 페이지를 새로고침하거나 ?t=123 같은 쿼리가 붙어도
 * 동일한 세션(메모/캡처/자막)을 찾을 수 있도록 origin + pathname 만 사용한다.
 *
 * 예외: 유튜브처럼 영상이 바뀌어도 경로가 그대로인 사이트가 있다.
 * (/watch?v=AAA 와 /watch?v=BBB 는 경로가 둘 다 "/watch" 라 한 노트에 다른 영상 자막이 섞였다.)
 * 그래서 아래 목록에 있는 호스트에 한해 "영상을 가리키는 파라미터" 하나만 키에 더한다.
 * 목록에 없는 사이트는 지금까지와 똑같이 동작한다(강의 사이트는 대개 강의마다 경로가 다르다).
 */
const VIDEO_ID_PARAMS: Record<string, string[]> = {
  'www.youtube.com': ['v'],
  'youtube.com': ['v'],
  'm.youtube.com': ['v'],
  'www.youtube-nocookie.com': ['v']
};

export function pageKeyOf(url: string | undefined | null): string {
  if (!url) return 'about:blank';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    const base = `${parsed.origin}${path}`;
    for (const name of VIDEO_ID_PARAMS[parsed.hostname] ?? []) {
      const value = parsed.searchParams.get(name);
      // ?t=90 처럼 재생 위치만 붙은 주소는 여전히 같은 노트로 이어진다. 목록에 있는 이름만 본다.
      if (value) return `${base}?${name}=${value}`;
    }
    return base;
  } catch {
    return url;
  }
}

export function originOf(url: string | undefined | null): string {
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
