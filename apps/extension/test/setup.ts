import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';

// 화면 문구는 _locales 에 있다. 테스트는 기본 언어(en) 파일을 그대로 읽어 chrome.i18n 을 흉내 낸다.
// 실제로 쓰는 파일을 읽으므로, 키를 지우거나 오타를 내면 테스트가 먼저 깨진다.
const MESSAGES: Record<string, { message: string }> = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/_locales/en/messages.json'), 'utf-8')
);

function getMessage(key: string, subs?: string | string[]): string {
  const entry = MESSAGES[key];
  if (!entry) return '';
  const list = subs == null ? [] : Array.isArray(subs) ? subs : [subs];
  return entry.message.replace(/\$p(\d+)\$/g, (_m, n) => list[Number(n) - 1] ?? '');
}

/** 테스트에서 쓰는 최소 chrome API 스텁. 실제 확장 런타임이 없어도 모듈을 로드할 수 있게 한다. */
const listeners = new Set<(message: unknown) => void>();

(globalThis as any).chrome = {
  i18n: { getMessage, getUILanguage: () => 'en-US' },
  runtime: {
    // 화면 언어를 직접 고르면 해당 messages.json 을 fetch 로 읽는다. 테스트에서는 파일 경로를 그대로 돌려준다.
    getURL: (path: string) => resolve(process.cwd(), 'public', path),
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
