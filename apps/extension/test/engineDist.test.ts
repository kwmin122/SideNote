/**
 * 설치 버튼을 보여 줄지 말지를 이 모듈 하나가 정한다.
 * 여기가 틀리면 스토어 빌드에서 "눌러도 받을 게 없는 버튼" 이 다시 생긴다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const HOSTED = 'https://example.com/SideNoteEngine.pkg';

/** config 가 import.meta.env 를 모듈 로드 시점에 한 번만 읽으므로, 매번 새로 불러와야 한다. */
async function loadFresh() {
  vi.resetModules();
  return import('../src/shared/engine-dist');
}

function stubGetURL() {
  (globalThis as any).chrome.runtime.getURL = (p: string) => `chrome-extension://abcd/${p}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (globalThis as any).chrome.runtime.getURL;
});

describe('enginePkgUrl', () => {
  it('배포처 주소가 있으면 확장 안의 사본보다 그 주소를 먼저 쓴다', async () => {
    vi.stubEnv('VITE_ENGINE_PKG_URL', HOSTED);
    stubGetURL();
    const m = await loadFresh();
    expect(m.enginePkgUrl()).toBe(HOSTED);
  });

  it('개발 빌드에서는 확장 안에 넣어 둔 pkg 를 가리킨다', async () => {
    stubGetURL();
    const m = await loadFresh();
    expect(m.enginePkgUrl()).toBe(`chrome-extension://abcd/engine/${m.ENGINE_PKG_FILENAME}`);
  });

  it('스토어 빌드(VITE_ENGINE_BUNDLED=0)에서는 확장 안의 pkg 를 쓰지 않는다', async () => {
    vi.stubEnv('VITE_ENGINE_BUNDLED', '0');
    stubGetURL();
    const m = await loadFresh();
    expect(m.enginePkgUrl()).toBe('');
  });

  it('chrome.runtime 이 없는 곳에서도 터지지 않고 빈 문자열을 준다', async () => {
    const m = await loadFresh();
    expect(m.enginePkgUrl()).toBe('');
  });
});

describe('engineMissingMessage', () => {
  it('설치 프로그램이 없으면 화면에 없는 버튼을 누르라고 하지 않는다', async () => {
    vi.stubEnv('VITE_ENGINE_BUNDLED', '0');
    const m = await loadFresh();
    expect(m.engineMissingMessage()).toBe(m.ENGINE_PKG_UNAVAILABLE);
    expect(m.engineMissingMessage()).not.toContain('고정확도 엔진 설치');
  });

  it('설치 프로그램이 있으면 버튼 이름을 그대로 안내한다', async () => {
    vi.stubEnv('VITE_ENGINE_PKG_URL', HOSTED);
    const m = await loadFresh();
    expect(m.engineMissingMessage()).toContain('[고정확도 엔진 설치]');
  });
});
