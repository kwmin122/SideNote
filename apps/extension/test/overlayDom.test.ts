import { beforeEach, describe, expect, it } from 'vitest';
import { OVERLAY_ELEMENT_ID, installCaptionOverlay, removeCaptionOverlay } from '../src/background/overlay';

// 주입 함수는 페이지 안에서 도는 코드다. happy-dom 문서를 페이지 삼아 그대로 돌린다.
if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
}

function addVideo(): HTMLVideoElement {
  const video = document.createElement('video');
  video.style.opacity = '1';
  video.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(video);
  return video;
}

/** 확장을 새로고침하면 남는, 갱신 함수를 잃은 예전 오버레이. */
function addStaleOverlay(text: string): HTMLElement {
  const el = document.createElement('div');
  el.id = OVERLAY_ELEMENT_ID;
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

function overlays(): HTMLElement[] {
  return Array.from(document.querySelectorAll(`[id="${OVERLAY_ELEMENT_ID}"]`));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('영상 위 자막 오버레이는 언제나 하나만 남는다', () => {
  it('낡은 오버레이가 남아 있으면 새로 그릴 때 걷어낸다', () => {
    addVideo();
    addStaleOverlay('예전 자막');

    installCaptionOverlay(OVERLAY_ELEMENT_ID, '새 자막');

    const list = overlays();
    expect(list).toHaveLength(1);
    expect(list[0].textContent).toBe('새 자막');
  });

  it('여러 번 그려도 요소가 늘어나지 않는다', () => {
    addVideo();
    installCaptionOverlay(OVERLAY_ELEMENT_ID, '한 줄');
    installCaptionOverlay(OVERLAY_ELEMENT_ID, '두 줄');
    installCaptionOverlay(OVERLAY_ELEMENT_ID, '세 줄');

    const list = overlays();
    expect(list).toHaveLength(1);
    expect(list[0].textContent).toBe('세 줄');
  });

  it('그리는 도중에 낡은 오버레이가 끼어들어도 살아 있는 것만 남긴다', () => {
    addVideo();
    installCaptionOverlay(OVERLAY_ELEMENT_ID, '첫 줄');
    const live = overlays()[0];
    addStaleOverlay('유령 자막');

    installCaptionOverlay(OVERLAY_ELEMENT_ID, '다음 줄');

    const list = overlays();
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(live);
    expect(list[0].textContent).toBe('다음 줄');
  });

  it('영상이 없는 프레임에서도 낡은 오버레이는 지운다', () => {
    addStaleOverlay('예전 자막');

    installCaptionOverlay(OVERLAY_ELEMENT_ID, '새 자막');

    expect(overlays()).toHaveLength(0);
  });

  it('오버레이를 걷어낼 때는 겹쳐 남은 것까지 전부 지운다', () => {
    addVideo();
    installCaptionOverlay(OVERLAY_ELEMENT_ID, '한 줄');
    addStaleOverlay('유령 1');
    addStaleOverlay('유령 2');

    removeCaptionOverlay(OVERLAY_ELEMENT_ID);

    expect(overlays()).toHaveLength(0);
  });
});
