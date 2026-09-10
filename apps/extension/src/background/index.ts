import { config } from '../config';
import type { CaptureResponse, ErrorCode, SessionStatus, STTConnectionStatus, StatusPayload, VideoRect, VideoTimeResponse } from '../shared/contracts';
import { pickVideoFromFrames } from '../shared/capture';
import { COMMAND_BY_MESSAGE, transition, type CaptureCommand } from '../shared/state';
import { hideOverlay, showOverlay } from './overlay';

const STATE_KEY = 'captureState';

interface BackgroundState {
  status: SessionStatus;
  stt: STTConnectionStatus;
  sessionId?: string;
  tabId?: number;
  /** 확장 아이콘 클릭(=사용자 호출)으로 activeTab 이 부여된 탭. */
  invokedTabId?: number;
  /** 영상 위 자막 오버레이 사용 여부. 기본은 켜짐. */
  overlay?: boolean;
  error?: string;
  errorCode?: ErrorCode;
}

const INITIAL: BackgroundState = { status: 'READY', stt: 'DISCONNECTED', overlay: true };

/** 서비스 워커는 언제든 종료된다. 상태는 항상 chrome.storage.session 에서 읽고 쓴다. */
async function readState(): Promise<BackgroundState> {
  try {
    const stored = await chrome.storage.session.get(STATE_KEY);
    return { ...INITIAL, ...(stored?.[STATE_KEY] as BackgroundState | undefined) };
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
  await broadcast(next);
  return next;
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
});

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
  'VIDEO_TIME_GET'
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

  const command = COMMAND_BY_MESSAGE[message.type];
  if (!command) return { ok: false, error: '알 수 없는 명령' };

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
  if (typeof tabId !== 'number') throw Object.assign(new Error('탭을 찾을 수 없습니다.'), { code: 'TAB_NOT_FOUND' as ErrorCode });
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
        ? '탭 오디오 캡처 권한이 없습니다. 강의 탭에서 툴바의 확장 아이콘을 한 번 누른 뒤 다시 시도하세요. (페이지를 이동하면 권한이 초기화됩니다)'
        : `탭 오디오 캡처 실패: ${message}`
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
      justification: '강의 탭 오디오를 실시간 자막으로 변환하기 위해 오디오를 처리합니다.'
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
 */
async function probeVideos(tabId: number): Promise<{ topRect: VideoRect | null; anyVideo: VideoRect | null }> {
  try {
    const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: findPlayingVideoRect });
    return pickVideoFromFrames(frames.map((frame) => ({ frameId: frame.frameId, result: frame.result as VideoRect | null })));
  } catch {
    // chrome:// 페이지 등 스크립트 주입 불가 → 뷰포트 전체로 폴백한다.
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
  if (typeof tabId !== 'number') return { ok: false, error: '현재 탭을 찾을 수 없습니다.', errorCode: 'TAB_NOT_FOUND' };
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
    return { ok: false, error: `화면 캡처 실패: ${String((err as Error)?.message ?? err)}`, errorCode: 'SCREENSHOT_FAILED' };
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

// 캡처 중이던 탭이 닫히거나 다른 페이지로 이동하면 캡처를 정리한다.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await readState();
  if (state.invokedTabId === tabId) await writeState({ invokedTabId: undefined });
  if (state.tabId !== tabId || state.status === 'STOPPED') return;
  await teardown();
  await writeState({ status: 'STOPPED', stt: 'DISCONNECTED', error: '강의 탭이 닫혀 자막을 종료했습니다.' });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const state = await readState();
  // 페이지를 이동하면 Chrome 이 activeTab 을 회수한다. 기록도 같이 지워야 안내가 맞는다.
  if (state.invokedTabId === tabId) await writeState({ invokedTabId: undefined });
  if (state.tabId !== tabId || (state.status !== 'CAPTURING' && state.status !== 'PAUSED')) return;
  await teardown();
  await writeState({ status: 'STOPPED', stt: 'DISCONNECTED', error: '탭이 다른 페이지로 이동해 자막을 종료했습니다.' });
});
