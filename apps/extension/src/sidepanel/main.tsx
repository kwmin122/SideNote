import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { config } from '../config';
import type {
  CaptionMode,
  CaptureRecord,
  CaptureResponse,
  ErrorCode,
  SaveStatus,
  SessionStatus,
  StatusPayload,
  StudySession,
  TranscriptSegment
} from '../shared/contracts';
import { errorMessage } from '../shared/contracts';
import { captureTypeFor, computeCropRect } from '../shared/capture';
import { pageKeyOf } from '../shared/url';
import { shouldResyncTab } from '../shared/state';
import { capSegments, lineToText, mergeSegment, transcriptToText } from '../shared/transcripts';
import {
  buildSessionHtml,
  bundleFileName,
  captureClipboardText,
  captureFileName,
  type ExportCaptureMeta
} from '../shared/export';
import { requestLanguagePack } from '../transcription/chrome-speech';
import { t, uiLanguage } from '../shared/i18n';
import {
  CAPTION_LANGUAGES,
  CAPTION_MODES,
  TRANSLATION_TARGETS,
  defaultCaptionLanguage,
  defaultTranslationTarget,
  normalizeCaptionLanguage,
  normalizeCaptionMode,
  normalizeTranslationTarget,
  translationSourceOf
} from '../shared/languages';
import { prepareTranslator, translatorSupported } from '../transcription/translator';
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
  if (!src) return <div className="capture-missing">{t('uiImageLoadFailed')}</div>;
  return <img src={src} alt={t('uiCaptureAlt')} />;
}

function App() {
  const [session, setSession] = useState<StudySession | null>(null);
  const [items, setItems] = useState<TranscriptSegment[]>([]);
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [status, setStatus] = useState<SessionStatus>('READY');
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
  /** 아직 확정되지 않은 줄. 확정될 때까지 몇십 초 걸리기도 해서 오는 대로 보여준다. */
  const [liveLine, setLiveLine] = useState('');
  const [overlay, setOverlay] = useState(true);
  const [videoTime, setVideoTime] = useState<{ cur?: number; dur?: number } | null>(null);
  /** 인식할 말소리의 언어. 화면 글자 언어(브라우저 설정)와 별개다. */
  const [lang, setLang] = useState(() => defaultCaptionLanguage(uiLanguage()));
  const langRef = useRef(lang);
  /** 자막을 옮겨 볼 언어. 번역 모드일 때만 쓴다. */
  const [translateTo, setTranslateTo] = useState('');
  const translateRef = useRef('');
  /** 자막을 보여 주는 방식. 원문 / 번역 / 원문+번역. */
  const [mode, setMode] = useState<CaptionMode>('original');
  const modeRef = useRef<CaptionMode>('original');
  /** 자막 설정(모드·언어)을 펼쳐 놓았는가. 패널이 좁아서 평소에는 접어 둔다. */
  const [showSettings, setShowSettings] = useState(false);
  /** 이 Chrome 에 내장 번역기가 있는가. 없으면 번역 선택 자체를 감춘다. */
  const [canTranslate] = useState(() => translatorSupported());

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
    setError(code ? `${errorMessage(code)} (${message})` : message);
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
        setInvokedTabId(payload.invokedTabId);
        if (payload.overlay != null) setOverlay(payload.overlay);
        if (payload.error) showError(payload.error, payload.errorCode);
      }
      if (message?.type === 'CAPTION_LIVE') {
        if (sessionRef.current && message.sessionId !== sessionRef.current.id) return;
        setLiveLine(String(message.partial ?? ''));
      }
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
  }, [items, liveLine, showAll, tab]);

  // 자막이 멈추면 진행 중이던 줄도 지운다. 안 그러면 멈춘 화면에 끝나지 않은 줄이 남는다.
  useEffect(() => {
    if (status !== 'CAPTURING' && status !== 'PAUSED') setLiveLine('');
  }, [status]);

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
      showError(t('uiSessionListReadFailed'), 'STORAGE_READ_FAILED');
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
    showError(t('uiCannotSwitchWhileCapturing'));
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
      setNotice(t('uiNewNoteStarted'));
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
      setNotice(t('uiNoteDeleted'));
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
      setNotice(removed ? t('uiTranscriptCleared', removed) : t('uiNothingToClear'));
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
      const saved = await chrome.storage.local.get(['captionLang', 'translateTo', 'captionMode']);
      const next = normalizeCaptionLanguage(saved?.captionLang, uiLanguage());
      langRef.current = next;
      setLang(next);
      // 자막 언어와 같은 언어로 옮길 일은 없다. 예전에 고른 값이 겹치면 다른 언어로 바꿔 준다.
      const target = normalizeTranslationTarget(saved?.translateTo);
      const usable = target && target !== translationSourceOf(next)
        ? target
        : defaultTranslationTarget(uiLanguage(), translationSourceOf(next));
      translateRef.current = usable;
      setTranslateTo(usable);
      // 번역기가 없는 Chrome 에서는 무엇이 저장돼 있든 원문으로 본다.
      const savedMode = translatorSupported() ? normalizeCaptionMode(saved?.captionMode) : 'original';
      modeRef.current = savedMode;
      setMode(savedMode);
    } catch {
      /* 저장소를 못 읽으면 브라우저 언어에서 고른 기본값을 그대로 쓴다. */
    }
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
      void requestLanguagePack(langRef.current);
      if (modeRef.current !== 'original' && translateRef.current) {
        void prepareTranslator(translationSourceOf(langRef.current), translateRef.current);
      }
    }
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const res = await chrome.runtime.sendMessage({
        type,
        tabId: tab?.id,
        sessionId: current.id,
        contextPrompt: current.pageTitle,
        language: langRef.current,
        // 원문만 볼 때는 번역기를 아예 만들지 않는다.
        translateTo: modeRef.current === 'original' ? '' : translateRef.current,
        mode: modeRef.current,
        engine: config.defaultSttEngine
      });
      if (!res?.ok) {
        showError(res?.error ?? t('uiCommandFailed'));
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
        showError(res?.error ?? t('uiCaptureFailed'), res?.errorCode ?? 'SCREENSHOT_FAILED');
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
      if (!cropped) setNotice(t('uiCroppedFallback'));
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
      showError(t('uiCaptureMemoSaveFailed'), 'STORAGE_WRITE_FAILED');
    }
  }

  async function removeCapture(record: CaptureRecord) {
    try {
      await deleteCapture(record);
      setCaptures((prev) => prev.filter((c) => c.id !== record.id));
    } catch {
      showError(t('uiCaptureDeleteFailed'), 'STORAGE_WRITE_FAILED');
    }
  }

  /**
   * 자막 언어 변경. 이 change 이벤트는 사용자 제스처라, 여기서 언어팩 내려받기를 시작할 수 있다.
   * (offscreen 문서에는 제스처가 없어 거기서 install() 을 부르면 NotAllowedError 가 난다.)
   */
  function changeLanguage(next: string) {
    langRef.current = next;
    setLang(next);
    void chrome.storage.local.set({ captionLang: next }).catch(() => {});
    void requestLanguagePack(next);
    // 새 자막 언어와 번역 대상이 같아지면 옮길 것이 없다. 목록에서도 사라지므로 다른 언어로 바꿔 둔다.
    if (translateRef.current === translationSourceOf(next)) {
      changeTranslateTo(defaultTranslationTarget(uiLanguage(), translationSourceOf(next)));
    }
  }

  /** 자막을 옮겨 볼 언어 변경. 다음 [자막 시작] 부터 적용된다. */
  function changeTranslateTo(next: string) {
    translateRef.current = next;
    setTranslateTo(next);
    void chrome.storage.local.set({ translateTo: next }).catch(() => {});
    // 이 change 도 사용자 제스처다. 여기서 번역 모델 내려받기를 미리 시작해 둔다.
    if (next && modeRef.current !== 'original') {
      void prepareTranslator(translationSourceOf(langRef.current), next);
    }
  }

  /**
   * 자막 모드 변경. 라디오 클릭도 사용자 제스처라, 여기서 번역 모델을 미리 데울 수 있다.
   * 이미 자막이 돌고 있으면 다음 [자막 시작] 부터 적용된다(그래서 진행 중에는 잠가 둔다).
   */
  function changeMode(next: CaptionMode) {
    modeRef.current = next;
    setMode(next);
    void chrome.storage.local.set({ captionMode: next }).catch(() => {});
    if (next === 'original') return;
    const source = translationSourceOf(langRef.current);
    if (!translateRef.current || translateRef.current === source) {
      changeTranslateTo(defaultTranslationTarget(uiLanguage(), source));
      return;
    }
    void prepareTranslator(source, translateRef.current);
  }

  /** 영상 위 자막 오버레이 on/off. 끄면 배경이 즉시 걷어낸다. */
  function toggleOverlay() {
    const next = !overlay;
    setOverlay(next);
    void chrome.runtime.sendMessage({ type: 'OVERLAY_SET', enabled: next }).catch(() => {});
  }

  function captureMeta(record: CaptureRecord): ExportCaptureMeta {
    return {
      title: sessionRef.current?.pageTitle ?? t('defaultLectureTitle'),
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
    throw new Error(t('uiCaptureImageNotFound'));
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
      void copy(text, t('uiCopiedMemo'));
      return;
    }
    try {
      const item = new ClipboardItem({
        'image/png': composedCapture(record),
        'text/plain': new Blob([text], { type: 'text/plain' })
      });
      void navigator.clipboard
        .write([item])
        .then(() => setNotice(t('uiCopiedCaptureAndMemo')))
        .catch(() => void copy(text, t('uiCopiedCaptureMemo')));
    } catch {
      void copy(text, t('uiCopiedCaptureMemo'));
    }
  }

  async function saveCapture(record: CaptureRecord) {
    if (!hasImage(record)) {
      showError(t('uiPngNeedsImage'));
      return;
    }
    try {
      downloadBlob(await composedCapture(record), captureFileName(captureMeta(record)));
      setNotice(t('uiSavedPng'));
    } catch (err) {
      showError(t('uiSaveCaptureFailed', String((err as Error)?.message ?? err)));
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
        title: current.pageTitle || t('defaultLectureTitle'),
        pageUrl: current.pageUrl ?? '',
        generalMemo: pendingMemo.current ?? memo,
        transcripts: bundle.transcripts.map((item) => ({
          startedAtMs: item.startedAtMs,
          text: item.text,
          translation: item.translation
        })),
        captures: shots,
        exportedAt: Date.now()
      });
      downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), bundleFileName(current.pageTitle || t('defaultLectureTitle'), Date.now()));
      const withImage = shots.filter((shot) => shot.dataUrl).length;
      setNotice(t('uiSavedBundle', withImage, shots.length - withImage, bundle.transcripts.length));
    } catch (err) {
      showError(t('uiSaveBundleFailed', String((err as Error)?.message ?? err)));
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
        setNotice(t('uiNoTranscriptToCopy'));
        return;
      }
      await copy(text, t('uiCopiedTranscriptLines', bundle.transcripts.length));
    } catch {
      await copy(transcriptToText(items), t('uiCopiedTranscript'));
    }
  }

  /** notice 는 이미 완성된 한 문장이다. 언어마다 어순과 조사가 달라 조각을 이어 붙이지 않는다. */
  async function copy(text: string, notice: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setNotice(notice);
    } catch {
      showError(t('uiClipboardFailed'));
    }
  }

  const live = status === 'CAPTURING';
  const visible = showAll ? items : items.slice(-config.transcriptRenderWindow);
  const hidden = items.length - visible.length;
  const memoText = { IDLE: '', SAVING: t('uiMemoSaving'), SAVED: t('uiMemoSaved'), FAILED: t('uiMemoSaveFailed') }[memoSave];
  const latestShot = captures.find(hasImage);
  const shotCount = captures.filter(hasImage).length;
  // 이전 노트를 열어둔 채 다른 페이지를 보고 있으면 자막/캡처가 엉뚱한 노트에 쌓인다. 그래서 막는다.
  const offTab = pinned && activeKey !== '' && session != null && session.pageKey !== activeKey;
  const clock = videoTime?.cur != null ? `${fmtClock(videoTime.cur)}${videoTime.dur ? ` / ${fmtClock(videoTime.dur)}` : ''}` : '';
  // 아이콘 클릭으로 이 탭을 "호출"하지 않으면 tabCapture 가 거부된다. 누르기 전에 미리 알려준다.
  const needsInvoke = !live && status !== 'PAUSED' && activeTabId != null && invokedTabId !== activeTabId;
  // 자막이 도는 중에 언어를 바꾸면 인식기를 다시 띄워야 한다. 멈춘 뒤에 바꾸게 한다.
  const settingsLocked = live || status === 'PAUSED';
  const langLabel = CAPTION_LANGUAGES.find((item) => item.code === lang)?.label ?? lang;
  const targetLabel = TRANSLATION_TARGETS.find((item) => item.code === translateTo)?.label ?? translateTo;
  // 설정을 접어 둔 동안에도 지금 무엇으로 보고 있는지는 버튼에 적어 둔다.
  const settingsSummary = mode === 'original' ? langLabel : `${langLabel} → ${targetLabel}`;
  const modeHint: Record<CaptionMode, string> = {
    original: t('uiModeOriginalHint'),
    translated: t('uiModeTranslatedHint', targetLabel),
    both: t('uiModeBothHint')
  };
  const modeLabel: Record<CaptionMode, string> = {
    original: t('uiModeOriginal'),
    translated: t('uiModeTranslated'),
    both: t('uiModeBoth')
  };
  // 원문을 보여 주지 않는 모드에서는 확정 전의 줄도 보여 주지 않는다(번역은 확정된 뒤에 나온다).
  const showOriginal = mode !== 'translated';
  const showTranslation = mode !== 'original';

  return (
    <div className="app">
      <header className="app-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            📖
          </span>
          <div>
            <h1>SideNote</h1>
            <p>{t('uiTagline')}</p>
          </div>
        </div>
      </header>

      <section className="lecture">
        <div className="lecture-thumb">
          {latestShot ? <CaptureImage capture={latestShot} /> : <span aria-hidden>▶</span>}
        </div>
        <div className="lecture-meta">
          <strong title={session?.pageUrl}>{session?.pageTitle ?? t('uiCheckingTab')}</strong>
          <small>{hostOf(session?.pageUrl) || t('uiReadingTab')}</small>
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
          {status === 'PAUSED' ? t('uiResume') : t('uiStartCaption')}
        </button>
        <button disabled={busy || !live} onClick={() => void command('CAPTION_PAUSE')}>
          <span aria-hidden>❚❚</span>
          {t('uiPause')}
        </button>
        <button disabled={busy || (!live && status !== 'PAUSED')} onClick={() => void command('CAPTION_STOP')}>
          <span aria-hidden>■</span>
          {t('uiStop')}
        </button>
        <button disabled={busy || offTab} onClick={() => void capture()}>
          <span aria-hidden>◎</span>
          {t('uiCapture')}
        </button>
      </div>

      <div className="listbar toolbar">
        <button className={`switch ${overlay ? 'on' : ''}`} onClick={toggleOverlay} aria-pressed={overlay}>
          <i />
          {t('uiOverlay')}
        </button>
        <button className={`ghost ${showSessions ? 'accent' : ''}`} onClick={toggleSessions} aria-expanded={showSessions}>
          {t('uiHistory')} {showSessions ? '▴' : '▾'}
        </button>
        <button className="ghost" disabled={busy} onClick={() => void saveAll()}>
          {t('uiSaveAll')}
        </button>
        <button
          className={`ghost lang-summary ${showSettings ? 'accent' : ''}`}
          onClick={() => setShowSettings((prev) => !prev)}
          aria-expanded={showSettings}
          title={t('uiCaptionSettingsTitle')}
        >
          {settingsSummary} {showSettings ? '▴' : '▾'}
        </button>
      </div>

      {showSettings && (
        <section className="block settings">
          <div className="block-head">
            <h2>{t('uiCaptionSettings')}</h2>
          </div>
          {canTranslate && (
            <fieldset className="modes">
              <legend>{t('uiCaptionMode')}</legend>
              {CAPTION_MODES.map((item) => (
                <label key={item} className={`mode ${mode === item ? 'on' : ''}`}>
                  <input
                    type="radio"
                    name="caption-mode"
                    value={item}
                    checked={mode === item}
                    disabled={settingsLocked}
                    onChange={() => changeMode(item)}
                  />
                  <span>
                    <strong>{modeLabel[item]}</strong>
                    <small>{modeHint[item]}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <label className="field">
            <span>{t('uiSpeechLanguage')}</span>
            <select
              className="lang"
              value={lang}
              disabled={settingsLocked}
              aria-label={t('uiSpeechLanguage')}
              onChange={(e) => changeLanguage(e.target.value)}
            >
              {CAPTION_LANGUAGES.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {canTranslate && mode !== 'original' && (
            <label className="field">
              <span>{t('uiTranslationLanguage')}</span>
              <select
                className="lang translate"
                value={translateTo}
                disabled={settingsLocked}
                aria-label={t('uiTranslationLanguage')}
                onChange={(e) => changeTranslateTo(e.target.value)}
              >
                {TRANSLATION_TARGETS.filter((item) => item.code !== translationSourceOf(lang)).map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="hint-line">
            {!canTranslate
              ? t('uiTranslateUnsupported')
              : settingsLocked
                ? t('uiLanguageChangeWhileLive')
                : t('uiCaptionSettingsHint')}
          </p>
        </section>
      )}

      {showSessions && (
        <section className="block sessions">
          <div className="block-head">
            <h2>
              {t('uiHistory')} <span>{sessions.length}</span>
            </h2>
            <button
              className="ghost accent"
              disabled={busy}
              title={t('uiNewCaptionSessionTitle')}
              onClick={() => void newNote()}
            >
              {t('uiNewCaptionSession')}
            </button>
          </div>
          <p className="hint-line">
            {t('uiHistoryHint')}
          </p>
          {!sessions.length ? (
            <p className="empty">{t('uiNoHistory')}</p>
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
                    <strong>{item.session.pageTitle || t('untitled')}</strong>
                    <small>
                      {hostOf(item.session.pageUrl) || t('uiNoUrl')} · {fmtDate(item.session.updatedAt)} ·{' '}
                      {t('uiCaptionsShort')} {item.transcriptCount} · {t('uiCapturesMemos')} {item.captureCount}
                    </small>
                  </button>
                  {item.session.id === session?.id && <span className="chip">{t('uiViewing')}</span>}
                  <button className="danger" disabled={busy} onClick={() => void removeSession(item)}>
                    {t('uiDelete')}
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
              ? t('uiOffTabWarn')
              : t('uiPinnedNote')}
          </span>
          <button onClick={() => void backToCurrentTab()}>{t('uiBackToCurrentTab')}</button>
        </div>
      )}
      {needsInvoke && !offTab && (
        <div className="hint">
          {t('uiNeedsInvoke')}
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
          {t('uiNavNotes')}
          {captures.length > 0 && <em>{captures.length}</em>}
        </button>
        <button className={tab === 'caption' ? 'on' : ''} onClick={() => setTab('caption')}>
          {t('uiNavCurrentCaptions')}
          {items.length > 0 && <em>{items.length}</em>}
        </button>
      </nav>

      {tab === 'note' ? (
        <>
          <section className="block">
            <div className="block-head">
              <h2>{t('uiLectureMemo')}</h2>
              <em className={`save ${memoSave.toLowerCase()}`}>{memoText}</em>
              {memoSave === 'FAILED' && (
                <button className="ghost" onClick={() => void flushMemo()}>
                  {t('uiRetry')}
                </button>
              )}
            </div>
            <textarea
              className="note-full"
              value={memo}
              onChange={(e) => onMemoChange(e.target.value)}
              placeholder={t('uiMemoPlaceholder')}
            />
          </section>

          <section className="block">
            <div className="block-head">
              <h2>
                {t('uiTimeline')} <span>{t('uiTimelineCounts', shotCount, captures.length - shotCount)}</span>
              </h2>
              <button className="ghost accent" disabled={busy || offTab} onClick={() => void addMemoNote()}>
                {t('uiAddMemoOnly')}
              </button>
            </div>
            {!captures.length && (
              <p className="empty">{t('uiTimelineHint')}</p>
            )}
            {captures.map((item) => (
              <article className={`capture ${hasImage(item) ? '' : 'memo-only'}`} key={item.id}>
                <div className="capture-meta">
                  <span className="chip">
                    {item.videoTimeSec != null ? t('uiVideoAt', fmtClock(item.videoTimeSec)) : fmtDate(item.createdAt)}
                  </span>
                  <span className="tag">
                    {item.captureType === 'VIDEO_REGION' ? t('uiTypeVideoRegion') : item.captureType === 'VIEWPORT' ? t('uiTypeViewport') : t('uiTypeMemo')}
                  </span>
                  <button className="ghost" onClick={() => copyCapture(item)}>
                    {t('uiCopy')}
                  </button>
                  {hasImage(item) && (
                    <button className="ghost" onClick={() => void saveCapture(item)}>
                      {t('uiSave')}
                    </button>
                  )}
                  <button className="danger" onClick={() => void removeCapture(item)}>
                    {t('uiDelete')}
                  </button>
                </div>
                {hasImage(item) && <CaptureImage capture={item} />}
                <textarea
                  id={`memo-${item.id}`}
                  value={item.memo}
                  onChange={(e) => void updateCaptureMemo(item.id, e.target.value)}
                  placeholder={hasImage(item) ? t('uiMemoForScene') : t('uiMemoForMoment')}
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
              {t('uiAutoScroll')}
            </button>
            <button className="ghost" onClick={() => void copyAllTranscript()}>
              {t('uiCopyAll')}
            </button>
            <button
              className="ghost"
              disabled={busy || !items.length}
              title={t('uiClearCurrentCaptionsTitle')}
              onClick={() => void clearCurrentTranscripts()}
            >
              {t('uiClearCurrentCaptions')}
            </button>
          </div>
          <div className="transcript compact" ref={listRef} onScroll={onListScroll}>
            {!items.length && !(liveLine && showOriginal) && (
              <p className="empty">{t('uiEmptyCaptions')}</p>
            )}
            {visible.map((item) => (
              <div key={item.id} className={item.status === 'FINAL' ? 'line final' : 'line partial'}>
                <time>{fmtMs(item.startedAtMs)}</time>
                <p>
                  {showOriginal ? item.text : item.translation || item.text}
                  {showOriginal && showTranslation && item.translation && (
                    <span className="translated">{item.translation}</span>
                  )}
                </p>
                <button onClick={() => void copy(lineToText(item), t('uiCopiedTranscript'))}>{t('uiCopy')}</button>
              </div>
            ))}
            {liveLine && showOriginal && (
              <div className="line live">
                <time>···</time>
                <p>{liveLine}</p>
              </div>
            )}
          </div>
          {hidden > 0 && (
            <button className="ghost wide" onClick={() => setShowAll(true)}>
              {t('uiShowOlder', hidden)}
            </button>
          )}
          <p className="hint-line">
            {t('uiOverlayHint')}
          </p>
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
