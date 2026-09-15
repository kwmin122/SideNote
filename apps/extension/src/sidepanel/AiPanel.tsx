import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureRecord, ErrorCode, ScriptRecord, StudySession, TranscriptSegment } from '../shared/contracts';
import { buildAiContext, contextCharCount, type ContextPick, type ContextSources } from '../ai/context';
import { aiAvailability, createAiSession, promptApiSupported, type AiAvailability, type AiSession } from '../ai/prompt';
import { STUDY_RESPONSE_SCHEMA, buildStudyHtml, coerceStudyDoc, studyFileName } from '../ai/study';
import { getImageBlob } from '../storage/db';
import { downloadBlob } from './compose';
import { t } from '../shared/i18n';

export interface ChatTurn {
  id: string;
  role: 'user' | 'ai';
  text: string;
}

interface AiPanelProps {
  session: StudySession | null;
  transcripts: TranscriptSegment[];
  captures: CaptureRecord[];
  script: ScriptRecord | null;
  memo: string;
  onNotice: (text: string) => void;
  onError: (message: string, code?: ErrorCode) => void;
}

const DEFAULT_PICK: ContextPick = { script: true, transcript: true, memo: false, captures: false };

/** 대화는 패널을 닫으면 사라지지 않게 브라우저 세션 저장소에 둔다(디스크에는 남지 않는다). */
function chatKey(sessionId: string) {
  return `aiChat:${sessionId}`;
}

function hasImage(record: CaptureRecord): boolean {
  return Boolean(record.imageBlobId || record.dataUrl);
}

export function AiPanel({ session, transcripts, captures, script, memo, onNotice, onError }: AiPanelProps) {
  const [availability, setAvailability] = useState<AiAvailability | 'checking'>('checking');
  const [imageOk, setImageOk] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(-1);
  const [pick, setPick] = useState<ContextPick>(DEFAULT_PICK);
  const [showPick, setShowPick] = useState(false);

  const aiRef = useRef<AiSession | null>(null);
  const contextSent = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const sessionId = session?.id ?? '';

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!promptApiSupported()) {
        if (alive) setAvailability('unavailable');
        return;
      }
      const [text, image] = await Promise.all([aiAvailability(false), aiAvailability(true)]);
      if (!alive) return;
      setAvailability(text);
      setImageOk(image !== 'unavailable');
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 노트를 갈아타면 대화도 그 노트의 것으로 바꾼다. 이전 노트의 대화가 섞이면 안 된다.
  useEffect(() => {
    aiRef.current?.destroy();
    aiRef.current = null;
    contextSent.current = false;
    if (!sessionId) {
      setTurns([]);
      return;
    }
    let alive = true;
    void chrome.storage.session
      .get(chatKey(sessionId))
      .then((stored) => {
        if (!alive) return;
        const saved = stored?.[chatKey(sessionId)];
        setTurns(Array.isArray(saved) ? (saved as ChatTurn[]) : []);
      })
      .catch(() => {
        if (alive) setTurns([]);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  useEffect(
    () => () => {
      aiRef.current?.destroy();
      aiRef.current = null;
    },
    []
  );

  // 새 답이 흐르는 동안 항상 마지막 줄이 보이게 둔다.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const persist = useCallback(
    (next: ChatTurn[]) => {
      if (!sessionId) return;
      void chrome.storage.session.set({ [chatKey(sessionId)]: next.slice(-40) }).catch(() => {});
    },
    [sessionId]
  );

  const sources = useCallback(
    (): ContextSources => ({
      title: session?.pageTitle ?? '',
      pageUrl: session?.pageUrl ?? '',
      memo,
      transcripts,
      script: script?.lines ?? [],
      captures: captures.map((capture) => ({ videoTimeSec: capture.videoTimeSec, memo: capture.memo ?? '' }))
    }),
    [session, memo, transcripts, script, captures]
  );

  /** 고른 자료가 바뀌면 지금 열려 있는 대화에는 반영할 수 없다. 대화를 새로 열어 다시 넣는다. */
  function changePick(patch: Partial<ContextPick>) {
    setPick((prev) => ({ ...prev, ...patch }));
    aiRef.current?.destroy();
    aiRef.current = null;
    contextSent.current = false;
  }

  async function ensureAi(): Promise<AiSession> {
    if (aiRef.current) return aiRef.current;
    const created = await createAiSession({
      system: t('aiSystemPrompt'),
      withImage: imageOk,
      onDownload: (percent) => setProgress(percent)
    });
    setProgress(-1);
    aiRef.current = created;
    contextSent.current = false;
    return created;
  }

  /** 질문 앞에 강의 자료를 붙인다. 대화가 이어지는 동안에는 한 번만 붙인다(문맥 창을 아낀다). */
  function withContext(question: string): string {
    if (contextSent.current) return question;
    const context = buildAiContext(sources(), pick);
    contextSent.current = true;
    return `${context}\n\n---\n${question}`;
  }

  async function run(question: string, image?: Blob) {
    if (!question.trim() || busy) return;
    const userTurn: ChatTurn = { id: crypto.randomUUID(), role: 'user', text: question.trim() };
    const aiTurn: ChatTurn = { id: crypto.randomUUID(), role: 'ai', text: '' };
    setTurns((prev) => [...prev, userTurn, aiTurn]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const ai = await ensureAi();
      // 이미지를 같이 보내는 질문은 자료 본문까지 붙이면 문맥이 넘친다. 그때는 질문만 보낸다.
      const prompt = image ? question.trim() : withContext(question.trim());
      const full = await ai.stream(
        prompt,
        (partial) => setTurns((prev) => prev.map((turn) => (turn.id === aiTurn.id ? { ...turn, text: partial } : turn))),
        { image, signal: controller.signal }
      );
      setTurns((prev) => {
        const next = prev.map((turn) => (turn.id === aiTurn.id ? { ...turn, text: full || t('aiEmptyAnswer') } : turn));
        persist(next);
        return next;
      });
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      // 사용자가 [중지] 를 눌렀으면 오류가 아니다. 그때까지 흐른 답을 그대로 둔다.
      const aborted = /abort/i.test(message);
      setTurns((prev) => {
        const next = prev
          .map((turn) => (turn.id === aiTurn.id ? { ...turn, text: turn.text || (aborted ? t('aiStopped') : '') } : turn))
          .filter((turn) => turn.text);
        persist(next);
        return next;
      });
      if (!aborted) onError(message, 'AI_FAILED');
      // 문맥이 넘쳐 실패한 경우가 많다. 다음 질문은 새 대화에서 다시 시작하게 한다.
      aiRef.current?.destroy();
      aiRef.current = null;
      contextSent.current = false;
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress(-1);
    }
  }

  function send() {
    const question = input;
    setInput('');
    void run(question);
  }

  function stop() {
    abortRef.current?.abort();
  }

  function newChat() {
    aiRef.current?.destroy();
    aiRef.current = null;
    contextSent.current = false;
    setTurns([]);
    persist([]);
    onNotice(t('aiNewChatStarted'));
  }

  /** 가장 최근 캡처 이미지를 그대로 모델에 넣고 묻는다. */
  async function askAboutCapture() {
    const shot = captures.find(hasImage);
    if (!shot) {
      onError(t('aiNoCapture'));
      return;
    }
    if (!imageOk) {
      onError(t('aiImageUnsupported'));
      return;
    }
    try {
      const blob = shot.imageBlobId
        ? await getImageBlob(shot.imageBlobId)
        : shot.dataUrl
          ? await (await fetch(shot.dataUrl)).blob()
          : undefined;
      if (!blob) {
        onError(t('aiNoCapture'));
        return;
      }
      await run(t('aiExplainCapturePrompt'), blob);
    } catch (err) {
      onError(String(err), 'AI_FAILED');
    }
  }

  /** 정해진 모양(JSON)으로 받아 HTML 한 장으로 저장한다. 모델이 HTML 을 직접 쓰지는 않는다. */
  async function makeStudyFile() {
    if (busy) return;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const ai = await ensureAi();
      const context = buildAiContext(sources(), pick);
      const answer = await ai.ask(`${context}\n\n---\n${t('aiStudyPrompt')}`, {
        responseConstraint: STUDY_RESPONSE_SCHEMA,
        signal: controller.signal
      });
      const doc = coerceStudyDoc(answer, session?.pageTitle || t('defaultLectureTitle'));
      if (!doc.sections.length && !doc.summary) {
        onError(t('aiStudyFailed'), 'AI_FAILED');
        return;
      }
      const html = buildStudyHtml(doc, {
        pageUrl: session?.pageUrl ?? '',
        generatedAt: Date.now(),
        sourceNote: t('aiStudySource', script?.lines.length ?? 0, transcripts.length)
      });
      downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), studyFileName(doc.title, Date.now()));
      onNotice(t('aiStudySaved', doc.sections.length));
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      if (!/abort/i.test(message)) onError(message, 'AI_FAILED');
      aiRef.current?.destroy();
      aiRef.current = null;
      contextSent.current = false;
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress(-1);
    }
  }

  if (availability === 'checking') {
    return <p className="empty">{t('aiChecking')}</p>;
  }
  if (availability === 'unavailable') {
    return (
      <section className="block">
        <div className="block-head">
          <h2>{t('uiNavAi')}</h2>
        </div>
        <p className="hint-line lead">{t('aiUnavailable')}</p>
        <p className="hint-line">{t('aiUnavailableHow')}</p>
      </section>
    );
  }

  const chars = contextCharCount(sources(), pick);
  const picked = [
    pick.script && t('aiPickScript'),
    pick.transcript && t('aiPickTranscript'),
    pick.memo && t('aiPickMemo'),
    pick.captures && t('aiPickCaptureMemos')
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <div className="listbar">
        <button className={`ghost ${showPick ? 'accent' : ''}`} onClick={() => setShowPick((prev) => !prev)} aria-expanded={showPick}>
          {t('aiContextButton')} {showPick ? '▴' : '▾'}
        </button>
        <button className="ghost" disabled={busy || !turns.length} onClick={newChat}>
          {t('aiNewChat')}
        </button>
        <button className="ghost accent" disabled={busy} onClick={() => void makeStudyFile()}>
          {t('aiMakeStudyFile')}
        </button>
      </div>

      {showPick && (
        <section className="block settings">
          <div className="block-head">
            <h2>{t('aiContextButton')}</h2>
          </div>
          <p className="hint-line lead">{t('aiContextLead')}</p>
          <label className="check">
            <input type="checkbox" checked={pick.script} onChange={(e) => changePick({ script: e.target.checked })} />
            <span>
              {t('aiPickScript')} <em>{script?.lines.length ?? 0}</em>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={pick.transcript} onChange={(e) => changePick({ transcript: e.target.checked })} />
            <span>
              {t('aiPickTranscript')} <em>{transcripts.length}</em>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={pick.memo} onChange={(e) => changePick({ memo: e.target.checked })} />
            <span>{t('aiPickMemo')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={pick.captures} onChange={(e) => changePick({ captures: e.target.checked })} />
            <span>
              {t('aiPickCaptureMemos')} <em>{captures.length}</em>
            </span>
          </label>
          <p className="hint-line">{t('aiContextSize', chars)}</p>
        </section>
      )}

      {availability === 'downloadable' && progress < 0 && <p className="hint-line">{t('aiNeedsDownload')}</p>}
      {progress >= 0 && <p className="hint-line">{t('aiDownloading', progress)}</p>}

      <div className="chat" ref={logRef}>
        {!turns.length && (
          <div className="empty">
            <p>{t('aiEmpty', picked || t('aiPickNothing'))}</p>
          </div>
        )}
        {turns.map((turn) => (
          <div key={turn.id} className={`bubble ${turn.role}`}>
            <p>{turn.text || '…'}</p>
          </div>
        ))}
      </div>

      <div className="quick">
        <button className="ghost" disabled={busy} onClick={() => void run(t('aiQuickSummary'))}>
          {t('aiQuickSummaryLabel')}
        </button>
        <button className="ghost" disabled={busy} onClick={() => void run(t('aiQuickTerms'))}>
          {t('aiQuickTermsLabel')}
        </button>
        <button className="ghost" disabled={busy} onClick={() => void askAboutCapture()}>
          {t('aiQuickCaptureLabel')}
        </button>
      </div>

      <div className="composer">
        <textarea
          value={input}
          disabled={busy}
          placeholder={t('aiInputPlaceholder')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 줄바꿈은 Shift+Enter. 그냥 Enter 는 바로 보낸다.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button className="danger" onClick={stop}>
            {t('aiStop')}
          </button>
        ) : (
          <button className="primary" disabled={!input.trim()} onClick={send}>
            {t('aiSend')}
          </button>
        )}
      </div>
      <p className="hint-line">{t('aiLocalHint')}</p>
    </>
  );
}
