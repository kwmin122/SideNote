import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WhisperServerProvider } from '../src/whisper.js';
import { SttProviderError } from '../src/provider.js';

/** whisper-server 를 흉내내는 HTTP 스텁. /inference 계약 처리만 검증한다. */
let server: Server;
let port = 0;
let mode: 'ok' | 'rate' | 'error' | 'body-error' = 'ok';
let lastFields: Record<string, string> = {};
let lastWavSize = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>whisper</html>');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      lastWavSize = raw.length;
      lastFields = {};
      // 폼 필드는 UTF-8 이다. latin1 로 읽으면 한글이 깨진다.
      for (const match of raw.toString('utf8').matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) {
        lastFields[match[1]] = match[2];
      }
      if (mode === 'rate') {
        res.writeHead(429);
        res.end('too many');
        return;
      }
      if (mode === 'error') {
        res.writeHead(500);
        res.end('internal');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mode === 'body-error' ? { error: '모델 없음' } : { text: ' 안녕하세요 여러분 \n' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeProvider() {
  return new WhisperServerProvider({
    binary: '/nonexistent',
    model: '/nonexistent',
    host: '127.0.0.1',
    port,
    language: 'ko',
    threads: 4,
    startupTimeoutMs: 5000,
    externalUrl: `http://127.0.0.1:${port}`
  });
}

const pcm = Buffer.alloc(16000 * 2); // 1초

describe('WhisperServerProvider (상주 서버 HTTP 호출)', () => {
  it('이미 떠 있는 서버에 붙어 /inference 로 인식한다', async () => {
    mode = 'ok';
    const provider = makeProvider();
    await provider.start();
    expect(provider.isReady()).toBe(true);

    const result = await provider.transcribe({ pcm, sampleRate: 16000, language: 'ko', prompt: '운영체제 강의' });
    expect(result.text).toBe('안녕하세요 여러분');
    expect(lastFields.response_format).toBe('json');
    expect(lastFields.language).toBe('ko');
    expect(lastFields.prompt).toBe('운영체제 강의');
    expect(lastFields.no_timestamps).toBe('true');
    // WAV 헤더(44바이트)가 붙은 채로 전송돼야 한다
    expect(lastWavSize).toBeGreaterThan(pcm.length + 44);
  });

  it('여러 번 start() 해도 프로세스를 다시 띄우지 않는다', async () => {
    const provider = makeProvider();
    await Promise.all([provider.start(), provider.start(), provider.start()]);
    expect(provider.isReady()).toBe(true);
  });

  it('429 는 STT_RATE_LIMITED 로 변환한다', async () => {
    mode = 'rate';
    const provider = makeProvider();
    await provider.start();
    await expect(provider.transcribe({ pcm, sampleRate: 16000, language: 'ko' })).rejects.toMatchObject({
      code: 'STT_RATE_LIMITED'
    });
  });

  it('5xx 응답은 STT_PROVIDER_FAILED 로 변환한다', async () => {
    mode = 'error';
    const provider = makeProvider();
    await provider.start();
    await expect(provider.transcribe({ pcm, sampleRate: 16000, language: 'ko' })).rejects.toBeInstanceOf(SttProviderError);
  });

  it('본문에 error 가 담겨 와도 예외로 처리한다', async () => {
    mode = 'body-error';
    const provider = makeProvider();
    await provider.start();
    await expect(provider.transcribe({ pcm, sampleRate: 16000, language: 'ko' })).rejects.toThrow('모델 없음');
  });

  it('실행 파일이 없으면 안내 메시지와 함께 실패한다', async () => {
    const provider = new WhisperServerProvider({
      binary: '/nonexistent/whisper-server',
      model: '/nonexistent/model.bin',
      host: '127.0.0.1',
      port: 1,
      language: 'ko',
      threads: 4,
      startupTimeoutMs: 500
    });
    await expect(provider.start()).rejects.toThrow('npm run setup:whisper');
  });
});
