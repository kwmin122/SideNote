#!/usr/bin/env node
/**
 * Chrome Native Messaging 동반 앱 (1Password/KeePassXC 방식).
 *
 * 확장이 connectNative 하면 Chrome 이 이 프로세스를 대신 띄우고, 포트를 끊으면 stdin 을 닫는다.
 * 이 프로세스가 하는 일은 하나다: 로컬 STT 게이트웨이(apps/stt-server)를 대신 띄우고 같이 죽인다.
 * 오디오는 여전히 WebSocket(ws://127.0.0.1:8787)으로 흐른다.
 * Native Messaging 은 메시지당 1MB 상한이 있어 PCM 스트리밍 통로로는 쓸 수 없다.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecoder, encodeMessage } from './framing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8787);
/** 포트가 열릴 때까지만 기다린다. 모델 로딩(수 분)은 게이트웨이가 뒤에서 계속한다. */
const READY_TIMEOUT_MS = Number(process.env.HOST_READY_TIMEOUT_MS ?? 20000);
const PROBE_INTERVAL_MS = Number(process.env.HOST_PROBE_INTERVAL_MS ?? 250);
/** 서비스워커는 30초 유휴면 죽는다. 들어오는 네이티브 메시지가 그 타이머를 되돌린다. */
const HEARTBEAT_MS = Number(process.env.HOST_HEARTBEAT_MS ?? 20000);

/** 우리가 띄운 게이트웨이. 남이 이미 띄워둔 서버는 건드리지 않는다. */
let child;
let childLog = '';
let heartbeat;
let exiting = false;

function send(value) {
  try {
    process.stdout.write(encodeMessage(value));
  } catch {
    /* 채널이 이미 닫혔다 */
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 포트에 붙어보는 것으로 "게이트웨이가 살아 있는가"를 판정한다. */
function probe(timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port: PORT });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function spawnGateway() {
  const tsx = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
  const entry = path.join(repoRoot, 'apps/stt-server/src/index.ts');
  // Chrome 이 준 환경에는 node 가 있는 경로가 없을 수 있다. 우리를 띄운 node 의 위치를 넣어준다.
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` };
  const proc = spawn(process.execPath, [tsx, entry], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env });
  // stdout 은 Native Messaging 채널이다. 자식 로그가 섞이면 프로토콜이 깨지므로 여기서 삼킨다.
  const collect = (chunk) => {
    childLog = (childLog + String(chunk)).slice(-2000);
  };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  proc.on('error', (err) => {
    childLog = `${childLog}\n${String(err?.message ?? err)}`.slice(-2000);
  });
  return proc;
}

function ready(spawned) {
  send({ type: 'ready', host: HOST, port: PORT, spawned, pid: child?.pid ?? null });
  heartbeat = setInterval(() => send({ type: 'heartbeat', ts: Date.now() }), HEARTBEAT_MS);
}

function fatal(message) {
  send({ type: 'error', message });
  shutdown(1);
}

async function main() {
  send({ type: 'status', state: 'starting', host: HOST, port: PORT });

  // 사용자가 이미 `npm run start:server` 로 띄워 뒀다면 새로 띄우지 않고, 나갈 때 죽이지도 않는다.
  if (await probe()) {
    ready(false);
    return;
  }

  try {
    child = spawnGateway();
  } catch (err) {
    return fatal(`STT 게이트웨이를 실행하지 못했습니다: ${String(err?.message ?? err)}`);
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (exiting) return;
    if (await probe()) return ready(true);
    if (child && child.exitCode !== null) {
      return fatal(`STT 게이트웨이가 시작하자마자 종료됐습니다. ${childLog.trim().slice(-500)}`);
    }
    if (Date.now() >= deadline) {
      return fatal(`STT 게이트웨이가 ${READY_TIMEOUT_MS}ms 안에 ${HOST}:${PORT} 를 열지 못했습니다. ${childLog.trim().slice(-500)}`);
    }
    await delay(PROBE_INTERVAL_MS);
  }
}

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  if (heartbeat) clearInterval(heartbeat);
  const proc = child;
  child = undefined;
  if (!proc || proc.exitCode !== null) {
    process.exit(code);
    return;
  }
  // 게이트웨이는 SIGTERM 을 받으면 whisper-server 까지 정리하고 나간다(apps/stt-server/src/index.ts).
  const force = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* 이미 죽음 */
    }
    process.exit(code);
  }, 3000);
  proc.once('exit', () => {
    clearTimeout(force);
    process.exit(code);
  });
  try {
    proc.kill('SIGTERM');
  } catch {
    clearTimeout(force);
    process.exit(code);
  }
}

const decode = createDecoder((message) => {
  if (message?.type === 'ping') send({ type: 'pong', ts: Date.now() });
  else if (message?.type === 'shutdown') shutdown(0);
});

process.stdin.on('data', decode);
// Chrome 이 포트를 끊으면 stdin 이 닫힌다. 그게 "이제 죽어라" 신호다.
process.stdin.on('end', () => shutdown(0));
process.stdin.on('close', () => shutdown(0));
process.stdin.on('error', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

void main();
