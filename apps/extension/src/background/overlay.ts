/**
 * 영상 위 자막 오버레이.
 *
 * 별도 content script 를 두지 않고 서비스 워커가 chrome.scripting.executeScript 로
 * 아래 두 함수를 주입한다(빌드 엔트리가 늘지 않고, 자막을 켤 때만 페이지를 건드린다).
 * 주입되는 함수는 페이지의 격리 월드에서 단독 실행되므로 바깥 값을 참조하면 안 된다.
 */

/** 오버레이가 이미 붙어 있는지 판단하는 기준. window 플래그 대신 DOM 이 유일한 진실이다. */
export const OVERLAY_ELEMENT_ID = 'study-sidepanel-caption-overlay';

/** 주입 함수: 오버레이를 만들거나(이미 있으면) 문구만 바꾼다. 영상이 없는 프레임에서는 아무것도 하지 않는다. */
function installCaptionOverlay(elementId: string, text: string): void {
  type Overlay = HTMLElement & { __studyUpdate?: (next: string) => void; __studyDispose?: () => void };

  const existing = document.getElementById(elementId) as Overlay | null;
  if (existing?.__studyUpdate) {
    existing.__studyUpdate(text);
    return;
  }

  const pickVideo = (): HTMLVideoElement | null => {
    const all = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const visible = all.filter((video) => {
      const rect = video.getBoundingClientRect();
      const style = getComputedStyle(video);
      return (
        rect.width > 160 &&
        rect.height > 90 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) > 0.1
      );
    });
    if (!visible.length) return null;
    return visible.sort((a, b) => {
      const playing = (v: HTMLVideoElement) => (!v.paused && !v.ended && v.readyState > 2 ? 1 : 0);
      if (playing(a) !== playing(b)) return playing(b) - playing(a);
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0];
  };

  let video = pickVideo();
  if (!video) return;

  let current = text;
  const box = document.createElement('div') as Overlay;
  box.id = elementId;
  box.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'pointer-events:none',
    'display:none',
    'align-items:flex-end',
    'justify-content:center',
    'margin:0',
    'padding:0',
    'border:0',
    'background:none'
  ].join(';');

  const label = document.createElement('div');
  label.style.cssText = [
    'max-width:92%',
    'box-sizing:border-box',
    'padding:4px 12px',
    'border-radius:6px',
    'background:rgba(8,8,8,0.78)',
    'color:#fff',
    'font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif',
    'font-weight:500',
    'line-height:1.35',
    'text-align:center',
    'white-space:pre-wrap',
    'word-break:break-word',
    'text-shadow:0 1px 2px rgba(0,0,0,0.6)'
  ].join(';');
  box.appendChild(label);

  /** 전체화면이면 그 요소 안으로 옮겨야 보인다. <video> 자체가 전체화면이면 그 위에는 못 올린다. */
  const hostFor = (target: HTMLVideoElement): HTMLElement | null => {
    const fs = document.fullscreenElement as HTMLElement | null;
    if (!fs) return document.body;
    if (fs === (target as unknown as HTMLElement)) return null;
    return fs.contains(target) ? fs : null;
  };

  let frame = 0;
  const place = () => {
    frame = 0;
    if (!box.isConnected && document.getElementById(elementId) !== box) return;
    if (!video || !video.isConnected) video = pickVideo();
    const host = video ? hostFor(video) : null;
    if (!video || !host) {
      box.style.display = 'none';
      return;
    }
    if (box.parentElement !== host) host.appendChild(box);
    const rect = video.getBoundingClientRect();
    if (!current || rect.width < 1 || rect.height < 1 || rect.bottom < 0 || rect.top > innerHeight) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'flex';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    // 컨트롤 바에 가리지 않도록 아래에서 조금 띄운다.
    box.style.paddingBottom = `${Math.round(rect.height * 0.09)}px`;
    label.style.fontSize = `${Math.max(13, Math.min(30, Math.round(rect.height * 0.05)))}px`;
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(place);
  };

  box.__studyUpdate = (next: string) => {
    current = next;
    label.textContent = next;
    place();
  };

  const observer = new ResizeObserver(schedule);
  const onFullscreen = () => place();
  addEventListener('scroll', schedule, { capture: true, passive: true });
  addEventListener('resize', schedule, { passive: true });
  document.addEventListener('fullscreenchange', onFullscreen, true);
  observer.observe(video);

  box.__studyDispose = () => {
    if (frame) cancelAnimationFrame(frame);
    removeEventListener('scroll', schedule, { capture: true } as EventListenerOptions);
    removeEventListener('resize', schedule);
    document.removeEventListener('fullscreenchange', onFullscreen, true);
    observer.disconnect();
    box.remove();
  };

  (hostFor(video) ?? document.body).appendChild(box);
  box.__studyUpdate(current);
}

/** 주입 함수: 오버레이를 걷어낸다. 없으면 아무 일도 하지 않는다. */
function removeCaptionOverlay(elementId: string): void {
  const el = document.getElementById(elementId) as (HTMLElement & { __studyDispose?: () => void }) | null;
  if (!el) return;
  if (el.__studyDispose) el.__studyDispose();
  else el.remove();
}

/** 자막 한 줄을 영상 위에 그린다. 주입 실패(권한/특수 페이지)는 자막 자체를 막지 않으므로 삼킨다. */
export async function showOverlay(tabId: number | undefined, text: string): Promise<void> {
  if (typeof tabId !== 'number') return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: installCaptionOverlay,
      args: [OVERLAY_ELEMENT_ID, text]
    });
  } catch {
    /* chrome:// 등 주입 불가 페이지 */
  }
}

export async function hideOverlay(tabId: number | undefined): Promise<void> {
  if (typeof tabId !== 'number') return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: removeCaptionOverlay,
      args: [OVERLAY_ELEMENT_ID]
    });
  } catch {
    /* 이미 닫혔거나 주입 불가 */
  }
}
