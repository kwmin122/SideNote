import 'fake-indexeddb/auto';
import { vi } from 'vitest';

/** 테스트에서 쓰는 최소 chrome API 스텁. 실제 확장 런타임이 없어도 모듈을 로드할 수 있게 한다. */
const listeners = new Set<(message: unknown) => void>();

(globalThis as any).chrome = {
  runtime: {
    sendMessage: vi.fn(async () => ({ ok: true })),
    onMessage: {
      addListener: (fn: (message: unknown) => void) => listeners.add(fn),
      removeListener: (fn: (message: unknown) => void) => listeners.delete(fn)
    },
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() }
  },
  storage: {
    session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
  },
  tabs: { query: vi.fn(async () => []), get: vi.fn(async () => ({})), onRemoved: { addListener: vi.fn() }, onUpdated: { addListener: vi.fn() } },
  offscreen: { hasDocument: vi.fn(async () => false), createDocument: vi.fn(async () => {}), closeDocument: vi.fn(async () => {}), Reason: { USER_MEDIA: 'USER_MEDIA' } },
  tabCapture: { getMediaStreamId: vi.fn(async () => 'stream-id') },
  scripting: { executeScript: vi.fn(async () => []) },
  sidePanel: { setPanelBehavior: vi.fn(async () => {}) }
};

if (!globalThis.crypto?.randomUUID) {
  let counter = 0;
  Object.defineProperty(globalThis, 'crypto', {
    value: { ...globalThis.crypto, randomUUID: () => `uuid-${++counter}` },
    configurable: true
  });
}
