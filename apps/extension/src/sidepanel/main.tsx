import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { config, STT_STATUS_TEXT } from '../config';
import type {
  CaptureRecord,
  CaptureResponse,
  ErrorCode,
  SaveStatus,
  SessionStatus,
  STTConnectionStatus,
  StatusPayload,
  StudySession,
  TranscriptSegment
} from '../shared/contracts';
import { ERROR_MESSAGES } from '../shared/contracts';
import { captureTypeFor, computeCropRect } from '../shared/capture';
import { pageKeyOf } from '../shared/url';
import { shouldResyncTab } from '../shared/state';
import { capSegments, mergeSegment, transcriptToText } from '../shared/transcripts';
import {
  buildSessionHtml,
  bundleFileName,
  captureClipboardText,
  captureFileName,
  type ExportCaptureMeta
} from '../shared/export';
import { requestLanguagePack } from '../transcription/chrome-speech';
import { blobToDataUrl, composeCaptureImage, downloadBlob } from './compose';
import {
  cleanupOrphanBlobs,
  clearSessionTranscripts,
  createFreshSession,
  db,
  deleteCapture,
  deleteSession,
  getImageBlob,
  getOrCreateSession,
  listSessions,
  loadSessionBundle,
  putImageBlob,
  type SessionSummary
} from '../storage/db';
import './style.css';

function fmtMs(ms?: number) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** 00:12:43 형태. 강의 재생 위치 표시용. */
function fmtClock(seconds?: number) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s2 = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}`;
}

/** 저장 날짜 표기. 노트 목록에서 "언제 쓴 노트인지" 구분용. */
function fmtDate(ms: number) {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 이미지 없이 메모만 남긴 항목인지. 타임라인/내보내기/복사가 전부 이 기준으로 갈린다. */
function hasImage(record: CaptureRecord): boolean {
  return Boolean(record.imageBlobId || record.dataUrl);
}

function hostOf(url?: string) {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
}

/** dataUrl → (가능하면 영상 영역만 잘라낸) PNG Blob. 실패하면 뷰포트 전체를 그대로 쓴다. */
async function toCaptureBlob(dataUrl: string, rect: CaptureResponse['videoRect']) {
  const full = await (await fetch(dataUrl)).blob();
  if (!config.featureFlags.cropVideoRegion) return { blob: full, cropped: false };
  try {
    const bitmap = await createImageBitmap(full);
    const crop = computeCropRect(rect ?? null, bitmap.width, bitmap.height);
    if (!crop) {
      bitmap.close();
      return { blob: full, cropped: false };
    }
    const canvas = document.createElement('canvas');
    canvas.width = crop.sw;
    canvas.height = crop.sh;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return { blob: full, cropped: false };
    }
    ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
    bitmap.close();
    const cropped = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return cropped ? { blob: cropped, cropped: true } : { blob: full, cropped: false };
  } catch {
    return { blob: full, cropped: false };
  }
}

function CaptureImage({ capture }: { capture: CaptureRecord }) {
  const [src, setSrc] = useState<string>(capture.dataUrl ?? '');
  useEffect(() => {
    let url = '';
    let alive = true;
    if (capture.imageBlobId) {
      void getImageBlob(capture.imageBlobId).then((blob) => {
        if (!alive || !blob) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      });
    }
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [capture.imageBlobId]);
  if (!src) return <div className="capture-missing">이미지를 불러올 수 없습니다.</div>;
  return <img src={src} alt="강의 캡처" />;
}

function App() {
  const [session, setSession] = useState<StudySession | null>(null);
  const [items, setItems] = useState<TranscriptSegment[]>([]);
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [status, setStatus] = useState<SessionStatus>('READY');
  const [stt, setStt] = useState<STTConnectionStatus>('DISCONNECTED');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [memo, setMemo] = useState('');
  const [memoSave, setMemoSave] = useState<SaveStatus>('IDLE');
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeTabId, setActiveTabId] = useState<number | undefined>(undefined);
  const [invokedTabId, setInvokedTabId] = useState<number | undefined>(undefined);
  // 자막은 이제 영상 위 오버레이가 주 화면이라 사이드패널 기본 화면은 노트다.
  const [tab, setTab] = useState<'note' | 'caption'>('note');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [showSessions, setShowSessions] = useState(false);
  /** 현재 활성 탭의 pageKey. 열어둔 노트와 다르면 자막/캡처를 막는다. */
  const [activeKey, setActiveKey] = useState('');
  /** 목록에서 이전 노트를 직접 열어둔 상태. 탭을 옮겨도 세션을 바꾸지 않는다. */
  const [pinned, setPinned] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [overlay, setOverlay] = useState(true);
  const [videoTime, setVideoTime] = useState<{ cur?: number; dur?: number } | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const sessionRef = useRef<StudySession | null>(null);
  const statusRef = useRef<SessionStatus>('READY');
  const memoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingMemo = useRef<string | null>(null);
  const pinnedRef = useRef(false);

  sessionRef.current = session;
  statusRef.current = status;
  pinnedRef.current = pinned;

  const showError = useCallback((message: string, code?: ErrorCode) => {
    setError(code ? `${ERROR_MESSAGES[code]} (${message})` : message);
  }, []);

  useEffect(() => {
    void init();
    return () => {
      if (memoTimer.current) clearTimeout(memoTimer.current);
    };
  }, []);

  useEffect(() => {
    const handler = (message: any) => {
      if (message?.type === 'TRANSCRIPT') {
        const segment = message.payload as TranscriptSegment;
        if (sessionRef.current && segment.sessionId !== sessionRef.current.id) return;
        setItems((prev) => capSegments(mergeSegment(prev, segment), config.maxTranscriptSegmentsInMemory));
      }
      if (message?.type === 'STATUS') {
        const payload = message.payload as StatusPayload;
        setStatus(payload.status);
        setStt(payload.stt);
        setInvokedTabId(payload.invokedTabId);
        if (payload.overlay != null) setOverlay(payload.overlay);
        if (payload.error) showError(payload.error, payload.errorCode);
      }
      if (message?.type === 'STT_STATUS') setStt(message.stt);
      if (message?.type === 'OFFSCREEN_ERROR') showError(message.message, message.errorCode);
      // 언어팩 다운로드 같은 진행 상황은 오류가 아니다. 알림 줄로만 보여준다.
      if (message?.type === 'OFFSCREEN_NOTICE') setNotice(String(message.message ?? ''));
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [showError]);

  // 사이드패널은 창 하나에 하나뿐이라 탭을 바꾸면 세션도 따라가야 한다.
  // 캡처 중에는 캡처 중인 탭에 고정한다.
  useEffect(() => {
    const rebind = () => {
      void syncActiveTab().catch(() => {});
    };
    const onActivated = () => rebind();
    const onUpdated = (_tabId: number, changeInfo: { url?: string; title?: string }) => {
      if (changeInfo.url || changeInfo.title) rebind();
    };
    const onFocus = () => rebind();
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(onFocus);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(onFocus);
    };
  }, []);

  // 자막을 받는 동안에는 탭 주소가 바뀌어도 위 rebind 가 노트를 갈아타지 않는다.
  // 그 사이에 다음 영상으로 넘어갔다면 배경이 자막을 끊고, 화면에는 이전 영상의 노트만 남는다.
  // 그대로 [자막 시작] 을 누르면 새 영상 자막이 이전 노트에 쌓이므로, 끝난 그 순간 현재 탭에 다시 맞춘다.
  const prevStatusRef = useRef<SessionStatus>('READY');
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (!shouldResyncTab(prev, status)) return;
    void syncActiveTab().catch(() => {});
  }, [status]);

  // 사용자가 위로 스크롤해 읽는 중이면 새 자막이 와도 끌어내리지 않는다.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [items, showAll, tab]);

  function onListScroll() {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= config.autoScrollThresholdPx;
    if (near === stickRef.current) return;
    stickRef.current = near;
    setAutoScroll(near);
  }

  function toggleAutoScroll() {
    const next = !stickRef.current;
    stickRef.current = next;
    setAutoScroll(next);
    const el = listRef.current;
    if (next && el) el.scrollTop = el.scrollHeight;
  }

  // 강의 재생 위치는 페이지 안에서만 알 수 있다. 영상이 없으면 표시를 지우고 폴링 간격을 늘린다.
  useEffect(() => {
    let alive = true;
    let misses = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (current?.id != null) {
          const res = await chrome.runtime.sendMessage({ type: 'VIDEO_TIME_GET', tabId: current.id });
          if (!alive) return;
          if (res?.ok) {
            misses = 0;
            setVideoTime({ cur: res.videoTimeSec, dur: res.durationSec });
          } else if ((misses += 1) >= 3) {
            setVideoTime(null);
          }
        }
      } catch {
        /* 서비스 워커가 자는 중일 수 있다. 다음 주기에 다시 시도한다. */
      }
      // 자막을 받는 동안에만 촘촘히 본다. 대기 중에 2초마다 모든 프레임에 스크립트를 넣으면
      // 사용자가 여는 탭마다 부담이 된다(광고 iframe 포함).
      const live = statusRef.current === 'CAPTURING' || statusRef.current === 'PAUSED';
      const delay = misses >= 3 ? 30000 : live ? 2000 : 15000;
      if (alive) timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  /** 세션 하나를 화면에 올린다. 자막/캡처/메모를 DB 에서 다시 읽는다. */
  async function applySession(current: StudySession): Promise<void> {
    // 다른 노트로 넘어가기 전에 아직 저장 안 된 메모를 먼저 기록한다.
    if (pendingMemo.current != null) await flushMemo();
    setSession(current);
    setMemo(current.generalMemo);
    setError('');
    setNotice('');
    setShowAll(false);
    stickRef.current = true;
    if (statusRef.current === 'STOPPED') setStatus('READY');
    const bundle = await loadSessionBundle(current.id);
    setItems(capSegments(bundle.transcripts, config.maxTranscriptSegmentsInMemory));
    setCaptures([...bundle.captures].reverse());
  }

  /**
   * 현재 활성 탭을 확인하고, 필요하면 그 탭의 노트로 갈아탄다.
   * 탭 정보(activeTabId/activeKey)는 항상 갱신하되 세션 교체는
   * 자막을 받는 중이거나 사용자가 이전 노트를 열어둔 동안에는 하지 않는다.
   */
  async function syncActiveTab(): Promise<void> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    setActiveTabId(tab?.id);
    setActiveKey(pageKeyOf(tab?.url));
    if (pinnedRef.current) return;
    if (statusRef.current === 'CAPTURING' || statusRef.current === 'PAUSED') return;
    const current = await getOrCreateSession({ id: tab?.id, url: tab?.url, title: tab?.title });
    if (sessionRef.current?.id === current.id) {
      setSession(current);
      return;
    }
    await applySession(current);
  }

  /** 노트 목록을 다시 읽는다. 목록을 열 때와 노트를 만들/지울 때만 호출한다. */
  async function refreshSessions(): Promise<void> {
    try {
      setSessions(await listSessions());
    } catch {
      showError('저장된 노트 목록을 읽지 못했습니다.', 'STORAGE_READ_FAILED');
    }
  }

  function toggleSessions() {
    const next = !showSessions;
    setShowSessions(next);
    if (next) void refreshSessions();
  }

  /** 자막을 받는 중에는 노트를 갈아탈 수 없다. 자막이 엉뚱한 노트에 쌓이는 것을 막는다. */
  function blockedByCapture(): boolean {
    if (statusRef.current !== 'CAPTURING' && statusRef.current !== 'PAUSED') return false;
    showError('자막을 받는 중에는 노트를 바꿀 수 없습니다. 먼저 종료를 눌러주세요.');
    return true;
  }

  /** 같은 강의라도 노트를 새로 판다. 예전 노트는 목록에 그대로 남는다. */
  async function newNote() {
    if (busy || blockedByCapture()) return;
    setBusy(true);
    try {
      if (pendingMemo.current != null) await flushMemo();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const fresh = await createFreshSession({ id: tab?.id, url: tab?.url, title: tab?.title });
      pinnedRef.current = false;
      setPinned(false);
      await applySession(fresh);
      await refreshSessions();
      setNotice('새 노트를 시작했습니다. 이전 노트는 목록에 남아 있습니다.');
    } catch (err) {
      showError(String(err), 'STORAGE_WRITE_FAILED');
    } finally {
      setBusy(false);
    }
  }

  /**
   * 목록에서 이전 노트를 연다.
   * updatedAt 은 일부러 건드리지 않는다. 올려버리면 그 노트가 그 페이지의 "현재 노트"가 되어
   * 현재 탭 노트로 돌아가기가 제자리걸음이 된다(원래 쓰던 노트로 못 돌아온다).
   */
  async function openSession(summary: SessionSummary) {
    if (busy || blockedByCapture() || summary.session.id === sessionRef.current?.id) return;
    setBusy(true);
    try {
      pinnedRef.current = true;
      setPinned(true);
      await applySession(summary.session);
      setShowSessions(false);
      await refreshSessions();
    } catch (err) {
      showError(String(err), 'STORAGE_READ_FAILED');
    } finally {
      setBusy(false);
    }
  }

  /** 노트를 통째로 지운다(자막·캡처·이미지까지). 현재 열어둔 노트면 현재 탭 노트로 돌아간다. */
  async function removeSession(summary: SessionSummary) {
    if (busy) return;
    const wasCurrent = summary.session.id === sessionRef.current?.id;
    if (wasCurrent && blockedByCapture()) return;
    setBusy(true);
    try {
      await deleteSession(summary.session.id);
      if (wasCurrent) {
        pendingMemo.current = null;
        pinnedRef.current = false;
        setPinned(false);
        await syncActiveTab();
      }
      await refreshSessions();
      setNotice('노트를 삭제했습니다.');
    } catch (err) {
      showError(String(err), 'STORAGE_WRITE_FAILED');
    } finally {
      setBusy(false);
    }
  }

  /**
   * "현재 자막 지우기". 이 영상의 자막만 비운다. 메모와 캡처는 건드리지 않는다.
   * (노트를 통째로 지우는 것은 기록 목록의 [삭제] 이다. 잘못 눌러도 캡처를 잃지 않도록 둘을 갈라 놓았다.)
   */
  async function clearCurrentTranscripts() {
    const current = sessionRef.current;
    if (!current || busy || blockedByCapture()) return;
    setBusy(true);
    try {
      const removed = await clearSessionTranscripts(current.id);
      setItems([]);
      setShowAll(false);
      stickRef.current = true;
      await refreshSessions();
      setNotice(removed ? `현재 자막 ${removed}줄을 지웠습니다. 메모와 캡처는 그대로입니다.` : '지울 자막이 없습니다.');
    } catch (err) {
      showError(String(err), 'STORAGE_WRITE_FAILED');
    } finally {
      setBusy(false);
    }
  }

  /** 이전 노트 보기를 끝내고 현재 탭의 노트로 돌아온다. */
  async function backToCurrentTab() {
    pinnedRef.current = false;
    setPinned(false);
    await syncActiveTab().catch(() => {});
  }

  async function init() {
    // 예전 버전에서 고른 엔진 값이 남아 있을 수 있다. 이제 인식기는 Chrome 내장 하나뿐이라 읽지 않고 지운다.
    void chrome.storage.local.remove('sttEngine').catch(() => {});
    try {
      await syncActiveTab();
      void cleanupOrphanBlobs().catch(() => {});
    } catch (err) {
      showError(String(err), 'STORAGE_READ_FAILED');
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: 'STATUS_GET' });
      if (res?.ok) {
        setStatus(res.status as SessionStatus);
        setStt(res.stt as STTConnectionStatus);
        setInvokedTabId(res.invokedTabId as number | undefined);
        if (res.overlay != null) setOverlay(Boolean(res.overlay));
      }
    } catch {
      /* 서비스 워커가 아직 안 떴을 수 있다. 사용자가 버튼을 누르면 다시 깨어난다. */
    }
  }

  async function command(type: 'CAPTION_START' | 'CAPTION_PAUSE' | 'CAPTION_RESUME' | 'CAPTION_STOP') {
    const current = sessionRef.current;
    if (!current || busy) return;
    setBusy(true);
    setError('');
    // 언어팩 설치(install)는 클릭의 일시적 활성화 안에서만 시작할 수 있다.
    // offscreen 문서에는 활성화가 없어 NotAllowedError 가 났었다. 그래서 여기서, 첫 await 보다 먼저,
    // 동기적으로 시작만 시켜 둔다. 이미 깔려 있으면 아무 일도 일어나지 않는다.
    if (type === 'CAPTION_START') {
      void requestLanguagePack(config.chromeSpeechLang);
    }
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const res = await chrome.runtime.sendMessage({
        type,
        tabId: tab?.id,
        sessionId: current.id,
        contextPrompt: current.pageTitle,
        engine: config.defaultSttEngine
      });
      if (!res?.ok) {
        showError(res?.error ?? '명령을 실행하지 못했습니다.');
        return;
      }
      if (res.ignored && res.reason) setNotice(res.reason);
      const next = res.status as SessionStatus;
      setStatus(next);
      await db.sessions.update(current.id, { status: next, updatedAt: Date.now() }).catch(() => {});
    } catch (err) {
      showError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function capture() {
    const current = sessionRef.current;
    if (!current || busy) return;
    setBusy(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const res: CaptureResponse = await chrome.runtime.sendMessage({ type: 'CAPTURE_REQUEST', tabId: tab?.id });
      if (!res?.ok || !res.dataUrl) {
        showError(res?.error ?? '캡처에 실패했습니다.', res?.errorCode ?? 'SCREENSHOT_FAILED');
        return;
      }
      const { blob, cropped } = await toCaptureBlob(res.dataUrl, res.videoRect);
      const imageBlobId = await putImageBlob(blob);
      const record: CaptureRecord = {
        id: crypto.randomUUID(),
        sessionId: current.id,
        imageBlobId,
        captureType: captureTypeFor(cropped),
        videoTimeSec: res.videoTimeSec ?? res.videoRect?.videoTimeSec,
        pageUrl: res.pageUrl ?? current.pageUrl,
        createdAt: Date.now(),
        memo: ''
      };
      await db.captures.add(record);
      setCaptures((prev) => [record, ...prev]);
      if (!cropped) setNotice('재생 중인 영상 영역을 찾지 못해 화면 전체를 저장했습니다.');
    } catch (err) {
      showError(String(err), 'STORAGE_WRITE_FAILED');
    } finally {
      setBusy(false);
    }
  }

  /** 지금 이 순간의 재생 위치를 다시 물어본다. 대기 중에는 15초마다만 갱신되므로 값이 낡을 수 있다. */
  async function probeVideoTimeNow(): Promise<number | undefined> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) return undefined;
      const res = await chrome.runtime.sendMessage({ type: 'VIDEO_TIME_GET', tabId: tab.id });
      return res?.ok ? (res.videoTimeSec as number | undefined) : undefined;
    } catch {
      return undefined;
    }
  }

  /** 캡처 없이 메모만 남긴다. 캡처와 같은 타임라인에 같은 모양으로 쌓인다. */
  async function addMemoNote() {
    const current = sessionRef.current;
    if (!current || busy) return;
    setBusy(true);
    try {
      const videoTimeSec = await probeVideoTimeNow();
      const record: CaptureRecord = {
        id: crypto.randomUUID(),
        sessionId: current.id,
        captureType: 'MEMO',
        videoTimeSec,
        pageUrl: current.pageUrl,
        createdAt: Date.now(),
        memo: ''
      };
      await db.captures.add(record);
      setCaptures((prev) => [record, ...prev]);
      setTab('note');
      // 새 카드가 그려진 뒤에 커서를 넣는다.
      setTimeout(() => document.getElementById(`memo-${record.id}`)?.focus(), 0);
    } catch (err) {
      showError(String(err), 'STORAGE_WRITE_FAILED');
    } finally {
      setBusy(false);
    }
  }

  /** 입력은 즉시 반영하고 저장만 지연시킨다. 저장 실패해도 입력값은 유지된다. */
  function onMemoChange(value: string) {
    setMemo(value);
    pendingMemo.current = value;
    setMemoSave('SAVING');
    if (memoTimer.current) clearTimeout(memoTimer.current);
    memoTimer.current = setTimeout(() => void flushMemo(), config.memoSaveDebounceMs);
  }

  async function flushMemo() {
    const current = sessionRef.current;
    const value = pendingMemo.current;
    if (!current || value == null) return;
    try {
      await db.sessions.update(current.id, { generalMemo: value, updatedAt: Date.now() });
      setSession({ ...current, generalMemo: value });
      pendingMemo.current = null;
      setMemoSave('SAVED');
    } catch {
      setMemoSave('FAILED');
    }
  }

  async function updateCaptureMemo(id: string, value: string) {
    setCaptures((prev) => prev.map((c) => (c.id === id ? { ...c, memo: value } : c)));
    try {
      await db.captures.update(id, { memo: value });
    } catch {
      showError('캡처 메모 저장에 실패했습니다.', 'STORAGE_WRITE_FAILED');
    }
  }

  async function removeCapture(record: CaptureRecord) {
    try {
      await deleteCapture(record);
      setCaptures((prev) => prev.filter((c) => c.id !== record.id));
    } catch {
      showError('캡처 삭제에 실패했습니다.', 'STORAGE_WRITE_FAILED');
    }
  }

  /** 영상 위 자막 오버레이 on/off. 끄면 배경이 즉시 걷어낸다. */
  function toggleOverlay() {
    const next = !overlay;
    setOverlay(next);
    void chrome.runtime.sendMessage({ type: 'OVERLAY_SET', enabled: next }).catch(() => {});
  }

  function captureMeta(record: CaptureRecord): ExportCaptureMeta {
    return {
      title: sessionRef.current?.pageTitle ?? '강의',
      pageUrl: record.pageUrl ?? sessionRef.current?.pageUrl,
      videoTimeSec: record.videoTimeSec,
      memo: record.memo ?? '',
      createdAt: record.createdAt
    };
  }

  async function captureBlob(record: CaptureRecord): Promise<Blob> {
    if (record.imageBlobId) {
      const blob = await getImageBlob(record.imageBlobId);
      if (blob) return blob;
    }
    if (record.dataUrl) return await (await fetch(record.dataUrl)).blob();
    throw new Error('캡처 이미지를 찾을 수 없습니다.');
  }

  /** 캡처 + 메모를 한 장의 PNG 로 합친다. 클립보드와 파일 저장이 같은 결과물을 쓴다. */
  async function composedCapture(record: CaptureRecord): Promise<Blob> {
    const meta = captureMeta(record);
    return composeCaptureImage({
      blob: await captureBlob(record),
      title: meta.title,
      videoTimeSec: meta.videoTimeSec,
      memo: meta.memo
    });
  }

  /**
   * 캡처와 메모를 함께 복사한다.
   * 이미지와 텍스트를 따로 넣으면 붙여넣는 앱이 둘 중 하나만 고르므로,
   * 메모까지 그려 넣은 PNG 를 주 형식으로 두고 text/plain 은 보조로만 붙인다.
   * ClipboardItem 은 사용자 제스처 안에서 동기적으로 만들어야 한다(그래서 await 를 앞에 두지 않는다).
   */
  function copyCapture(record: CaptureRecord) {
    const meta = captureMeta(record);
    const text = captureClipboardText(meta);
    // 메모만 있는 항목은 합칠 이미지가 없다. 그대로 텍스트만 복사한다.
    if (!hasImage(record)) {
      void copy(text, '메모를');
      return;
    }
    try {
      const item = new ClipboardItem({
        'image/png': composedCapture(record),
        'text/plain': new Blob([text], { type: 'text/plain' })
      });
      void navigator.clipboard
        .write([item])
        .then(() => setNotice('캡처와 메모를 함께 복사했습니다.'))
        .catch(() => void copy(text, '캡처 메모를'));
    } catch {
      void copy(text, '캡처 메모를');
    }
  }

  async function saveCapture(record: CaptureRecord) {
    if (!hasImage(record)) {
      showError('이미지가 없는 메모는 PNG 로 저장할 수 없습니다. 복사를 쓰거나 전체 저장에 담으세요.');
      return;
    }
    try {
      downloadBlob(await composedCapture(record), captureFileName(captureMeta(record)));
      setNotice('캡처와 메모를 PNG 로 저장했습니다.');
    } catch (err) {
      showError(`캡처 저장에 실패했습니다: ${String((err as Error)?.message ?? err)}`);
    }
  }

  /** 강의 하나를 파일 한 개(HTML)로 묶는다. 캡처 이미지는 data URI 로 안에 들어간다. */
  async function saveAll() {
    const current = sessionRef.current;
    if (!current || busy) return;
    setBusy(true);
    try {
      if (pendingMemo.current != null) await flushMemo();
      // 화면에는 최근 자막만 남지만 저장은 전부 해야 한다. DB 에서 다시 읽는다.
      const bundle = await loadSessionBundle(current.id);
      const shots = [];
      for (const record of bundle.captures) {
        // 이미지를 못 읽어도(또는 원래 없어도) 메모는 반드시 담는다. dataUrl 만 비워서 넣는다.
        let dataUrl = '';
        if (hasImage(record)) {
          try {
            dataUrl = await blobToDataUrl(await captureBlob(record));
          } catch {
            /* 이미지가 사라진 캡처 → 메모만 남긴다 */
          }
        }
        shots.push({
          dataUrl,
          memo: record.memo ?? '',
          videoTimeSec: record.videoTimeSec,
          createdAt: record.createdAt,
          captureType: record.captureType
        });
      }
      const html = buildSessionHtml({
        title: current.pageTitle || '강의',
        pageUrl: current.pageUrl ?? '',
        generalMemo: pendingMemo.current ?? memo,
        transcripts: bundle.transcripts.map((item) => ({ startedAtMs: item.startedAtMs, text: item.text })),
        captures: shots,
        exportedAt: Date.now()
      });
      downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), bundleFileName(current.pageTitle || '강의', Date.now()));
      const withImage = shots.filter((shot) => shot.dataUrl).length;
      setNotice(`캡처 ${withImage}장 · 메모 ${shots.length - withImage}개 · 자막 ${bundle.transcripts.length}줄을 HTML 한 파일로 저장했습니다.`);
    } catch (err) {
      showError(`전체 저장에 실패했습니다: ${String((err as Error)?.message ?? err)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 화면에는 최근 자막만 남는다. 전체 복사는 저장된 전부를 DB 에서 다시 읽어 복사한다. */
  async function copyAllTranscript() {
    const current = sessionRef.current;
    if (!current) return;
    try {
      const bundle = await loadSessionBundle(current.id);
      const text = transcriptToText(bundle.transcripts);
      if (!text) {
        setNotice('복사할 자막이 아직 없습니다.');
        return;
      }
      await copy(text, `자막 ${bundle.transcripts.length}줄을`);
    } catch {
      await copy(transcriptToText(items), '자막을');
    }
  }

  async function copy(text: string, label: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${label} 복사했습니다.`);
    } catch {
      showError('클립보드 복사에 실패했습니다.');
    }
  }

  const live = status === 'CAPTURING';
  const visible = showAll ? items : items.slice(-config.transcriptRenderWindow);
  const hidden = items.length - visible.length;
  const statusText = useMemo(
    () => ({ READY: '대기 중', CAPTURING: '실시간 연결됨', PAUSED: '일시정지', STOPPED: '종료됨', ERROR: '오류' })[status],
    [status]
  );
  const memoText = { IDLE: '', SAVING: '저장 중...', SAVED: '저장됨', FAILED: '저장 실패' }[memoSave];
  const latestShot = captures.find(hasImage);
  const shotCount = captures.filter(hasImage).length;
  // 이전 노트를 열어둔 채 다른 페이지를 보고 있으면 자막/캡처가 엉뚱한 노트에 쌓인다. 그래서 막는다.
  const offTab = pinned && activeKey !== '' && session != null && session.pageKey !== activeKey;
  const clock = videoTime?.cur != null ? `${fmtClock(videoTime.cur)}${videoTime.dur ? ` / ${fmtClock(videoTime.dur)}` : ''}` : '';
  // 아이콘 클릭으로 이 탭을 "호출"하지 않으면 tabCapture 가 거부된다. 누르기 전에 미리 알려준다.
  const needsInvoke = !live && status !== 'PAUSED' && activeTabId != null && invokedTabId !== activeTabId;

  return (
    <div className="app">
      <header className="app-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            📖
          </span>
          <div>
            <h1>SideNote</h1>
            <p>강의를 보면서 자막을 보고, 노트를 한 번에.</p>
          </div>
        </div>
        <span className={`conn ${status.toLowerCase()}`} title={`STT ${STT_STATUS_TEXT[stt]}`}>
          <i />
          {statusText}
        </span>
      </header>

      <section className="lecture">
        <div className="lecture-thumb">
          {latestShot ? <CaptureImage capture={latestShot} /> : <span aria-hidden>▶</span>}
        </div>
        <div className="lecture-meta">
          <strong title={session?.pageUrl}>{session?.pageTitle ?? '현재 탭 확인 중'}</strong>
          <small>{hostOf(session?.pageUrl) || '탭 정보를 읽는 중'}</small>
          {clock && <span className="lecture-time">{clock}</span>}
        </div>
      </section>

      <div className="controls">
        <button
          className="primary"
          disabled={busy || live || offTab}
          onClick={() => void command(status === 'PAUSED' ? 'CAPTION_RESUME' : 'CAPTION_START')}
        >
          <span aria-hidden>CC</span>
          {status === 'PAUSED' ? '계속하기' : '자막 시작'}
        </button>
        <button disabled={busy || !live} onClick={() => void command('CAPTION_PAUSE')}>
          <span aria-hidden>❚❚</span>일시정지
        </button>
        <button disabled={busy || (!live && status !== 'PAUSED')} onClick={() => void command('CAPTION_STOP')}>
          <span aria-hidden>■</span>종료
        </button>
        <button disabled={busy || offTab} onClick={() => void capture()}>
          <span aria-hidden>◎</span>캡처
        </button>
      </div>

      <div className="listbar toolbar">
        <button className={`switch ${overlay ? 'on' : ''}`} onClick={toggleOverlay} aria-pressed={overlay}>
          <i />
          영상 위 자막
        </button>
        <button className={`ghost ${showSessions ? 'accent' : ''}`} onClick={toggleSessions} aria-expanded={showSessions}>
          기록 {showSessions ? '▴' : '▾'}
        </button>
        <button className="ghost" disabled={busy} onClick={() => void saveAll()}>
          전체 저장
        </button>
      </div>

      {showSessions && (
        <section className="block sessions">
          <div className="block-head">
            <h2>
              기록 <span>{sessions.length}</span>
            </h2>
            <button
              className="ghost accent"
              disabled={busy}
              title="이 영상의 자막·메모·캡처를 새로 시작합니다. 지금까지 쌓인 것은 기록에 남습니다."
              onClick={() => void newNote()}
            >
              + 새 자막 시작
            </button>
          </div>
          <p className="hint-line">
            영상이 바뀌면 자막은 자동으로 새로 시작하고, 보던 영상으로 돌아오면 그 자막을 이어서 씁니다. 기록은 이
            브라우저 안(IndexedDB)에만 저장됩니다.
          </p>
          {!sessions.length ? (
            <p className="empty">저장된 기록이 없습니다.</p>
          ) : (
            <ul className="session-list">
              {sessions.map((item) => (
                <li key={item.session.id} className={item.session.id === session?.id ? 'on' : ''}>
                  <button
                    className="session-open"
                    disabled={busy}
                    onClick={() => void openSession(item)}
                    title={item.session.pageUrl}
                  >
                    <strong>{item.session.pageTitle || '제목 없음'}</strong>
                    <small>
                      {hostOf(item.session.pageUrl) || '주소 없음'} · {fmtDate(item.session.updatedAt)} · 자막{' '}
                      {item.transcriptCount} · 캡처/메모 {item.captureCount}
                    </small>
                  </button>
                  {item.session.id === session?.id && <span className="chip">보는 중</span>}
                  <button className="danger" disabled={busy} onClick={() => void removeSession(item)}>
                    삭제
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {pinned && (
        <div className="hint">
          <span>
            {offTab
              ? '지금 보고 있는 탭과 다른 강의의 노트를 열어둔 상태입니다. 자막·캡처는 잠시 잠겼습니다.'
              : '목록에서 연 노트를 보고 있습니다. 탭을 옮겨도 이 노트가 유지됩니다.'}
          </span>
          <button onClick={() => void backToCurrentTab()}>현재 탭 노트로 ›</button>
        </div>
      )}
      {needsInvoke && !offTab && (
        <div className="hint">
          이 탭의 오디오를 캡처하려면 툴바의 확장 아이콘을 한 번 눌러주세요. (Chrome 정책상 페이지를 이동하면 권한이 초기화됩니다)
        </div>
      )}
      {error && (
        <div className="error">
          <span>{error}</span>
          <button onClick={() => setError('')}>×</button>
        </div>
      )}
      {notice && (
        <div className="notice">
          <span>{notice}</span>
          <button onClick={() => setNotice('')}>×</button>
        </div>
      )}

      <nav className="tabs">
        <button className={tab === 'note' ? 'on' : ''} onClick={() => setTab('note')}>
          노트{captures.length > 0 && <em>{captures.length}</em>}
        </button>
        <button className={tab === 'caption' ? 'on' : ''} onClick={() => setTab('caption')}>
          현재 자막{items.length > 0 && <em>{items.length}</em>}
        </button>
      </nav>

      {tab === 'note' ? (
        <>
          <section className="block">
            <div className="block-head">
              <h2>강의 메모</h2>
              <em className={`save ${memoSave.toLowerCase()}`}>{memoText}</em>
              {memoSave === 'FAILED' && (
                <button className="ghost" onClick={() => void flushMemo()}>
                  다시 시도
                </button>
              )}
            </div>
            <textarea
              className="note-full"
              value={memo}
              onChange={(e) => onMemoChange(e.target.value)}
              placeholder="이 강의 전체에 대한 생각, 궁금한 점, 추가로 학습할 내용을 적어보세요..."
            />
          </section>

          <section className="block">
            <div className="block-head">
              <h2>
                타임라인 <span>캡처 {shotCount} · 메모 {captures.length - shotCount}</span>
              </h2>
              <button className="ghost accent" disabled={busy || offTab} onClick={() => void addMemoNote()}>
                + 메모만 추가
              </button>
            </div>
            {!captures.length && (
              <p className="empty">
                캡처를 누르면 지금 화면이, 메모만 추가를 누르면 지금 재생 위치가 여기에 시간 순으로 쌓입니다.
              </p>
            )}
            {captures.map((item) => (
              <article className={`capture ${hasImage(item) ? '' : 'memo-only'}`} key={item.id}>
                <div className="capture-meta">
                  <span className="chip">
                    {item.videoTimeSec != null ? `영상 ${fmtClock(item.videoTimeSec)}` : fmtDate(item.createdAt)}
                  </span>
                  <span className="tag">
                    {item.captureType === 'VIDEO_REGION' ? '영상 영역' : item.captureType === 'VIEWPORT' ? '화면 전체' : '메모'}
                  </span>
                  <button className="ghost" onClick={() => copyCapture(item)}>
                    복사
                  </button>
                  {hasImage(item) && (
                    <button className="ghost" onClick={() => void saveCapture(item)}>
                      저장
                    </button>
                  )}
                  <button className="danger" onClick={() => void removeCapture(item)}>
                    삭제
                  </button>
                </div>
                {hasImage(item) && <CaptureImage capture={item} />}
                <textarea
                  id={`memo-${item.id}`}
                  value={item.memo}
                  onChange={(e) => void updateCaptureMemo(item.id, e.target.value)}
                  placeholder={hasImage(item) ? '이 장면에 대한 메모' : '이 시점에 대한 메모'}
                />
              </article>
            ))}
          </section>
        </>
      ) : (
        <>
          <div className="listbar">
            <button className={`switch ${autoScroll ? 'on' : ''}`} onClick={toggleAutoScroll} aria-pressed={autoScroll}>
              <i />
              자동 스크롤
            </button>
            <button className="ghost" onClick={() => void copyAllTranscript()}>
              전체 복사
            </button>
            <button
              className="ghost"
              disabled={busy || !items.length}
              title="이 영상의 자막만 지웁니다. 메모와 캡처는 그대로 남습니다."
              onClick={() => void clearCurrentTranscripts()}
            >
              현재 자막 지우기
            </button>
          </div>
          <div className="transcript compact" ref={listRef} onScroll={onListScroll}>
            {!items.length && (
              <p className="empty">자막 시작을 누르면 지금 보고 있는 영상의 음성이 여기에 쌓입니다.</p>
            )}
            {visible.map((item) => (
              <div key={item.id} className={item.status === 'FINAL' ? 'line final' : 'line partial'}>
                <time>{fmtMs(item.startedAtMs)}</time>
                <p>{item.text}</p>
                <button onClick={() => void copy(item.text, '자막을')}>복사</button>
              </div>
            ))}
          </div>
          {hidden > 0 && (
            <button className="ghost wide" onClick={() => setShowAll(true)}>
              이전 자막 {hidden}줄 더 보기
            </button>
          )}
          <p className="hint-line">
            자막은 영상 위에 겹쳐 보여집니다. 여기 목록은 <b>지금 보고 있는 영상</b>의 자막이고, 다른 영상으로
            넘어가면 자동으로 새 자막이 시작됩니다. 이전 영상 자막은 위의 [기록]에 남습니다.
          </p>
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
