import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { createGateway } from '../src/gateway.js';
import { SttProviderError, type SpeechToTextProvider, type TranscribeRequest } from '../src/provider.js';
import { serverConfig } from '../src/config.js';

const SR = 16000;
const tone = (ms: number, amplitude = 9000) => {
  const samples = Math.floor((ms * SR) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(Math.round(amplitude * Math.sin(i / 10)), i * 2);
  return buffer;
};

/** 실제 whisper 없이 게이트웨이 흐름만 검증하기 위한 스텁 제공자. */
class StubProvider implements SpeechToTextProvider {
  readonly name = 'stub';
  calls: TranscribeRequest[] = [];
  script: (Array<string | Error>) = [];
  ready = true;
  async start() {}
  async stop() {}
  isReady() {
    return this.ready;
  }
  describe() {
    return { provider: this.name };
  }
  async transcribe(request: TranscribeRequest) {
    this.calls.push(request);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return { text: next ?? '' };
  }
}

const config = { ...serverConfig, port: 0, windowMs: 3000, overlapMs: 600, minRms: 180, maxBacklogSec: 20 };

let app: FastifyInstance;
let provider: StubProvider;
let url = '';

beforeAll(async () => {
  provider = new StubProvider();
  app = await createGateway(provider, config);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  url = `ws://127.0.0.1:${port}/v1/transcription`;
});

afterAll(async () => {
  await app.close();
});

function connect() {
  const ws = new WebSocket(url);
  const messages: any[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const waitFor = async (predicate: (msg: any) => boolean, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`메시지를 기다리다 시간 초과. 받은 것: ${JSON.stringify(messages)}`);
  };
  return { ws, messages, opened, waitFor };
}

describe('STT 게이트웨이 WebSocket', () => {
  it('session.init 에 session.ready 로 응답한다', async () => {
    const c = connect();
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'session.init', sessionId: 'sess-a', language: 'ko', prompt: '운영체제 강의' }));
    const ready = await c.waitFor((m) => m.type === 'session.ready');
    expect(ready.sessionId).toBe('sess-a');
    c.ws.close();
  });

  it('오디오를 보내면 window 단위로 인식해 transcript 를 돌려준다', async () => {
    provider.script = ['첫 번째 문장입니다'];
    provider.calls = [];
    const c = connect();
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'session.init', sessionId: 'sess-b', language: 'ko', prompt: '운영체제 강의' }));
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.send(tone(3200));
    // 문장이 안 끝난 채로 오디오가 끊기면 session.end 가 마지막 줄을 확정한다.
    c.ws.send(JSON.stringify({ type: 'session.end', sessionId: 'sess-b' }));

    const transcript = await c.waitFor((m) => m.type === 'transcript');
    expect(transcript.payload).toMatchObject({ sessionId: 'sess-b', sequence: 1, text: '첫 번째 문장입니다', isFinal: true });
    expect(transcript.payload.endedAtMs - transcript.payload.startedAtMs).toBe(3000);
    // 강의 제목이 Whisper 프롬프트로 전달돼야 한다
    expect(provider.calls[0]).toMatchObject({ sampleRate: 16000, language: 'ko', prompt: '운영체제 강의' });
    c.ws.close();
  });

  it('overlap 때문에 반복된 자막은 dedup 되어 sequence 를 소비하지 않는다', async () => {
    provider.script = ['오늘은 스케줄링을 다룹니다', '오늘은 스케줄링을 다룹니다 라운드 로빈부터'];
    provider.calls = [];
    const c = connect();
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'session.init', sessionId: 'sess-c' }));
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.send(tone(6000));
    c.ws.send(JSON.stringify({ type: 'session.end', sessionId: 'sess-c' }));

    await c.waitFor((m) => m.type === 'transcript' && m.payload.sequence === 2);
    const texts = c.messages.filter((m) => m.type === 'transcript').map((m) => m.payload.text);
    expect(texts).toEqual(['오늘은 스케줄링을 다룹니다', '라운드 로빈부터']);
    c.ws.close();
  });

  it('빈 인식 결과는 자막으로 내보내지 않는다', async () => {
    provider.script = ['', '   ', '실제 문장'];
    const c = connect();
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'session.init', sessionId: 'sess-d' }));
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.send(tone(9000));
    c.ws.send(JSON.stringify({ type: 'session.end', sessionId: 'sess-d' }));

    const first = await c.waitFor((m) => m.type === 'transcript');
    expect(first.payload.text).toBe('실제 문장');
    expect(first.payload.sequence).toBe(1);
    c.ws.close();
  });

  it('무음 구간은 Whisper 를 호출하지 않는다', async () => {
    provider.script = [];
    provider.calls = [];
    const c = connect();
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'session.init', sessionId: 'sess-e' }));
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.send(Buffer.alloc(3200 * 2 * 2)); // 무음 6.4초 상당

    await new Promise((r) => setTimeout(r, 300));
    expect(provider.calls).toHaveLength(0);
    expect(c.messages.filter((m) => m.type === 'transcript')).toHaveLength(0);
    c.ws.close();
  });

  it('Whisper 오류는 error 메시지로 알리고 연결은 유지된다', async () => {
    provider.script = [new SttProviderError('whisper 실패', 'STT_PROVIDER_FAILED'), '복구 후 문장'];
    const c = connect();
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'session.init', sessionId: 'sess-f' }));
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.send(tone(6000));
    c.ws.send(JSON.stringify({ type: 'session.end', sessionId: 'sess-f' }));

    const error = await c.waitFor((m) => m.type === 'error');
    expect(error).toMatchObject({ code: 'STT_PROVIDER_FAILED', retryable: true });
    const transcript = await c.waitFor((m) => m.type === 'transcript');
    expect(transcript.payload.text).toBe('복구 후 문장');
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it('session.end 는 window 를 못 채운 꼬리 오디오까지 인식하고 session.ended 로 끝낸다', async () => {
    provider.script = ['마지막 정리하겠습니다'];
    provider.calls = [];
    const c = connect();
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'session.init', sessionId: 'sess-g' }));
    await c.waitFor((m) => m.type === 'session.ready');
    // window(3000ms) 에 못 미치는 길이 → 아직 아무것도 인식되지 않아야 한다
    c.ws.send(tone(2000));
    await new Promise((r) => setTimeout(r, 200));
    expect(provider.calls).toHaveLength(0);

    c.ws.send(JSON.stringify({ type: 'session.end', sessionId: 'sess-g' }));
    const transcript = await c.waitFor((m) => m.type === 'transcript');
    expect(transcript.payload).toMatchObject({ sessionId: 'sess-g', sequence: 1, text: '마지막 정리하겠습니다' });
    const ended = await c.waitFor((m) => m.type === 'session.ended');
    expect(ended.sessionId).toBe('sess-g');
    c.ws.close();
  });

  it('꼬리가 너무 짧으면 버리고 session.ended 만 보낸다', async () => {
    provider.script = ['버려져야 하는 문장'];
    provider.calls = [];
    const c = connect();
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'session.init', sessionId: 'sess-h' }));
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.send(tone(300));
    c.ws.send(JSON.stringify({ type: 'session.end', sessionId: 'sess-h' }));

    await c.waitFor((m) => m.type === 'session.ended');
    expect(provider.calls).toHaveLength(0);
    expect(c.messages.filter((m) => m.type === 'transcript')).toHaveLength(0);
    c.ws.close();
  });

  it('문장이 끝나지 않은 window 는 다음 window 와 한 줄로 합쳐 내보낸다', async () => {
    provider.script = ['오늘 다룰 주제는', '프로세스 스케줄링입니다'];
    provider.calls = [];
    const c = connect();
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'session.init', sessionId: 'sess-i' }));
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.send(tone(6000));

    const transcript = await c.waitFor((m) => m.type === 'transcript');
    expect(transcript.payload.text).toBe('오늘 다룰 주제는 프로세스 스케줄링입니다');
    expect(transcript.payload.sequence).toBe(1);
    // 합쳐진 줄의 구간은 첫 window 시작 ~ 마지막 window 끝
    expect(transcript.payload.startedAtMs).toBe(0);
    expect(transcript.payload.endedAtMs).toBe(5400);
    c.ws.close();
  });

  it('진행 중인 줄을 transcript.partial 로 먼저 보낸다(오버레이용, 저장 안 함)', async () => {
    provider.script = ['오늘 다룰 주제는', '프로세스 스케줄링입니다'];
    const c = connect();
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'session.init', sessionId: 'sess-j' }));
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.send(tone(6000));

    await c.waitFor((m) => m.type === 'transcript');
    const partials = c.messages.filter((m) => m.type === 'transcript.partial');
    // 첫 window 는 문장이 안 끝났으므로 partial 로만 나가고, 확정 자막보다 먼저 도착한다
    expect(partials[0].payload).toMatchObject({ sessionId: 'sess-j', text: '오늘 다룰 주제는' });
    expect(c.messages.findIndex((m) => m.type === 'transcript.partial')).toBeLessThan(
      c.messages.findIndex((m) => m.type === 'transcript')
    );
    c.ws.close();
  });

  it('무음 구간을 만나면 진행 중인 줄을 그 자리에서 확정한다', async () => {
    provider.script = ['아직 안 끝난 말인데', ''];
    provider.calls = [];
    const c = connect();
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'session.init', sessionId: 'sess-k' }));
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.send(tone(3200));
    c.ws.send(Buffer.alloc(16000 * 2 * 10)); // 무음 10초

    const transcript = await c.waitFor((m) => m.type === 'transcript');
    // session.end 없이, 무음만으로 진행 중인 줄이 확정돼야 한다
    expect(transcript.payload.text).toBe('아직 안 끝난 말인데');
    expect(c.messages.some((m) => m.type === 'session.ended')).toBe(false);
    c.ws.close();
  });

  it('window 안쪽에서 말이 멈춰도(꼬리 1초만 무음) 줄을 확정한다', async () => {
    // 위 테스트의 10초 무음은 window 전체가 조용해서 rms(pcm) 게이트에 먼저 걸린다.
    // 여기서는 window 대부분이 소리라 Whisper 를 실제로 호출하고,
    // 꼬리 1초만 무음이다. 이 경로가 SILENCE_TAIL_MS(tailIsSilent) 전용 검사다.
    provider.script = ['아직 안 끝난 말인데'];
    provider.calls = [];
    const c = connect();
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'session.init', sessionId: 'sess-tail' }));
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.send(tone(2000));
    c.ws.send(Buffer.alloc(SR * 2 * 1.2)); // 꼬리 1.2초만 무음 → window 0~3000ms

    const transcript = await c.waitFor((m) => m.type === 'transcript');
    // 문장 부호가 없으니 꼬리 무음이 아니면 partial 로만 남고 확정되지 않는다.
    expect(transcript.payload.text).toBe('아직 안 끝난 말인데');
    // window 전체 무음 게이트였다면 Whisper 를 아예 부르지 않았을 것이다.
    expect(provider.calls.length).toBe(1);
    expect(c.messages.some((m) => m.type === 'session.ended')).toBe(false);
    c.ws.close();
  });

  it('직전 자막을 Whisper 프롬프트로 되돌려 문맥을 유지한다', async () => {
    provider.script = ['운영체제는', '프로세스를 관리합니다'];
    provider.calls = [];
    const c = connect();
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'session.init', sessionId: 'sess-l', prompt: '운영체제 강의' }));
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.send(tone(6000));

    await c.waitFor((m) => m.type === 'transcript');
    expect(provider.calls[0].prompt).toBe('운영체제 강의');
    expect(provider.calls[1].prompt).toBe('운영체제 강의 운영체제는');
    c.ws.close();
  });

  it('/health 는 제공자 상태와 window 설정을 보고한다', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.window).toMatchObject({ windowMs: 3000, overlapMs: 600, sampleRate: 16000 });
    expect(body.line).toMatchObject({ maxMs: config.lineMaxMs, maxChars: config.lineMaxChars });
  });
});
