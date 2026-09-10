import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamingSTTClient } from '../src/transcription/client';
import type { STTConnectionStatus } from '../src/shared/contracts';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  get jsonSent() {
    return this.sent.filter((x): x is string => typeof x === 'string').map((x) => JSON.parse(x));
  }
  get binarySent() {
    return this.sent.filter((x) => typeof x !== 'string');
  }
}

/**
 * 테스트가 끝나면 반드시 닫는다.
 * 닫지 않은 클라이언트는 재연결 타이머를 계속 돌리고, 그때 만들어진 FakeSocket 이
 * 다음 테스트의 FakeSocket.instances 에 섞여 들어와 검사를 흔든다(실제로 3/5 확률로 깨졌다).
 */
const openedClients: StreamingSTTClient[] = [];

afterEach(() => {
  for (const client of openedClients) client.close();
  openedClients.length = 0;
  FakeSocket.instances = [];
});

function makeClient(overrides: Partial<ConstructorParameters<typeof StreamingSTTClient>[0]> = {}) {
  FakeSocket.instances = [];
  const statuses: STTConnectionStatus[] = [];
  const transcripts: string[] = [];
  const errors: string[] = [];
  const client = new StreamingSTTClient({
    url: 'ws://test/stt',
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    backoffMs: [1, 2, 3],
    maxBufferedFrames: 3,
    connectTimeoutMs: 50,
    ...overrides
  });
  openedClients.push(client);
  return { client, statuses, transcripts, errors };
}

const frame = (n: number) => new Int16Array([n, n, n]).buffer;

describe('STT WebSocket 클라이언트', () => {
  it('연결되면 session.init 을 보내고 session.ready 후 CONNECTED 가 된다', async () => {
    const { client, statuses, transcripts } = makeClient();
    const connecting = client.connect(
      { sessionId: 'sess-1', language: 'ko', contextPrompt: '운영체제 강의' },
      { onTranscript: (r) => transcripts.push(r.text), onStatus: (s) => statuses.push(s) }
    );
    const socket = FakeSocket.instances[0];
    socket.open();
    await connecting;

    expect(socket.jsonSent[0]).toMatchObject({ type: 'session.init', sessionId: 'sess-1', language: 'ko', prompt: '운영체제 강의' });
    socket.emit({ type: 'session.ready', sessionId: 'sess-1' });
    expect(client.getStatus()).toBe('CONNECTED');
    expect(statuses).toContain('CONNECTING');
    expect(statuses).toContain('CONNECTED');

    socket.emit({ type: 'transcript', payload: { text: '안녕하세요', sequence: 1, isFinal: true, startedAtMs: 0, endedAtMs: 3000 } });
    expect(transcripts).toEqual(['안녕하세요']);
  });

  it('transcript.partial 은 onPartial 로만 가고 확정 자막으로 새지 않는다', async () => {
    // 영상 위 오버레이는 이 경로 하나로만 글자를 받는다.
    // partial 이 onTranscript 로 새면 사이드패널에 미확정 문장이 줄줄이 쌓이고 DB 에도 저장된다.
    const { client, transcripts } = makeClient();
    const partials: string[] = [];
    const connecting = client.connect(
      { sessionId: 'sess-partial' },
      { onTranscript: (r) => transcripts.push(r.text), onStatus: () => {}, onPartial: (t) => partials.push(t) }
    );
    const socket = FakeSocket.instances[0];
    socket.open();
    await connecting;
    socket.emit({ type: 'session.ready', sessionId: 'sess-partial' });

    socket.emit({ type: 'transcript.partial', payload: { text: '진행 중인 말' } });
    socket.emit({ type: 'transcript.partial', text: '봉투 없이 온 경우' });
    socket.emit({ type: 'transcript', payload: { text: '확정된 문장', sequence: 1, isFinal: true, startedAtMs: 0, endedAtMs: 5000 } });

    expect(partials).toEqual(['진행 중인 말', '봉투 없이 온 경우']);
    expect(transcripts).toEqual(['확정된 문장']);
  });

  it('onPartial 을 넘기지 않아도 transcript.partial 때문에 죽지 않는다', async () => {
    const { client, transcripts } = makeClient();
    const connecting = client.connect({ sessionId: 'sess-nopartial' }, { onTranscript: (r) => transcripts.push(r.text), onStatus: () => {} });
    const socket = FakeSocket.instances[0];
    socket.open();
    await connecting;
    socket.emit({ type: 'session.ready' });

    expect(() => socket.emit({ type: 'transcript.partial', payload: { text: '진행 중' } })).not.toThrow();
    expect(transcripts).toEqual([]);
  });

  it('끊긴 동안 오디오를 버퍼링하고, 재연결 후 session.init 재전송 뒤 flush 한다', async () => {
    vi.useFakeTimers();
    try {
      const { client, statuses } = makeClient();
      const connecting = client.connect({ sessionId: 'sess-2' }, { onTranscript: () => {}, onStatus: (s) => statuses.push(s) });
      const first = FakeSocket.instances[0];
      first.open();
      await connecting;
      first.emit({ type: 'session.ready' });

      first.drop();
      expect(statuses).toContain('RECONNECTING');

      client.send(frame(1));
      client.send(frame(2));
      expect(client.bufferedFrames()).toBe(2);

      await vi.advanceTimersByTimeAsync(5);
      const second = FakeSocket.instances[1];
      expect(second).toBeDefined();
      second.open();
      expect(second.jsonSent[0]).toMatchObject({ type: 'session.init', sessionId: 'sess-2' });

      second.emit({ type: 'session.ready' });
      expect(second.binarySent).toHaveLength(2);
      expect(client.bufferedFrames()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('버퍼 상한을 넘으면 오래된 프레임부터 버린다', async () => {
    const { client } = makeClient();
    const connecting = client.connect({ sessionId: 'sess-3' }, { onTranscript: () => {}, onStatus: () => {} });
    const socket = FakeSocket.instances[0];
    socket.open();
    await connecting;
    socket.drop();

    for (let i = 0; i < 10; i += 1) client.send(frame(i));
    expect(client.bufferedFrames()).toBe(3);
    expect(client.droppedFrames).toBe(7);
  });

  it('재연결 시도를 모두 소진하면 FAILED 로 끝난다 (메모/캡처는 계속 동작)', async () => {
    vi.useFakeTimers();
    try {
      const { client, statuses } = makeClient();
      const connecting = client.connect({ sessionId: 'sess-4' }, { onTranscript: () => {}, onStatus: (s) => statuses.push(s) });
      FakeSocket.instances[0].open();
      await connecting;

      for (let i = 0; i < 5; i += 1) {
        const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
        socket.drop();
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(client.getStatus()).toBe('FAILED');
      expect(statuses).toContain('FAILED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('서버 error 메시지는 에러 코드로 전달된다', async () => {
    const errors: string[] = [];
    const { client } = makeClient();
    const connecting = client.connect(
      { sessionId: 'sess-5' },
      { onTranscript: () => {}, onStatus: () => {}, onError: (code) => errors.push(code) }
    );
    const socket = FakeSocket.instances[0];
    socket.open();
    await connecting;
    socket.emit({ type: 'error', code: 'STT_PROVIDER_FAILED', message: 'whisper 실패' });
    expect(errors).toEqual(['STT_PROVIDER_FAILED']);
  });

  it('close() 이후에는 재연결하지 않는다', async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeClient();
      const connecting = client.connect({ sessionId: 'sess-6' }, { onTranscript: () => {}, onStatus: () => {} });
      FakeSocket.instances[0].open();
      await connecting;
      client.close();
      FakeSocket.instances[0].drop();
      await vi.advanceTimersByTimeAsync(50);
      expect(FakeSocket.instances).toHaveLength(1);
      expect(client.getStatus()).toBe('DISCONNECTED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('endSession 은 session.end 를 보내고 session.ended 를 받으면 반환한다', async () => {
    const { client, transcripts } = makeClient();
    const connecting = client.connect(
      { sessionId: 'sess-end', language: 'ko', contextPrompt: '' },
      { onTranscript: (r) => transcripts.push(r.text), onStatus: () => {} }
    );
    const socket = FakeSocket.instances[0];
    socket.open();
    await connecting;
    socket.emit({ type: 'session.ready', sessionId: 'sess-end' });

    const ending = client.endSession(1000);
    expect(socket.jsonSent.at(-1)).toMatchObject({ type: 'session.end', sessionId: 'sess-end' });
    // 서버가 꼬리 자막을 먼저 보내고 종료를 알린다
    socket.emit({ type: 'transcript', payload: { text: '마지막 문장', sequence: 3, isFinal: true, startedAtMs: 0, endedAtMs: 1200 } });
    socket.emit({ type: 'session.ended', sessionId: 'sess-end' });
    await ending;
    expect(transcripts).toContain('마지막 문장');
  });

  it('endSession 은 서버가 응답하지 않아도 grace 시간 후 반환한다', async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeClient();
      const connecting = client.connect(
        { sessionId: 'sess-timeout', language: 'ko', contextPrompt: '' },
        { onTranscript: () => {}, onStatus: () => {} }
      );
      FakeSocket.instances[0].open();
      await connecting;
      let done = false;
      void client.endSession(500).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
