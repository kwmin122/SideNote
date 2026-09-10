/**
 * 실제 whisper-server(모델 로드 포함)까지 함께 죽는지 확인한다.
 * e2e.mjs 는 모델 로딩을 건너뛰므로 whisper.stop() 경로를 타지 않는다. 여기서만 검증된다.
 */
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecoder } from '../src/framing.mjs';

const HOST_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/host.mjs');
const GATEWAY_PORT = '8790';
const WHISPER_PORT = '8791';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function pgrepWhisper() {
  try {
    return execFileSync('pgrep', ['-f', `whisper-server.*--port ${WHISPER_PORT}`], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: Number(port) });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    setTimeout(() => done(false), 700);
  });
}

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  pass ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`); }
}

const proc = spawn(process.execPath, [HOST_ENTRY], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, PORT: GATEWAY_PORT, WHISPER_PORT, HOST_HEARTBEAT_MS: '2000' }
});
const messages = [];
proc.stdout.on('data', createDecoder((m) => messages.push(m)));
let exitCode;
proc.on('exit', (code) => { exitCode = code; });

async function waitFor(match, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = messages.find(match);
    if (hit) return hit;
    if (Date.now() >= deadline) throw new Error(`timeout: ${label} (받은 것: ${JSON.stringify(messages)})`);
    await delay(200);
  }
}

try {
  const ready = await waitFor((m) => m.type === 'ready' || m.type === 'error', 30000, 'ready');
  check('네이티브 호스트가 ready 를 보냈다', ready.type === 'ready', JSON.stringify(ready));
  check('게이트웨이를 직접 띄웠다', ready.spawned === true);

  // 모델이 실제로 메모리에 올라갈 때까지 기다린다(whisper-server 가 포트를 열면 준비된 것).
  const deadline = Date.now() + 180000;
  let whisperUp = false;
  while (Date.now() < deadline) {
    if (await portOpen(WHISPER_PORT)) { whisperUp = true; break; }
    await delay(1000);
  }
  check('whisper-server 가 모델을 올리고 포트를 열었다', whisperUp);
  const pids = pgrepWhisper();
  check('whisper-server 프로세스가 살아 있다', pids.length > 0, pids.join(','));

  // Chrome 이 포트를 끊는 것과 같은 신호.
  proc.stdin.end();

  const exitDeadline = Date.now() + 15000;
  while (exitCode === undefined && Date.now() < exitDeadline) await delay(200);
  check('stdin 이 닫히면 호스트가 종료된다', exitCode === 0, `code=${exitCode}`);

  let gone = false;
  const gcDeadline = Date.now() + 15000;
  while (Date.now() < gcDeadline) {
    if (pgrepWhisper().length === 0) { gone = true; break; }
    await delay(300);
  }
  check('whisper-server 도 함께 죽는다 (메모리 1.6GB 회수)', gone, pgrepWhisper().join(','));
  check('게이트웨이 포트가 닫힌다', !(await portOpen(GATEWAY_PORT)));
  check('whisper 포트가 닫힌다', !(await portOpen(WHISPER_PORT)));
} catch (err) {
  fail += 1;
  console.log(`  FAIL ${String(err.message ?? err)}`);
} finally {
  try { proc.kill('SIGKILL'); } catch {}
  for (const pid of pgrepWhisper()) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
}

console.log(`\nreal-kill: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
