import { config } from '../config';
import type {
  CaptureResponse,
  ErrorCode,
  ScriptFetchResponse,
  ScriptLine,
  SessionStatus,
  STTConnectionStatus,
  StatusPayload,
  VideoRect,
  VideoTimeResponse
} from '../shared/contracts';
import { pickVideoFromFrames } from '../shared/capture';
import { COMMAND_BY_MESSAGE, badgeTextFor, shouldStopOnPanelClose, transition, type CaptureCommand } from '../shared/state';
import {
  normalizeScriptLines,
  parseJson3,
  pickCaptionTrack,
  trackInfo,
  type RawCaptionTrack
} from '../shared/script';
import { hideOverlay, showOverlay } from './overlay';
import { applyStoredUiLanguage, t, uiLanguage } from '../shared/i18n';

// 오류 문구도 사용자가 고른 화면 언어로 나가야 한다. 서비스 워커는 자주 죽으므로 깰 때마다 한 번씩 얹는다.
void applyStoredUiLanguage();

const STATE_KEY = 'captureState';
/** "패널을 닫아도 계속"은 사용자가 고른 설정이다. 브라우저를 껐다 켜도 남아야 해서 local 에 둔다. */
const KEEP_ALIVE_KEY = 'keepAlive';
/** 사이드패널이 열려 있는 동안만 살아 있는 포트. 끊기는 순간이 곧 "패널을 닫았다"는 신호다. */
export const PANEL_PORT = 'sidepanel';

interface BackgroundState {
  status: SessionStatus;
  stt: STTConnectionStatus;
  sessionId?: string;
  tabId?: number;
  /** 확장 아이콘 클릭(=사용자 호출)으로 activeTab 이 부여된 탭. */
  invokedTabId?: number;
  /** 영상 위 자막 오버레이 사용 여부. 기본은 켜짐. */
  overlay?: boolean;
  /** 사이드패널을 닫아도 자막을 계속 돌릴지. 기본은 켜짐. */
  keepAlive?: boolean;
  error?: string;
  errorCode?: ErrorCode;
}

const INITIAL: BackgroundState = { status: 'READY', stt: 'DISCONNECTED', overlay: true, keepAlive: true };

/** 서비스 워커는 언제든 종료된다. 상태는 항상 chrome.storage.session 에서 읽고 쓴다. */
async function readState(): Promise<BackgroundState> {
  try {
    // 진행 상태는 session(브라우저를 닫으면 사라짐), "패널을 닫아도 계속"은 local(계속 남음)에 있다.
    const [stored, saved] = await Promise.all([
      chrome.storage.session.get(STATE_KEY),
      chrome.storage.local.get(KEEP_ALIVE_KEY)
    ]);
    const keepAlive = typeof saved?.[KEEP_ALIVE_KEY] === 'boolean' ? (saved[KEEP_ALIVE_KEY] as boolean) : true;
    return { ...INITIAL, ...(stored?.[STATE_KEY] as BackgroundState | undefined), keepAlive };
  } catch {
    return { ...INITIAL };
  }
}

async function writeState(patch: Partial<BackgroundState>): Promise<BackgroundState> {
  const next = { ...(await readState()), ...patch };
  try {
    await chrome.storage.session.set({ [STATE_KEY]: next });
  } catch {
    /* storage 실패해도 동작은 계속한다 */
  }
  applyBadge(next);
  await broadcast(next);
  return next;
}

/**
 * 아이콘 위 배지. 사이드패널을 닫아도 자막이 계속 돌기 때문에,
 * 지금 받고 있는지 아닌지를 알 수 있는 곳이 툴바 아이콘밖에 없다.
 */
function applyBadge(state: BackgroundState) {
  const text = badgeTextFor(state.status);
  void chrome.action.setBadgeText({ text }).catch(() => {});
  if (text) {
    void chrome.action
      .setBadgeBackgroundColor({ color: state.status === 'CAPTURING' ? '#d93025' : '#5f6368' })
      .catch(() => {});
  }
  // 이름은 번역하지 않는다(스토어 등록명과 같아야 한다). 상태 설명만 화면 언어를 따른다.
  void chrome.action.setTitle({ title: text ? `SideNote — ${t('bgBadgeRunning')}` : 'SideNote' }).catch(() => {});
}

/** 실패가 아닌 진행 상황. 사이드패널의 알림 줄에 그대로 뜬다. */
function notify(message: string) {
  void chrome.runtime.sendMessage({ type: 'OFFSCREEN_NOTICE', message }).catch(() => {});
}

async function broadcast(state: BackgroundState) {
  const payload: StatusPayload = {
    status: state.status,
    stt: state.stt,
    sessionId: state.sessionId,
    tabId: state.tabId,
    invokedTabId: state.invokedTabId,
    overlay: state.overlay !== false,
    keepAlive: state.keepAlive !== false,
    error: state.error,
    errorCode: state.errorCode
  };
  await chrome.runtime.sendMessage({ type: 'STATUS', payload }).catch(() => {});
}

// openPanelOnActionClick 을 켜면 Chrome 이 패널만 열고 action.onClicked 가 확장으로 오지 않는다.
// 그러면 tabCapture 가 요구하는 "사용자가 이 탭에서 확장을 호출했다"(activeTab)가 성립하지 않는다.
// 직접 onClicked 를 받아 sidePanel.open 을 호출해야 그 탭의 activeTab 이 부여된다.
function installActionBehavior() {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

// setPanelBehavior 는 확장에 저장되는 영구 설정이라, 예전 빌드가 켜둔 true 가 그대로 남아 있을 수 있다.
// 워커가 깰 때마다 덮어써야 재설치 없이도 확실히 적용된다.
installActionBehavior();
chrome.runtime.onInstalled.addListener(() => {
  installActionBehavior();
});
chrome.runtime.onStartup.addListener(() => {
  installActionBehavior();
  void chrome.storage.session.remove(STATE_KEY).catch(() => {});
  void chrome.action.setBadgeText({ text: '' }).catch(() => {});
});

/**
 * 사이드패널이 열려 있는 동안만 이 포트가 살아 있다.
 * "패널을 닫아도 계속"이 꺼져 있으면 포트가 끊기는 순간 자막도 끝낸다(탭 소리를 계속 붙잡지 않는다).
 * 켜져 있으면 아무것도 하지 않는다. 오프스크린 문서가 자막·번역·저장을 그대로 이어 간다.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;
  port.onDisconnect.addListener(() => {
    void onPanelClosed().catch(() => {});
  });
});

async function onPanelClosed() {
  const state = await readState();
  if (!shouldStopOnPanelClose(state.status, state.keepAlive !== false)) return;
  await teardown();
  await writeState({ status: 'STOPPED', stt: 'DISCONNECTED' });
}

chrome.action.onClicked.addListener((tab) => {
  // open() 은 사용자 제스처 안에서 동기적으로 호출해야 한다. await 를 앞에 두면 제스처가 소멸한다.
  if (typeof tab.id === 'number') void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  else if (typeof tab.windowId === 'number') void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  // 이 클릭 자체가 이 탭의 activeTab 권한이다. 패널이 알 수 있게 기록하고,
  // 권한 때문에 남아 있던 오류 상태는 여기서 풀어준다.
  void readState().then((state) =>
    writeState({
      invokedTabId: tab.id,
      status: state.status === 'ERROR' ? 'READY' : state.status,
      error: undefined,
      errorCode: undefined
    })
  );
});

const COMMANDS = new Set([
  'CAPTION_START',
  'CAPTION_PAUSE',
  'CAPTION_RESUME',
  'CAPTION_STOP',
  'CAPTURE_REQUEST',
  'STATUS_GET',
  'VIDEO_TIME_GET',
  'SCRIPT_FETCH'
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 오프스크린이 브로드캐스트하는 STT_STATUS / OFFSCREEN_ERROR 는 응답 없이 상태만 갱신한다.
  if (message?.type === 'STT_STATUS') {
    void writeState({ stt: message.stt, errorCode: message.errorCode });
    return false;
  }
  if (message?.type === 'OFFSCREEN_ERROR') {
    void writeState({ error: message.message, errorCode: message.errorCode });
    return false;
  }
  // 오프스크린이 합쳐 보낸 오버레이 문구를 강의 탭에 그린다. 저장하지 않는다.
  if (message?.type === 'CAPTION_LIVE') {
    void readState().then((state) => {
      if (state.overlay === false) return;
      if (state.status !== 'CAPTURING' && state.status !== 'PAUSED') return;
      return showOverlay(state.tabId, String(message.text ?? ''));
    });
    return false;
  }
  if (message?.type === 'KEEP_ALIVE_SET') {
    const enabled = message.enabled !== false;
    void chrome.storage.local
      .set({ [KEEP_ALIVE_KEY]: enabled })
      .catch(() => {})
      .then(() => readState())
      .then((state) => broadcast(state));
    return false;
  }
  if (message?.type === 'OVERLAY_SET') {
    void readState().then(async (state) => {
      await writeState({ overlay: message.enabled !== false });
      if (message.enabled === false) await hideOverlay(state.tabId);
    });
    return false;
  }
  if (!COMMANDS.has(message?.type)) return false;

  void handleMessage(message)
    .then(sendResponse)
    .catch(async (err) => {
      const state = await writeState({ status: 'ERROR', error: String(err?.message ?? err), errorCode: 'UNKNOWN' });
      sendResponse({ ok: false, error: state.error, status: state.status });
    });
  return true;
});

/** 시작 중 중복 클릭이 두 번째 캡처 스트림을 만들지 않도록 하는 뮤텍스. */
let startInFlight: Promise<unknown> | undefined;

async function handleMessage(message: any): Promise<unknown> {
  if (message.type === 'STATUS_GET') {
    const state = await readState();
    return { ok: true, ...state };
  }
  if (message.type === 'CAPTURE_REQUEST') return captureScreen(message.tabId);
  if (message.type === 'VIDEO_TIME_GET') return probeVideoTime(message.tabId);
  if (message.type === 'SCRIPT_FETCH') return fetchScript(message.tabId, message.lang);

  const command = COMMAND_BY_MESSAGE[message.type];
  if (!command) return { ok: false, error: t('bgUnknownCommand') };

  if (command === 'START') {
    if (startInFlight) {
      await startInFlight.catch(() => {});
      const state = await readState();
      return { ok: true, status: state.status, ignored: true };
    }
    startInFlight = runCommand(command, message).finally(() => {
      startInFlight = undefined;
    });
    return startInFlight;
  }
  return runCommand(command, message);
}

async function runCommand(command: CaptureCommand, message: any) {
  const state = await readState();
  const result = transition(state.status, command);
  if (!result.changed) return { ok: true, status: state.status, ignored: true, reason: result.reason };

  switch (result.effect) {
    case 'START_CAPTURE': {
      const engine = message.engine ?? config.defaultSttEngine;
      const streamId = await getStreamId(message.tabId);
      await ensureOffscreen();
      await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_START',
        streamId,
        sessionId: message.sessionId,
        contextPrompt: message.contextPrompt ?? '',
        language: message.language,
        translateTo: message.translateTo ?? '',
        engine
      });
      const next = await writeState({
        status: result.status,
        sessionId: message.sessionId,
        tabId: message.tabId,
        error: undefined,
        errorCode: undefined
      });
      return { ok: true, status: next.status };
    }
    case 'PAUSE_CAPTURE':
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PAUSE' }).catch(() => {});
      return { ok: true, status: (await writeState({ status: result.status })).status };
    case 'RESUME_CAPTURE':
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_RESUME' }).catch(() => {});
      return { ok: true, status: (await writeState({ status: result.status })).status };
    case 'STOP_CAPTURE':
      await teardown();
      return { ok: true, status: (await writeState({ status: result.status, stt: 'DISCONNECTED' })).status };
    default:
      return { ok: true, status: (await writeState({ status: result.status })).status };
  }
}

async function getStreamId(tabId: number): Promise<string> {
  if (typeof tabId !== 'number') throw Object.assign(new Error(t('bgTabNotFound')), { code: 'TAB_NOT_FOUND' as ErrorCode });
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    // activeTab 은 확장 아이콘 클릭 등으로 "호출"되었을 때만 부여된다.
    const code: ErrorCode = /permission|activeTab|invoked/i.test(message)
      ? 'TAB_CAPTURE_PERMISSION_DENIED'
      : 'TAB_CAPTURE_FAILED';
    await writeState({ errorCode: code, error: message });
    throw new Error(
      code === 'TAB_CAPTURE_PERMISSION_DENIED'
        ? t('bgTabCapturePermission')
        : t('bgTabCaptureFailed', message)
    );
  }
}

/** 종료 시 오프스크린 문서와 영상 위 오버레이까지 정리해 다음 시작이 깨끗한 상태에서 출발하게 한다. */
async function teardown() {
  const state = await readState();
  await hideOverlay(state.tabId);
  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
  try {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  } catch {
    /* 이미 닫혔거나 생성 중 */
  }
}

async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
  } catch {
    /* hasDocument 미지원 시 createDocument 예외로 처리 */
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: t('bgOffscreenJustification')
    });
  } catch (err) {
    // 동시 호출로 이미 만들어진 경우는 정상으로 취급한다.
    if (!/already/i.test(String(err))) throw err;
  }
}

/**
 * 모든 프레임에서 영상을 찾는다.
 * - 자르기 좌표(rect)는 최상위 프레임 것만 쓴다. iframe 좌표는 프레임 기준이라 그대로 자르면 엉뚱한 곳이 잘린다.
 * - 재생 위치(currentTime)는 프레임 좌표와 무관하므로 iframe 플레이어 것도 그대로 쓴다.
 *
 * 이 확장은 넓은 host_permissions 를 선언하지 않는다. 주입 권한은 아이콘 클릭으로 받은 activeTab 뿐이라
 * 아이콘을 누르기 전이거나, 그 탭의 출처와 다른 iframe(다른 사이트에 embed 된 플레이어) 안은 주입이 막힌다.
 * 그때는 예외를 그대로 삼키고 뷰포트 전체 캡처로 물러난다.
 */
async function probeVideos(tabId: number): Promise<{ topRect: VideoRect | null; anyVideo: VideoRect | null }> {
  try {
    const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: findPlayingVideoRect });
    return pickVideoFromFrames(frames.map((frame) => ({ frameId: frame.frameId, result: frame.result as VideoRect | null })));
  } catch {
    // chrome:// 페이지, 아이콘을 누르기 전, 다른 출처 iframe 등 스크립트 주입 불가 → 뷰포트 전체로 폴백한다.
    return { topRect: null, anyVideo: null };
  }
}

async function probeVideoTime(tabId: number): Promise<VideoTimeResponse> {
  if (typeof tabId !== 'number') return { ok: false };
  const { anyVideo } = await probeVideos(tabId);
  if (!anyVideo) return { ok: false };
  return { ok: true, videoTimeSec: anyVideo.videoTimeSec, durationSec: anyVideo.durationSec };
}

async function captureScreen(tabId: number): Promise<CaptureResponse> {
  if (typeof tabId !== 'number') return { ok: false, error: t('bgCurrentTabNotFound'), errorCode: 'TAB_NOT_FOUND' };
  const { topRect, anyVideo } = await probeVideos(tabId);
  let pageUrl = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    pageUrl = tab.url ?? '';
  } catch {
    pageUrl = '';
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
    return { ok: true, dataUrl, videoRect: topRect, videoTimeSec: anyVideo?.videoTimeSec, pageUrl };
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    // captureVisibleTab 은 activeTab 이 있어야 한다. 아이콘을 누르기 전이거나 주소가 바뀐 뒤면 권한 오류가 난다.
    // "캡처 실패" 로만 알리면 무엇을 눌러야 하는지 알 수 없으므로, 그 경우만 따로 안내한다.
    const denied = /permission|activeTab|not allowed/i.test(message);
    return {
      ok: false,
      error: denied ? t('bgScreenshotPermission') : t('bgScreenshotFailed', message),
      errorCode: 'SCREENSHOT_FAILED'
    };
  }
}

/** 주입 함수. 재생 중인 영상을 우선하고, 그중 화면에서 가장 큰 것을 고른다. */
function findPlayingVideoRect(): VideoRect | null {
  const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
  const visible = videos.filter((video) => {
    const rect = video.getBoundingClientRect();
    const style = getComputedStyle(video);
    return (
      rect.width > 160 &&
      rect.height > 90 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) > 0.1 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth
    );
  });
  if (!visible.length) return null;
  const chosen = visible.sort((a, b) => {
    const playing = (v: HTMLVideoElement) => (!v.paused && !v.ended && v.readyState > 2 ? 1 : 0);
    if (playing(a) !== playing(b)) return playing(b) - playing(a);
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return rb.width * rb.height - ra.width * ra.height;
  })[0];
  const rect = chosen.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    dpr: devicePixelRatio,
    videoTimeSec: Number.isFinite(chosen.currentTime) ? chosen.currentTime : undefined,
    durationSec: Number.isFinite(chosen.duration) ? chosen.duration : undefined
  };
}

/**
 * 영상에 원래 들어 있는 자막(스크립트)을 통째로 가져온다.
 *
 * 자막 트랙 주소는 페이지와 같은 출처다. 확장에는 그 사이트의 호스트 권한이 없으므로
 * 확장이 직접 받을 수 없고, 페이지(MAIN 월드)가 자기 이름으로 받아 오게 해야 한다.
 * 그래서 "트랙 목록 읽기 → (여기서 고르기) → 고른 주소 받아 오기" 두 번에 나눠 주입한다.
 * 플레이어가 트랙을 들고 있지 않으면 <video> 의 textTracks 로 물러난다.
 */
async function fetchScript(tabId: number, prefer?: string): Promise<ScriptFetchResponse> {
  if (typeof tabId !== 'number') return { ok: false, error: t('bgCurrentTabNotFound'), errorCode: 'TAB_NOT_FOUND' };
  let tracks: RawCaptionTrack[] = [];
  try {
    tracks = (await runInPage<RawCaptionTrack[]>(tabId, readCaptionTracks)) ?? [];
    const chosen = pickCaptionTrack(tracks, prefer ?? '', uiLanguage());
    if (chosen) {
      const body = await runInPage<string>(tabId, fetchTrackText, [chosen.baseUrl]);
      const lines = parseJson3(String(body ?? ''));
      if (lines.length) {
        return { ok: true, source: 'player', lang: chosen.lang, label: chosen.label, tracks: trackInfo(tracks), lines };
      }
    }
    const fallback = await runInPage<{ lang: string; label: string; lines: ScriptLine[] }>(tabId, readTextTrackCues);
    const lines = normalizeScriptLines(fallback?.lines ?? []);
    if (lines.length) {
      return {
        ok: true,
        source: 'texttrack',
        lang: fallback?.lang ?? '',
        label: fallback?.label ?? '',
        tracks: trackInfo(tracks),
        lines
      };
    }
    return { ok: false, error: t('bgScriptNotFound'), errorCode: 'SCRIPT_NOT_FOUND', tracks: trackInfo(tracks) };
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    // 아이콘을 누르기 전이면 activeTab 이 없어 주입 자체가 막힌다. 그때는 무엇을 눌러야 하는지 알려준다.
    const denied = /permission|activeTab|not allowed|cannot access/i.test(message);
    return {
      ok: false,
      error: denied ? t('bgScriptPermission') : t('bgScriptFailed', message),
      errorCode: 'SCRIPT_FETCH_FAILED',
      tracks: trackInfo(tracks)
    };
  }
}

/** 최상위 프레임에서만 돌린다. 스크립트는 좌표와 무관하고, iframe 까지 뒤지면 광고 프레임까지 건드리게 된다. */
async function runInPage<T>(tabId: number, func: (...args: any[]) => unknown, args: unknown[] = []): Promise<T | undefined> {
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: func as (...args: any[]) => unknown,
    args: args as any[]
  });
  return frame?.result as T | undefined;
}

/**
 * 주입 함수. 페이지가 들고 있는 자막 트랙 목록을 읽는다.
 * 유튜브는 ytInitialPlayerResponse 전역에 담아 두고, 전역이 없을 때도 HTML 안에 같은 배열이 박혀 있다.
 */
function readCaptionTracks(): Array<{ lang: string; label: string; baseUrl: string; kind?: string }> {
  const out: Array<{ lang: string; label: string; baseUrl: string; kind?: string }> = [];
  const push = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const track = item as any;
      const baseUrl = String(track?.baseUrl ?? '');
      if (!baseUrl) continue;
      const label = String(track?.name?.simpleText ?? track?.name?.runs?.[0]?.text ?? track?.languageCode ?? '');
      out.push({
        lang: String(track?.languageCode ?? ''),
        label,
        baseUrl,
        kind: track?.kind ? String(track.kind) : undefined
      });
    }
  };
  push((window as any)?.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
  if (out.length) return out;

  // 전역이 없는 페이지도 있다. HTML 안에 박힌 배열을 통째로 잘라 읽는다.
  // 대괄호만 세면 문자열 안의 "]" 에 걸려 잘못 자르므로, 따옴표 안쪽은 건너뛴다.
  const html = document.documentElement.innerHTML;
  const at = html.indexOf('"captionTracks"');
  if (at < 0) return out;
  const start = html.indexOf('[', at);
  if (start < 0) return out;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          push(JSON.parse(html.slice(start, i + 1)));
        } catch {
          /* 형식이 바뀌었으면 포기하고 textTracks 로 물러난다 */
        }
        break;
      }
    }
  }
  return out;
}

/** 주입 함수. 고른 트랙을 페이지가 자기 이름으로 받아 온다(json3 = 시각이 붙은 JSON). */
async function fetchTrackText(url: string): Promise<string> {
  const target = /[?&]fmt=/.test(url) ? url : `${url}${url.includes('?') ? '&' : '?'}fmt=json3`;
  const res = await fetch(target, { credentials: 'include' });
  if (!res.ok) return '';
  return await res.text();
}

/** 주입 함수. 플레이어가 트랙을 들고 있지 않을 때, <video> 에 붙은 자막 트랙의 큐를 읽는다. */
async function readTextTrackCues(): Promise<{ lang: string; label: string; lines: Array<{ startSec: number; endSec?: number; text: string }> }> {
  const empty = { lang: '', label: '', lines: [] as Array<{ startSec: number; endSec?: number; text: string }> };
  const video = document.querySelector('video');
  const tracks = video ? Array.from(video.textTracks) : [];
  if (!tracks.length) return empty;
  const chosen = tracks.find((track) => track.mode === 'showing') ?? tracks.find((track) => track.mode === 'hidden') ?? tracks[0];
  const before = chosen.mode;
  // 꺼져 있는 트랙은 cues 가 비어 있다. 잠깐 켜서 읽고 원래대로 되돌린다(화면에는 보이지 않는 hidden 이다).
  if (before === 'disabled') chosen.mode = 'hidden';
  await new Promise((resolve) => setTimeout(resolve, 500));
  const cues = chosen.cues ? Array.from(chosen.cues) : [];
  const lines = cues.map((cue) => ({
    startSec: Number((cue as any).startTime) || 0,
    endSec: Number.isFinite(Number((cue as any).endTime)) ? Number((cue as any).endTime) : undefined,
    // WebVTT 큐에는 <c.color> 같은 꾸밈 태그가 섞여 들어온다.
    text: String((cue as any).text ?? '').replace(/<[^>]*>/g, ' ')
  }));
  if (chosen.mode !== before) chosen.mode = before;
  return { lang: chosen.language ?? '', label: chosen.label ?? '', lines };
}

// 캡처 중이던 탭이 닫히거나 다른 페이지로 이동하면 캡처를 정리한다.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await readState();
  if (state.invokedTabId === tabId) await writeState({ invokedTabId: undefined });
  if (state.tabId !== tabId || state.status === 'STOPPED') return;
  await teardown();
  await writeState({ status: 'STOPPED', stt: 'DISCONNECTED', error: t('bgTabClosed') });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const state = await readState();
  // 페이지를 이동하면 Chrome 이 activeTab 을 회수한다. 기록도 같이 지워야 안내가 맞는다.
  if (state.invokedTabId === tabId) await writeState({ invokedTabId: undefined });
  if (state.tabId !== tabId || (state.status !== 'CAPTURING' && state.status !== 'PAUSED')) return;
  await teardown();
  await writeState({ status: 'STOPPED', stt: 'DISCONNECTED', error: t('bgTabNavigated') });
});
