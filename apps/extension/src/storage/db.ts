import Dexie, { type Table } from 'dexie';
import type { CaptureRecord, StoredImageBlob, StudySession, TranscriptSegment } from '../shared/contracts';
import { originOf, pageKeyOf } from '../shared/url';

export type StoredTranscript = TranscriptSegment;

export class StudyDb extends Dexie {
  sessions!: Table<StudySession, string>;
  transcripts!: Table<StoredTranscript, string>;
  captures!: Table<CaptureRecord, string>;
  imageBlobs!: Table<StoredImageBlob, string>;

  constructor(name = 'study-sidepanel') {
    super(name);
    this.version(1).stores({
      sessions: 'id, tabId, pageUrl, updatedAt',
      transcripts: 'id, sessionId, sequence, [sessionId+sequence]',
      captures: 'id, sessionId, createdAt'
    });
    // v2: 탭 id 대신 pageKey 로 세션을 복원하고, 이미지 Blob 을 별도 스토어로 분리한다.
    this.version(2)
      .stores({
        sessions: 'id, pageKey, tabOrigin, updatedAt',
        transcripts: 'id, sessionId, sequence, [sessionId+sequence]',
        captures: 'id, sessionId, createdAt, imageBlobId',
        imageBlobs: 'id, createdAt'
      })
      .upgrade(async (tx) => {
        await tx
          .table('sessions')
          .toCollection()
          .modify((session: any) => {
            session.pageKey = pageKeyOf(session.pageUrl);
            session.tabOrigin = originOf(session.pageUrl);
          });
        // 기존 캡처는 dataUrl 그대로 둔다(§11 기존 데이터 호환). UI 가 imageBlobId → dataUrl 순으로 읽는다.
        await tx
          .table('captures')
          .toCollection()
          .modify((capture: any) => {
            capture.captureType ??= 'VIEWPORT';
            capture.pageUrl ??= '';
            capture.memo ??= '';
          });
      });
    // v3: 유튜브처럼 경로가 같고 쿼리로만 영상이 갈리는 사이트를 구분하려고 pageKey 규칙이 바뀌었다.
    // 이미 저장된 세션의 pageKey 를 새 규칙으로 다시 계산해 두지 않으면, 기존 노트를 영영 못 찾는다.
    this.version(3)
      .stores({
        sessions: 'id, pageKey, tabOrigin, updatedAt',
        transcripts: 'id, sessionId, sequence, [sessionId+sequence]',
        captures: 'id, sessionId, createdAt, imageBlobId',
        imageBlobs: 'id, createdAt'
      })
      .upgrade(async (tx) => {
        await tx
          .table('sessions')
          .toCollection()
          .modify((session: any) => {
            session.pageKey = pageKeyOf(session.pageUrl);
          });
      });
  }
}

export const db = new StudyDb();

export interface TabLike {
  id?: number;
  url?: string;
  title?: string;
}

/**
 * 같은 강의 페이지면 기존 세션을 재사용한다(새로고침·사이드패널 재오픈 후 복원).
 * 종료된 세션도 그대로 되살려 메모/캡처/자막을 잃지 않는다.
 */
export async function getOrCreateSession(tab: TabLike): Promise<StudySession> {
  const url = tab.url ?? '';
  const pageKey = pageKeyOf(url);
  const now = Date.now();
  const existing = (await db.sessions.where('pageKey').equals(pageKey).sortBy('updatedAt')).pop();
  if (existing) {
    const patch: Partial<StudySession> = {
      updatedAt: now,
      tabId: tab.id,
      pageUrl: url || existing.pageUrl,
      pageTitle: tab.title || existing.pageTitle
    };
    await db.sessions.update(existing.id, patch);
    return { ...existing, ...patch };
  }
  const session: StudySession = {
    id: crypto.randomUUID(),
    pageKey,
    tabOrigin: originOf(url),
    pageUrl: url,
    pageTitle: tab.title ?? '제목 없음',
    createdAt: now,
    updatedAt: now,
    status: 'READY',
    generalMemo: '',
    tabId: tab.id
  };
  await db.sessions.add(session);
  return session;
}

/** 노트 목록에 보여줄 한 줄. 세션 자체와 안에 든 자막/캡처 수를 함께 담는다. */
export interface SessionSummary {
  session: StudySession;
  transcriptCount: number;
  captureCount: number;
}

/** 저장된 노트를 최근에 연 순서로 나열한다. 목록에 쓸 개수만 세므로 본문은 읽지 않는다. */
export async function listSessions(limit = 50): Promise<SessionSummary[]> {
  const sessions = (await db.sessions.orderBy('updatedAt').reverse().limit(limit).toArray()) as StudySession[];
  return Promise.all(
    sessions.map(async (session) => ({
      session,
      transcriptCount: await db.transcripts.where('sessionId').equals(session.id).count(),
      captureCount: await db.captures.where('sessionId').equals(session.id).count()
    }))
  );
}

/**
 * 같은 페이지라도 새 노트를 하나 더 만든다("노트 초기화").
 * 예전 노트를 지우지 않으므로 목록에서 언제든 다시 열 수 있다.
 * getOrCreateSession 은 pageKey 안에서 updatedAt 이 가장 큰 세션을 고르므로
 * 방금 만든 이 세션이 곧바로 현재 노트가 된다.
 */
export async function createFreshSession(tab: TabLike): Promise<StudySession> {
  const url = tab.url ?? '';
  const pageKey = pageKeyOf(url);
  // 같은 밀리초에 만들어지면 updatedAt 이 같아져 옛 노트가 다시 선택될 수 있다.
  // 항상 기존 노트보다 크게 잡아 방금 만든 노트가 현재 노트가 되도록 보장한다.
  const latest = (await db.sessions.where('pageKey').equals(pageKey).sortBy('updatedAt')).pop();
  const now = Math.max(Date.now(), (latest?.updatedAt ?? 0) + 1);
  const session: StudySession = {
    id: crypto.randomUUID(),
    pageKey,
    tabOrigin: originOf(url),
    pageUrl: url,
    pageTitle: tab.title ?? '제목 없음',
    createdAt: now,
    updatedAt: now,
    status: 'READY',
    generalMemo: '',
    tabId: tab.id
  };
  await db.sessions.add(session);
  return session;
}

export async function loadSessionBundle(sessionId: string) {
  const [transcripts, captures] = await Promise.all([
    db.transcripts.where('sessionId').equals(sessionId).sortBy('sequence'),
    db.captures.where('sessionId').equals(sessionId).sortBy('createdAt')
  ]);
  return { transcripts, captures };
}

/** 오프스크린 재시작 후에도 sequence 가 이어지도록 마지막 번호를 읽는다. */
export async function lastTranscriptSequence(sessionId: string): Promise<number> {
  const rows = await db.transcripts.where('sessionId').equals(sessionId).sortBy('sequence');
  return rows.length ? rows[rows.length - 1].sequence : 0;
}

export async function putImageBlob(blob: Blob): Promise<string> {
  const id = crypto.randomUUID();
  await db.imageBlobs.add({ id, blob, createdAt: Date.now() });
  return id;
}

export async function getImageBlob(id: string): Promise<Blob | undefined> {
  return (await db.imageBlobs.get(id))?.blob;
}

export async function deleteCapture(capture: CaptureRecord): Promise<void> {
  await db.transaction('rw', db.captures, db.imageBlobs, async () => {
    await db.captures.delete(capture.id);
    if (capture.imageBlobId) await db.imageBlobs.delete(capture.imageBlobId);
  });
}

/**
 * "현재 자막 지우기". 이 노트의 자막만 지운다.
 * 메모와 캡처는 그대로 둔다(잘못 눌러도 캡처를 잃지 않게 하기 위함). 노트를 통째로 지우는 것은 deleteSession 이다.
 */
export async function clearSessionTranscripts(sessionId: string): Promise<number> {
  return db.transcripts.where('sessionId').equals(sessionId).delete();
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.transaction('rw', db.sessions, db.transcripts, db.captures, db.imageBlobs, async () => {
    const captures = await db.captures.where('sessionId').equals(sessionId).toArray();
    const blobIds = captures.map((c) => c.imageBlobId).filter((id): id is string => Boolean(id));
    await db.imageBlobs.bulkDelete(blobIds);
    await db.captures.bulkDelete(captures.map((c) => c.id));
    await db.transcripts.where('sessionId').equals(sessionId).delete();
    await db.sessions.delete(sessionId);
  });
}

/**
 * §21: 어떤 캡처도 참조하지 않는 imageBlob 을 정리한다.
 * MV3 에서 주기 타이머를 쓰지 않고 사이드패널이 열릴 때 한 번만 수행한다.
 */
export async function cleanupOrphanBlobs(): Promise<number> {
  const [blobIds, captures] = await Promise.all([db.imageBlobs.toCollection().primaryKeys(), db.captures.toArray()]);
  const referenced = new Set(captures.map((c) => c.imageBlobId).filter(Boolean) as string[]);
  const orphans = (blobIds as string[]).filter((id) => !referenced.has(id));
  if (orphans.length) await db.imageBlobs.bulkDelete(orphans);
  return orphans.length;
}
