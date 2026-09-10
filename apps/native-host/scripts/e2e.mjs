/**
 * Native Messaging 호스트를 Chrome 없이 터미널에서 그대로 검증한다.
 * stdio 프레이밍을 직접 말하면서 (1) ready 가 오는가 (2) 포트가 열리는가
 * (3) 연결을 끊으면 게이트웨이가 죽는가 (4) 남이 띄운 서버는 건드리지 않는가 를 본다.
 *
 * 모델 로딩을 피하려고 WHISPER_SERVER_URL 을 넣어 whisper-server 는 띄우지 않는다.
 * (게이트웨이는 그래도 포트를 열기 때문에 호스트 검증에는 영향이 없다.)
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecoder, encodeMessage } from '../src/framing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = path.join(here, '../src/host.mjs');

let passed = 0;
let failed = 0;
function check(name, ok, extra = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function probe(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
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

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startHost(env) {
  const proc = spawn(process.execPath, [HOST_ENTRY], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env }
  });
  const messages = [];
  const waiters = [];
  const decode = createDecoder((message) => {
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].match(message)) waiters.splice(i, 1)[0].resolve(message);
    }
  });
  proc.stdout.on('data', decode);
  return {
    proc,
    messages,
    send: (value) => proc.stdin.write(encodeMessage(value)),
    waitFor(match, timeoutMs = 25000) {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout: ${match}`)), timeoutMs);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    exited: new Promise((resolve) => proc.once('exit', (code) => resolve(code)))
  };
}

async function testSpawnAndKill() {
  console.log('게이트웨이를 대신 띄우고 연결이 끊기면 같이 죽는다');
  const PORT = 8799;
  const host = startHost({
    PORT: String(PORT),
    WHISPER_SERVER_URL: 'http://127.0.0.1:9/inference',
    HOST_HEARTBEAT_MS: '300'
  });

  const ready = await host.waitFor((m) => m.type === 'ready').catch((err) => ({ type: 'timeout', err }));
  check('ready 메시지가 온다', ready.type === 'ready', JSON.stringify(host.messages));
  if (ready.type !== 'ready') {
    host.proc.kill('SIGKILL');
    return;
  }
  check('직접 띄웠다고 보고한다(spawned=true)', ready.spawned === true);
  check('첫 메시지는 진행 상황(status)이다', host.messages[0]?.type === 'status');
  check('게이트웨이 포트가 열려 있다', await probe(PORT));

  const gatewayPid = ready.pid;
  check('게이트웨이 pid 를 알려준다', Number.isInteger(gatewayPid) && alive(gatewayPid));

  const beat = await host.waitFor((m) => m.type === 'heartbeat', 3000).catch(() => null);
  check('서비스워커를 깨워둘 heartbeat 를 보낸다', beat?.type === 'heartbeat');

  host.send({ type: 'ping' });
  const pong = await host.waitFor((m) => m.type === 'pong', 3000).catch(() => null);
  check('ping 에 pong 으로 답한다', pong?.type === 'pong');

  // Chrome 이 포트를 끊는 것과 같다.
  host.proc.stdin.end();
  const code = await Promise.race([host.exited, delay(8000).then(() => 'timeout')]);
  check('연결이 끊기면 호스트가 종료된다', code === 0, `code=${code}`);

  for (let i = 0; i < 40 && alive(gatewayPid); i += 1) await delay(100);
  check('게이트웨이도 함께 죽는다', !alive(gatewayPid));
  check('포트가 닫힌다', !(await probe(PORT)));
}

async function testAdoptExisting() {
  console.log('이미 떠 있는 서버는 새로 띄우지도, 죽이지도 않는다');
  const PORT = 8798;
  const dummy = net.createServer((socket) => socket.end());
  await new Promise((resolve) => dummy.listen(PORT, '127.0.0.1', resolve));

  const host = startHost({ PORT: String(PORT), HOST_HEARTBEAT_MS: '300' });
  const ready = await host.waitFor((m) => m.type === 'ready', 10000).catch(() => null);
  check('이미 떠 있어도 ready 를 준다', ready?.type === 'ready');
  check('새로 띄우지 않았다고 보고한다(spawned=false)', ready?.spawned === false);

  host.proc.stdin.end();
  await Promise.race([host.exited, delay(5000)]);
  check('남이 띄운 서버는 그대로 살아 있다', dummy.listening && (await probe(PORT)));
  await new Promise((resolve) => dummy.close(resolve));
}

await testSpawnAndKill();
await testAdoptExisting();

console.log(`\nnative-host e2e: ${passed} pass / ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
