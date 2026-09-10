/**
 * 실제 whisper-server 를 띄워 STT 게이트웨이를 끝까지 검증하는 E2E.
 *
 *   npm run e2e:stt
 *
 * 절차: 한국어 샘플 WAV 생성 → 게이트웨이 기동(whisper-server spawn) → /health 대기
 *       → WebSocket 세션 → PCM 스트리밍 → transcript.partial / transcript 수신 → session.end.
 *
 * 두 번 돌린다.
 *  1) 짧은 한 문장 샘플: 기본 경로(자막 도착 / 순서 / 한글 / dedup / 오류 없음).
 *  2) 4문장 + 중간 무음 샘플: "자막이 너무 잘게 끊긴다" 를 실제로 측정한다.
 *     window 수보다 자막 줄 수가 적어야 문장 단위 묶기가 동작한 것이고,
 *     무음 구간에서 줄이 끊겼는지도 여기서 본다.
 * 자동 검증이 불가능한 Chrome 쪽을 제외한 오디오 체인 전부를 여기서 검증한다.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '../..');

const GATEWAY_PORT = Number(process.env.E2E_PORT ?? 8799);
const WHISPER_PORT = Number(process.env.E2E_WHISPER_PORT ?? 8798);
const WAV = path.join(repoRoot, '.cache/e2e-ko.wav');
const LONG_WAV = path.join(repoRoot, '.cache/e2e-ko-long.wav');
const SENTENCE = '안녕하세요. 오늘 강의에서는 운영체제의 프로세스 스케줄링에 대해 알아보겠습니다.';
/** 무음(2초)을 사이에 두고 이어 붙일 두 덩어리. 문장이 여러 개라야 줄 묶기를 측정할 수 있다. */
const LONG_PART_A =
  '안녕하세요. 오늘 강의에서는 운영체제의 프로세스 스케줄링을 다룹니다. 먼저 프로세스와 스레드의 차이를 정리하고 문맥 교환 비용을 살펴보겠습니다.';
const LONG_PART_B =
  '다음으로 라운드 로빈 방식과 우선순위 스케줄링을 비교합니다. 마지막으로 실습 과제와 다음 주 시험 범위를 안내하겠습니다.';
const SILENCE_SEC = 2;
/**
 * 긴 샘플에 들어 있는 문장 수(마침표 기준, 현재 5개).
 * 자막 줄 수가 이보다 많아지면 window 단위로 쪼개졌다는 뜻이다(묶기 전에는 9줄이었다).
 * 상수를 박아 두면 샘플 문장을 늘렸을 때 검사가 조용히 헐거워지므로 샘플에서 직접 센다.
 */
const LONG_SENTENCE_COUNT = `${LONG_PART_A} ${LONG_PART_B}`.match(/[.!?]/g).length;
const DEFAULT_MIN_RMS = 180;

const log = (...args) => console.log('[e2e]', ...args);
const fail = (msg) => {
  console.error('[e2e] 실패:', msg);
  process.exitCode = 1;
};

function which(bin) {
  return spawnSync('which', [bin]).status === 0;
}

function requireTools() {
  if (!which('say') || !which('ffmpeg')) {
    throw new Error('샘플 생성에 say(macOS)와 ffmpeg 가 필요합니다. `brew install ffmpeg` 후 다시 실행하세요.');
  }
}

function sayTo(text, aiff) {
  const r = spawnSync('say', ['-v', 'Yuna', '-o', aiff, text], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('say 로 한국어 샘플을 만들지 못했습니다. Yuna 음성이 설치돼 있는지 확인하세요.');
}

/** say + ffmpeg 로 16kHz mono PCM16 WAV 를 만든다. 이미 있으면 재사용한다. */
function ensureWav() {
  if (existsSync(WAV)) {
    log('샘플 재사용:', WAV);
    return;
  }
  requireTools();
  mkdirSync(path.dirname(WAV), { recursive: true });
  const aiff = WAV.replace(/\.wav$/, '.aiff');
  sayTo(SENTENCE, aiff);
  const r = spawnSync('ffmpeg', ['-y', '-i', aiff, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', WAV], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg 변환 실패');
  log('샘플 생성:', WAV);
}

/** 두 덩어리 사이에 무음을 넣은 긴 샘플. 무음 경계에서 자막 줄이 끊기는지 보기 위한 것이다. */
function ensureLongWav() {
  if (existsSync(LONG_WAV)) {
    log('긴 샘플 재사용:', LONG_WAV);
    return;
  }
  requireTools();
  mkdirSync(path.dirname(LONG_WAV), { recursive: true });
  const a = LONG_WAV.replace(/\.wav$/, '-a.aiff');
  const b = LONG_WAV.replace(/\.wav$/, '-b.aiff');
  sayTo(LONG_PART_A, a);
  sayTo(LONG_PART_B, b);
  const r = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-i', a,
      '-i', b,
      '-filter_complex', `[0:a]apad=pad_dur=${SILENCE_SEC}[a0];[a0][1:a]concat=n=2:v=0:a=1[out]`,
      '-map', '[out]',
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      LONG_WAV
    ],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) throw new Error('ffmpeg 로 긴 샘플을 만들지 못했습니다.');
  log('긴 샘플 생성:', LONG_WAV);
}

/** WAV 청크를 실제로 파싱한다. ffmpeg 는 LIST 청크를 넣기도 해서 offset 44 고정은 틀린다. */
function readPcm(file) {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} 은 WAV 가 아닙니다.`);
  }
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('fmt 청크보다 data 청크가 먼저 나왔습니다.');
      return { pcm: buf.subarray(body, body + size), ...fmt };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('data 청크를 찾지 못했습니다.');
}

function rms(pcm) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = pcm.readInt16LE(i);
    sum += v * v;
    n += 1;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** 무음 구간을 빼고 잰 소리 크기. 긴 샘플은 중간 무음 때문에 전체 RMS 가 낮게 나온다. */
function loudestRms(pcm, windowBytes = 16000 * 2) {
  let best = 0;
  for (let i = 0; i < pcm.length; i += windowBytes) {
    best = Math.max(best, rms(pcm.subarray(i, Math.min(i + windowBytes, pcm.length))));
  }
  return best;
}

/** 가장 긴 무음 구간의 시작·끝(ms). 없으면 null. 무음 경계 검사에 쓴다. */
function findSilenceRangeMs(pcm, threshold, minMs = 1000) {
  const stepBytes = Math.floor((16000 * 2 * 100) / 1000); // 100ms
  let runStart = -1;
  let best = { start: -1, len: 0 };
  for (let i = 0; i < pcm.length; i += stepBytes) {
    const quiet = rms(pcm.subarray(i, Math.min(i + stepBytes, pcm.length))) < threshold;
    if (quiet) {
      if (runStart < 0) runStart = i;
      const len = i + stepBytes - runStart;
      if (len > best.len) best = { start: runStart, len };
    } else {
      runStart = -1;
    }
  }
  const lenMs = Math.floor(best.len / 32);
  if (lenMs < minMs) return null;
  return { startMs: Math.floor(best.start / 32), endMs: Math.floor((best.start + best.len) / 32) };
}

function loadSample(file) {
  const { pcm, sampleRate, channels, bits } = readPcm(file);
  if (sampleRate !== 16000 || channels !== 1 || bits !== 16) {
    throw new Error(`${file} 이 16kHz mono PCM16 이 아닙니다. 파일을 지우고 다시 실행하세요.`);
  }
  return { pcm, durationSec: pcm.length / (sampleRate * channels * (bits / 8)) };
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/health`);
      const body = await res.json();
      last = JSON.stringify(body);
      if (!body.binaryExists) throw new Error(`whisper-server 바이너리가 없습니다. npm run setup:whisper 를 먼저 실행하세요. (${last})`);
      if (!body.modelExists) throw new Error(`Whisper 모델이 없습니다. npm run setup:whisper 를 먼저 실행하세요. (${last})`);
      if (body.ok) return body;
    } catch (err) {
      if (String(err.message).includes('setup:whisper')) throw err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`모델 로딩 대기 시간 초과(${timeoutMs}ms). 마지막 /health: ${last}`);
}

/**
 * 세션 하나를 끝까지 돌린다.
 * 확장과 같은 128ms(2048 sample) 프레임으로 쪼개 보내고,
 * 진행 자막이 한 번 오면(=인식이 살아 있으면) session.end 로 마무리한다.
 */
async function runSession({ pcm, sessionId, prompt }) {
  const ws = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}/v1/transcription`);
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const waitFor = async (predicate, timeoutMs, what) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      if (ws.readyState > WebSocket.OPEN) throw new Error(`${what} 대기 중 소켓이 닫혔습니다.`);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${what} 대기 시간 초과. 받은 메시지: ${JSON.stringify(messages)}`);
  };

  // 강의 페이지 제목을 Whisper 프롬프트로 넘기는 경로까지 함께 검증한다.
  ws.send(JSON.stringify({ type: 'session.init', sessionId, language: 'ko', prompt }));
  const ready = await waitFor((m) => m.type === 'session.ready', 10000, 'session.ready');

  const frameBytes = 2048 * 2;
  for (let i = 0; i < pcm.length; i += frameBytes) ws.send(pcm.subarray(i, Math.min(i + frameBytes, pcm.length)));
  const frames = Math.ceil(pcm.length / frameBytes);

  const started = Date.now();
  // 화면에 글자가 얼마나 빨리 뜨는지를 잰다. 진행 중 자막이든 확정 자막이든 먼저 온 쪽이 기준이다.
  // 모델이 정확할수록 첫 window 안에서 문장을 끝내 버려 진행 중 자막이 아예 안 나올 수 있다
  // (large-v3-turbo 가 그렇다). 그때 "진행 중 자막만" 기다리면 영원히 안 온다.
  const first = await waitFor(
    (m) => (m.type === 'transcript.partial' || m.type === 'transcript') && m.payload.text,
    180000,
    '첫 자막(진행 중 또는 확정)'
  );
  const firstTextMs = Date.now() - started;

  // 스트리밍이 끝나기 전에 확정된 자막이 몇 줄인지 = 문장 종료/무음으로 끊긴 줄 수.
  // (session.end 를 보내면 남은 줄이 강제로 확정되므로 그 전에 세어 둔다.)
  const drainDeadline = Date.now() + Number(process.env.E2E_DRAIN_MS ?? 20000);
  let stable = 0;
  let lastCount = -1;
  while (Date.now() < drainDeadline) {
    const count = messages.filter((m) => m.type === 'transcript').length;
    // 자막 수가 3초 동안 그대로면 스트리밍 인식이 다 따라잡은 것으로 본다.
    stable = count === lastCount ? stable + 1 : 0;
    lastCount = count;
    if (stable >= 12 && count > 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const preEndTranscripts = messages.filter((m) => m.type === 'transcript').length;

  ws.send(JSON.stringify({ type: 'session.end', sessionId }));
  await waitFor((m) => m.type === 'session.ended', 180000, 'session.ended');

  const transcripts = messages.filter((m) => m.type === 'transcript').map((m) => m.payload);
  const partials = messages.filter((m) => m.type === 'transcript.partial');
  const errors = messages.filter((m) => m.type === 'error');
  ws.close();
  return {
    ready,
    frames,
    firstTextMs,
    firstText: first.payload.text,
    firstTextKind: first.type === 'transcript' ? '확정' : '진행 중',
    preEndTranscripts,
    transcripts,
    partials,
    errors
  };
}

function report(checks) {
  let allOk = true;
  for (const [name, ok] of checks) {
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) allOk = false;
  }
  return allOk;
}

async function main() {
  ensureWav();
  ensureLongWav();
  const short = loadSample(WAV);
  const long = loadSample(LONG_WAV);
  const level = loudestRms(short.pcm);
  log(`짧은 샘플 ${short.durationSec.toFixed(2)}초 / 긴 샘플 ${long.durationSec.toFixed(2)}초 (16kHz mono PCM16)`);
  log(`샘플 최대 RMS: ${level.toFixed(1)} (게이트웨이 무음 기준 ${DEFAULT_MIN_RMS})`);

  const env = { ...process.env, PORT: String(GATEWAY_PORT), WHISPER_PORT: String(WHISPER_PORT), LOG_LEVEL: 'warn' };
  let silenceDetectable = true;
  if (level < DEFAULT_MIN_RMS) {
    log(`경고: 샘플이 무음 기준보다 조용해 이번 실행에만 STT_MIN_RMS=0 을 적용합니다(기본값은 그대로 ${DEFAULT_MIN_RMS}).`);
    env.STT_MIN_RMS = '0';
    // 무음 판정을 꺼버렸으므로 무음 경계 검사는 의미가 없다.
    silenceDetectable = false;
  }

  log(`게이트웨이 기동: PORT=${GATEWAY_PORT}, whisper-server spawn 포트=${WHISPER_PORT}`);
  const server = spawn('npx', ['tsx', 'src/index.ts'], { cwd: serverRoot, env, stdio: ['ignore', 'inherit', 'inherit'] });
  let serverExited = false;
  server.on('exit', (code) => {
    serverExited = true;
    if (code !== 0 && code !== null) fail(`게이트웨이가 코드 ${code} 로 종료됐습니다.`);
  });

  const shutdown = () => {
    if (!serverExited) server.kill('SIGTERM');
  };
  process.on('exit', shutdown);

  try {
    const health = await waitForHealth(Number(process.env.E2E_HEALTH_TIMEOUT_MS ?? 240000));
    log('모델 로딩 완료. /health =', JSON.stringify(health.provider));
    const windowMs = health.window?.windowMs ?? 5000;
    const overlapMs = health.window?.overlapMs ?? 1200;
    const advanceMs = windowMs - overlapMs;
    log(`window 설정: ${windowMs}ms, overlap ${overlapMs}ms → ${advanceMs}ms 마다 인식`);

    let allOk = true;

    // ---------- 1) 짧은 한 문장 ----------
    log('--- 1단계: 한 문장 샘플 ---');
    const one = await runSession({ pcm: short.pcm, sessionId: 'e2e-session', prompt: '운영체제 강의: 프로세스 스케줄링' });
    log(`session.ready: ${one.ready.sessionId}, ${one.frames} 프레임 전송`);
    log(`첫 자막 ${one.firstTextKind} (${one.firstTextMs}ms): ${JSON.stringify(one.firstText)}`);
    for (const t of one.transcripts) log(`  #${t.sequence} [${t.startedAtMs}~${t.endedAtMs}ms] ${t.text}`);
    const oneText = one.transcripts.map((t) => t.text).join(' ');
    allOk =
      report([
        ['자막이 1건 이상 도착', one.transcripts.length >= 1],
        // 진행 중 자막 경로 자체는 gateway.test.ts 에서 스텁으로 확실히 검사한다.
        // 여기서는 "화면에 글자가 뜨는가"만 본다.
        ['오버레이에 띄울 글자가 도착', Boolean(one.firstText)],
        ['sequence 가 1부터 순서대로', one.transcripts.every((t, i) => t.sequence === i + 1)],
        ['sessionId 가 유지됨', one.transcripts.every((t) => t.sessionId === 'e2e-session')],
        ['한글이 인식됨', /[가-힣]/.test(oneText)],
        ['핵심 단어(강의) 인식', /강의/.test(oneText)],
        ['중복 자막 없음(dedup 동작)', new Set(one.transcripts.map((t) => t.text)).size === one.transcripts.length],
        ['오류 메시지 없음', one.errors.length === 0]
      ]) && allOk;

    // ---------- 2) 4문장 + 중간 무음 ----------
    log('--- 2단계: 4문장 + 중간 무음 샘플 (자막 끊김 측정) ---');
    const many = await runSession({ pcm: long.pcm, sessionId: 'e2e-long', prompt: '운영체제 강의: 프로세스 스케줄링' });
    const windows = Math.max(1, Math.ceil((long.durationSec * 1000 - overlapMs) / advanceMs));
    const manyText = many.transcripts.map((t) => t.text).join(' ');
    for (const t of many.transcripts) log(`  #${t.sequence} [${t.startedAtMs}~${t.endedAtMs}ms] ${t.text}`);
    log(`측정: window ${windows}개 → 자막 ${many.transcripts.length}줄 (session.end 이전 확정 ${many.preEndTranscripts}줄)`);
    log(`      묶기 전이었다면 ${windows}줄로 쪼개져 나왔을 구간이다.`);

    // 이어지는 window 는 overlap 만큼 겹치므로 간격이 항상 음수다. 참고용 로그.
    const gaps = many.transcripts.slice(1).map((t, i) => t.startedAtMs - many.transcripts[i].endedAtMs);
    log(`      줄 사이 간격(ms): ${JSON.stringify(gaps)} (음수 = overlap 만큼 겹친 연속 window)`);
    // 말이 멈춘 자리에서 줄이 갈렸는지 본다. 무음 구간을 가로지르는 줄이 있으면 안 된다.
    // (±window 처럼 넉넉히 보면 어떤 값이든 통과해 검사가 무의미해지므로 구간 안으로 한정한다.
    //  꼬리 무음 판정 자체(tailIsSilent)는 gateway.test.ts 에서 따로 검사한다.)
    const silence = findSilenceRangeMs(long.pcm, DEFAULT_MIN_RMS);
    const endings = many.transcripts.map((t) => t.endedAtMs);
    const cutInSilence =
      !!silence && endings.some((end) => end >= silence.startMs && end <= silence.endMs + overlapMs);
    log(
      `      무음 구간 ${silence ? `${silence.startMs}~${silence.endMs}ms` : '없음'}, ` +
        `줄 끝 위치: ${JSON.stringify(endings)}`
    );

    // window 경계에서 단어가 잘리면 '습니다' 같은 어미만 남는 줄이 생긴다. 실패로 처리하진 않고 보고만 한다.
    const dangling = many.transcripts.filter((t) => /^(습니다|니다|았습니다|었습니다|다\.)/.test(t.text.trim()));
    if (dangling.length) log(`      참고: window 경계에서 잘린 것으로 보이는 줄 ${dangling.length}건 - ${JSON.stringify(dangling.map((t) => t.text))}`);

    allOk =
      report([
        ['여러 문장이 자막으로 도착', many.transcripts.length >= 2],
        ['스트리밍 도중 확정된 줄이 2줄 이상(문장/무음으로 끊김)', many.preEndTranscripts >= 2],
        ['window 수보다 자막 줄 수가 적다(문장 단위로 묶임)', many.transcripts.length < windows],
        [`자막 줄 수가 문장 수(${LONG_SENTENCE_COUNT}) 이하`, many.transcripts.length <= LONG_SENTENCE_COUNT],
        [
          silenceDetectable ? '말이 멈춘 자리에서 줄이 갈림' : '무음 구간 검사(STT_MIN_RMS=0 이라 건너뜀)',
          silenceDetectable ? cutInSilence : true
        ],
        ['중복 자막 없음(dedup 동작)', new Set(many.transcripts.map((t) => t.text)).size === many.transcripts.length],
        ['오류 메시지 없음', many.errors.length === 0],
        ['핵심 단어(스케줄링) 인식', /스케줄|스케쥴/.test(manyText)]
      ]) && allOk;

    if (!allOk) {
      fail(`검증 실패. 1단계 자막: ${JSON.stringify(oneText)} / 2단계 자막: ${JSON.stringify(manyText)}`);
      for (const e of [...one.errors, ...many.errors]) console.error('[e2e] 오류 메시지:', JSON.stringify(e));
    } else {
      log('E2E 통과: whisper-server 기동 → 16kHz PCM 스트리밍 → 문장 단위 한국어 자막 수신까지 정상.');
    }
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  fail(err?.message ?? err);
});
