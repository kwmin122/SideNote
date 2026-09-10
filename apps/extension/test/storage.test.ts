import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupOrphanBlobs,
  clearSessionTranscripts,
  createFreshSession,
  db,
  deleteCapture,
  deleteSession,
  getOrCreateSession,
  lastTranscriptSequence,
  listSessions,
  loadSessionBundle,
  putImageBlob
} from '../src/storage/db';
import type { CaptureRecord, TranscriptSegment } from '../src/shared/contracts';

beforeEach(async () => {
  await db.open();
  await Promise.all([db.sessions.clear(), db.transcripts.clear(), db.captures.clear(), db.imageBlobs.clear()]);
});

const tab = { id: 7, url: 'https://lecture.example.com/course/os?week=3', title: '운영체제 3주차' };

describe('세션 저장/복원', () => {
  it('같은 강의 페이지를 다시 열면 기존 세션(메모 포함)을 복원한다', async () => {
    const first = await getOrCreateSession(tab);
    await db.sessions.update(first.id, { generalMemo: '스케줄링 정리' });

    // 새로고침으로 쿼리스트링이 바뀌고 탭 id 도 달라진 상황
    const second = await getOrCreateSession({ id: 99, url: 'https://lecture.example.com/course/os?week=3&t=120', title: '운영체제 3주차' });

    expect(second.id).toBe(first.id);
    expect((await db.sessions.get(first.id))?.generalMemo).toBe('스케줄링 정리');
    expect(await db.sessions.count()).toBe(1);
  });

  it('다른 강의는 새 세션을 만든다', async () => {
    const a = await getOrCreateSession(tab);
    const b = await getOrCreateSession({ id: 7, url: 'https://lecture.example.com/course/network', title: '네트워크' });
    expect(b.id).not.toBe(a.id);
    expect(await db.sessions.count()).toBe(2);
  });

  it('메모를 저장하면 다시 읽었을 때 유지된다 (사이드패널 재오픈)', async () => {
    const session = await getOrCreateSession(tab);
    await db.sessions.update(session.id, { generalMemo: '중간고사 범위' });
    const reopened = await getOrCreateSession(tab);
    expect(reopened.generalMemo ?? (await db.sessions.get(session.id))?.generalMemo).toBeDefined();
    expect((await db.sessions.get(session.id))?.generalMemo).toBe('중간고사 범위');
  });
});

describe('자막 저장', () => {
  const segment = (sequence: number): TranscriptSegment => ({
    id: `t-${sequence}`,
    sessionId: 'sess',
    sequence,
    text: `문장 ${sequence}`,
    startedAtMs: sequence * 2400,
    endedAtMs: sequence * 2400 + 3000,
    createdAt: Date.now(),
    status: 'FINAL'
  });

  it('저장된 자막은 sequence 순으로 복원된다', async () => {
    await db.transcripts.bulkPut([segment(3), segment(1), segment(2)]);
    const bundle = await loadSessionBundle('sess');
    expect(bundle.transcripts.map((t) => t.sequence)).toEqual([1, 2, 3]);
  });

  it('오프스크린 재시작 시 마지막 sequence 를 이어받는다', async () => {
    await db.transcripts.bulkPut([segment(1), segment(2)]);
    expect(await lastTranscriptSequence('sess')).toBe(2);
    expect(await lastTranscriptSequence('없는세션')).toBe(0);
  });

  it('DB 쓰기 실패는 예외로 전달되어 호출측이 처리할 수 있다', async () => {
    const spy = vi.spyOn(db.transcripts, 'put').mockRejectedValueOnce(new Error('QuotaExceededError'));
    await expect(db.transcripts.put(segment(9))).rejects.toThrow('QuotaExceededError');
    spy.mockRestore();
    // 실패 후에도 DB 는 정상 동작해야 한다
    await db.transcripts.put(segment(9));
    expect(await db.transcripts.get('t-9')).toBeTruthy();
  });
});

describe('캡처 이미지 Blob', () => {
  const makeCapture = (imageBlobId: string): CaptureRecord => ({
    id: `c-${imageBlobId}`,
    sessionId: 'sess',
    imageBlobId,
    captureType: 'VIDEO_REGION',
    pageUrl: 'https://lecture.example.com/course/os',
    createdAt: Date.now(),
    memo: ''
  });

  it('캡처를 지우면 이미지 Blob 도 함께 지워진다', async () => {
    const blobId = await putImageBlob(new Blob(['fake-png'], { type: 'image/png' }));
    const capture = makeCapture(blobId);
    await db.captures.add(capture);
    await deleteCapture(capture);
    expect(await db.captures.get(capture.id)).toBeUndefined();
    expect(await db.imageBlobs.get(blobId)).toBeUndefined();
  });

  it('참조되지 않는 고아 Blob 을 정리한다', async () => {
    const used = await putImageBlob(new Blob(['a']));
    const orphan = await putImageBlob(new Blob(['b']));
    await db.captures.add(makeCapture(used));
    const removed = await cleanupOrphanBlobs();
    expect(removed).toBe(1);
    expect(await db.imageBlobs.get(orphan)).toBeUndefined();
    expect(await db.imageBlobs.get(used)).toBeTruthy();
  });
});

describe('노트 초기화 / 이전 노트 불러오기', () => {
  it('새 노트를 시작해도 이전 노트는 남고, 현재 노트만 새 것으로 바뀐다', async () => {
    const first = await getOrCreateSession(tab);
    await db.sessions.update(first.id, { generalMemo: '1회차 메모' });

    const fresh = await createFreshSession(tab);
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.generalMemo).toBe('');
    // 이전 노트는 내용 그대로 살아 있다.
    expect((await db.sessions.get(first.id))?.generalMemo).toBe('1회차 메모');
    // 같은 페이지를 다시 열면 방금 만든 노트가 현재 노트가 된다.
    expect((await getOrCreateSession(tab)).id).toBe(fresh.id);
  });

  it('이전 노트와 같은 시각에 만들어져도 새 노트가 현재 노트가 된다', async () => {
    const FUTURE = 4_102_444_800_000; // 2100-01-01. Date.now() 보다 항상 크다.
    const first = await getOrCreateSession(tab);
    await db.sessions.update(first.id, { updatedAt: FUTURE });

    const fresh = await createFreshSession(tab);
    expect(fresh.updatedAt).toBeGreaterThan(FUTURE);
    expect((await getOrCreateSession(tab)).id).toBe(fresh.id);
  });

  it('목록은 최근에 연 순서로 나오고 자막/캡처 수를 함께 센다', async () => {
    const a = await getOrCreateSession(tab);
    const b = await getOrCreateSession({ id: 8, url: 'https://lecture.example.com/course/network', title: '네트워크' });
    await db.transcripts.bulkPut([
      { id: 'x1', sessionId: a.id, sequence: 1, text: 'ㄱ', startedAtMs: 0, endedAtMs: 1, createdAt: 1, status: 'FINAL' },
      { id: 'x2', sessionId: a.id, sequence: 2, text: 'ㄴ', startedAtMs: 0, endedAtMs: 1, createdAt: 1, status: 'FINAL' }
    ] as TranscriptSegment[]);
    await db.captures.add({
      id: 'cap-1',
      sessionId: a.id,
      captureType: 'MEMO',
      pageUrl: '',
      createdAt: Date.now(),
      memo: '메모만'
    } as CaptureRecord);

    // updatedAt 을 못 박아 둔다(같은 밀리초에 만들어지면 순서가 흔들린다).
    await db.sessions.update(a.id, { updatedAt: 1000 });
    await db.sessions.update(b.id, { updatedAt: 2000 });
    expect((await listSessions()).map((s) => s.session.id)).toEqual([b.id, a.id]);

    // 목록은 "마지막으로 고친 순서"다. a 의 메모를 고치면 a 가 맨 위로 온다.
    // (노트를 열기만 하는 것은 updatedAt 을 건드리지 않는다 - 현재 탭 노트로 돌아갈 수 있어야 하므로)
    await db.sessions.update(a.id, { generalMemo: '고침', updatedAt: 3000 });
    const list = await listSessions();
    expect(list[0].session.id).toBe(a.id);
    expect(list[0].transcriptCount).toBe(2);
    expect(list[0].captureCount).toBe(1);
    expect(list[1].transcriptCount).toBe(0);
  });

  it('노트를 지우면 자막·캡처·이미지까지 함께 지워진다', async () => {
    const session = await getOrCreateSession(tab);
    const blobId = await putImageBlob(new Blob(['png']));
    await db.transcripts.put({
      id: 'y1',
      sessionId: session.id,
      sequence: 1,
      text: 'ㄱ',
      startedAtMs: 0,
      endedAtMs: 1,
      createdAt: 1,
      status: 'FINAL'
    } as TranscriptSegment);
    await db.captures.add({
      id: 'cap-2',
      sessionId: session.id,
      imageBlobId: blobId,
      captureType: 'VIEWPORT',
      pageUrl: '',
      createdAt: Date.now(),
      memo: ''
    } as CaptureRecord);

    await deleteSession(session.id);

    expect(await db.sessions.get(session.id)).toBeUndefined();
    expect((await loadSessionBundle(session.id)).transcripts).toHaveLength(0);
    expect((await loadSessionBundle(session.id)).captures).toHaveLength(0);
    expect(await db.imageBlobs.get(blobId)).toBeUndefined();
  });
});

describe('캡처 없는 메모 항목', () => {
  it('imageBlobId 없이도 저장되고 복원된다', async () => {
    const record: CaptureRecord = {
      id: 'memo-1',
      sessionId: 'sess',
      captureType: 'MEMO',
      videoTimeSec: 125,
      pageUrl: 'https://lecture.example.com/course/os',
      createdAt: Date.now(),
      memo: '여기 시험 범위'
    };
    await db.captures.add(record);
    const bundle = await loadSessionBundle('sess');
    expect(bundle.captures).toHaveLength(1);
    expect(bundle.captures[0].imageBlobId).toBeUndefined();
    expect(bundle.captures[0].memo).toBe('여기 시험 범위');
  });

  it('메모 항목을 지워도 다른 Blob 을 건드리지 않는다', async () => {
    const keep = await putImageBlob(new Blob(['keep']));
    await db.captures.add({
      id: 'cap-keep',
      sessionId: 'sess',
      imageBlobId: keep,
      captureType: 'VIEWPORT',
      pageUrl: '',
      createdAt: Date.now(),
      memo: ''
    } as CaptureRecord);
    const memoOnly: CaptureRecord = {
      id: 'memo-2',
      sessionId: 'sess',
      captureType: 'MEMO',
      pageUrl: '',
      createdAt: Date.now(),
      memo: '메모'
    };
    await db.captures.add(memoOnly);

    await deleteCapture(memoOnly);

    expect(await db.captures.get('memo-2')).toBeUndefined();
    expect(await db.imageBlobs.get(keep)).toBeTruthy();
  });
});

describe('영상마다 다른 노트', () => {
  const yt = (v: string, extra = '') => ({ id: 3, url: `https://www.youtube.com/watch?v=${v}${extra}`, title: `강의 ${v}` });

  it('유튜브에서 다른 영상을 틀면 새 노트가 생겨 앞 영상 자막이 섞이지 않는다', async () => {
    const first = await getOrCreateSession(yt('AAAAAAAAAAA'));
    await db.transcripts.put({
      id: 'v1',
      sessionId: first.id,
      sequence: 1,
      text: '1강 내용',
      startedAtMs: 0,
      endedAtMs: 1,
      createdAt: 1,
      status: 'FINAL'
    } as TranscriptSegment);

    const second = await getOrCreateSession(yt('BBBBBBBBBBB'));
    expect(second.id).not.toBe(first.id);
    expect((await loadSessionBundle(second.id)).transcripts).toHaveLength(0);
    // 앞 영상 자막은 사라지지 않고 그 노트에 남아 있다("기록"에서 다시 볼 수 있어야 한다).
    expect((await loadSessionBundle(first.id)).transcripts).toHaveLength(1);
  });

  it('같은 영상으로 돌아오면(재생 위치가 달라도) 원래 노트를 이어 쓴다', async () => {
    const first = await getOrCreateSession(yt('AAAAAAAAAAA'));
    await getOrCreateSession(yt('BBBBBBBBBBB'));
    const back = await getOrCreateSession(yt('AAAAAAAAAAA', '&t=42s'));
    expect(back.id).toBe(first.id);
    expect(await db.sessions.count()).toBe(2);
  });
});

describe('현재 자막 지우기', () => {
  it('자막만 지우고 메모와 캡처는 남긴다', async () => {
    const session = await getOrCreateSession(tab);
    await db.sessions.update(session.id, { generalMemo: '남아야 하는 메모' });
    await db.transcripts.bulkPut([
      { id: 'z1', sessionId: session.id, sequence: 1, text: 'ㄱ', startedAtMs: 0, endedAtMs: 1, createdAt: 1, status: 'FINAL' },
      { id: 'z2', sessionId: session.id, sequence: 2, text: 'ㄴ', startedAtMs: 0, endedAtMs: 1, createdAt: 1, status: 'FINAL' }
    ] as TranscriptSegment[]);
    await db.captures.add({
      id: 'cap-keep',
      sessionId: session.id,
      captureType: 'MEMO',
      pageUrl: '',
      createdAt: Date.now(),
      memo: '남아야 하는 캡처 메모'
    } as CaptureRecord);

    expect(await clearSessionTranscripts(session.id)).toBe(2);

    const bundle = await loadSessionBundle(session.id);
    expect(bundle.transcripts).toHaveLength(0);
    expect(bundle.captures).toHaveLength(1);
    expect((await db.sessions.get(session.id))?.generalMemo).toBe('남아야 하는 메모');
  });

  it('다른 노트의 자막은 건드리지 않는다', async () => {
    const a = await getOrCreateSession(tab);
    const b = await getOrCreateSession({ id: 4, url: 'https://lecture.example.com/course/db', title: 'DB' });
    await db.transcripts.bulkPut([
      { id: 'a1', sessionId: a.id, sequence: 1, text: 'ㄱ', startedAtMs: 0, endedAtMs: 1, createdAt: 1, status: 'FINAL' },
      { id: 'b1', sessionId: b.id, sequence: 1, text: 'ㄴ', startedAtMs: 0, endedAtMs: 1, createdAt: 1, status: 'FINAL' }
    ] as TranscriptSegment[]);

    await clearSessionTranscripts(a.id);
    expect((await loadSessionBundle(b.id)).transcripts).toHaveLength(1);
  });
});
