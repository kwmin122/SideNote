#!/usr/bin/env node
/**
 * 만들어진 .pkg 가 "진짜 설치되는 물건" 인지 확인한다. sudo 없이 검증한다.
 *
 * 1) pkg 를 풀어서 실제 담긴 파일을 본다 (매니페스트 / 런처).
 * 2) 매니페스트 내용이 Chrome 이 요구하는 형식인지 본다 (path 절대경로, stdio, allowed_origins).
 * 3) 담긴 런처를 그대로 실행해서 Native Messaging 대화가 되는지 본다 (status -> ready -> pong -> 종료).
 *    이때 게이트웨이가 진짜로 뜨지 않도록, 이미 열린 더미 포트를 PORT 로 준다.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecoder, encodeMessage } from '../src/framing.mjs';
import { detectExtensionIds } from './ext-ids.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(here, '..');
const repoRoot = path.resolve(hostRoot, '../..');
const PKG = path.join(hostRoot, 'dist/SideNoteEngine.pkg');
const HOST_NAME = 'com.study.whisper';
const DUMMY_PORT = 8799;

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(PKG)) {
    console.error(`설치 프로그램이 없습니다: ${PKG}\n먼저 npm run engine:pkg 를 실행하세요.`);
    process.exit(1);
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'study-pkg-verify-'));
  const expanded = path.join(stage, 'expanded');
  execFileSync('/usr/sbin/pkgutil', ['--expand-full', PKG, expanded], { stdio: 'inherit' });

  const payload = path.join(expanded, 'Payload');
  const manifestPath = path.join(payload, 'Library/Google/Chrome/NativeMessagingHosts', `${HOST_NAME}.json`);
  const launcherPath = path.join(payload, 'Library/Application Support/StudyWhisper/study-whisper-host');

  console.log('\n[1] 담긴 파일');
  check('Chrome 용 매니페스트가 들어 있다', fs.existsSync(manifestPath), manifestPath);
  check('런처가 들어 있다', fs.existsSync(launcherPath), launcherPath);
  if (!fs.existsSync(manifestPath) || !fs.existsSync(launcherPath)) return finish();

  const mode = fs.statSync(launcherPath).mode & 0o777;
  check('런처에 실행 권한이 있다', (mode & 0o111) !== 0, `mode=${mode.toString(8)}`);

  console.log('\n[2] 매니페스트 내용');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  check('name 이 호스트 이름과 같다', manifest.name === HOST_NAME, String(manifest.name));
  check('type 이 stdio 다', manifest.type === 'stdio', String(manifest.type));
  check(
    'path 가 설치될 절대 경로다',
    manifest.path === '/Library/Application Support/StudyWhisper/study-whisper-host',
    String(manifest.path)
  );
  const origins = manifest.allowed_origins ?? [];
  check('allowed_origins 가 비어 있지 않다', origins.length > 0, JSON.stringify(origins));
  check(
    'allowed_origins 가 chrome-extension://<id>/ 형식이다',
    origins.every((o) => /^chrome-extension:\/\/[a-p]{32}\/$/.test(o)),
    JSON.stringify(origins)
  );
  // 스토어 배포용 pkg 를 만들 때는 스토어 확장 ID 가 반드시 들어가야 한다. 빠뜨리면 설치는 되는데 연결이 안 된다.
  const storeId = String(process.env.STORE_EXTENSION_ID ?? '').trim();
  if (storeId) {
    check(
      '스토어 확장 ID 가 allowed_origins 에 들어 있다',
      origins.includes(`chrome-extension://${storeId}/`),
      `STORE_EXTENSION_ID=${storeId}`
    );
  }

  const detected = detectExtensionIds(path.join(repoRoot, 'apps/extension/dist'));
  check(
    '지금 Chrome 에 로드된 확장 ID 가 포함돼 있다 (사용자가 ID 를 복사할 필요가 없다)',
    detected.length === 0 || detected.every((id) => origins.includes(`chrome-extension://${id}/`)),
    `detected=${detected.join(',')}`
  );

  console.log('\n[3] 담긴 런처가 실제로 동작한다');
  const launcher = fs.readFileSync(launcherPath, 'utf8');
  const nodePath = launcher.match(/exec "([^"]+)"/)?.[1] ?? '';
  const hostPath = launcher.match(/exec "[^"]+" "([^"]+)"/)?.[1] ?? '';
  check('런처가 가리키는 node 가 존재한다', fs.existsSync(nodePath), nodePath);
  check('런처가 가리키는 host.mjs 가 존재한다', fs.existsSync(hostPath), hostPath);

  // 게이트웨이를 진짜로 띄우지 않도록 더미 포트를 열어 둔다(호스트는 "이미 떠 있다"고 판단한다).
  const dummy = net.createServer(() => {});
  await new Promise((resolve) => dummy.listen(DUMMY_PORT, '127.0.0.1', resolve));

  const proc = spawn(launcherPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(DUMMY_PORT) }
  });
  const seen = [];
  proc.stdout.on('data', createDecoder((message) => seen.push(message)));
  let stderr = '';
  proc.stderr.on('data', (c) => {
    stderr += String(c);
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !seen.some((m) => m.type === 'ready')) await delay(100);
  check('런처를 실행하면 status 를 보낸다', seen.some((m) => m.type === 'status'), JSON.stringify(seen));
  check('이미 떠 있는 게이트웨이를 찾아 ready(spawned=false) 를 보낸다', seen.some((m) => m.type === 'ready' && m.spawned === false), JSON.stringify(seen));

  proc.stdin.write(encodeMessage({ type: 'ping' }));
  const pongDeadline = Date.now() + 5000;
  while (Date.now() < pongDeadline && !seen.some((m) => m.type === 'pong')) await delay(50);
  check('ping 에 pong 으로 답한다 (Native Messaging 프레이밍 정상)', seen.some((m) => m.type === 'pong'), stderr.slice(-200));

  const exited = new Promise((resolve) => proc.once('exit', (code) => resolve(code)));
  proc.stdin.end();
  const code = await Promise.race([exited, delay(6000).then(() => 'timeout')]);
  check('연결을 끊으면 스스로 종료한다', code === 0, String(code));
  if (code === 'timeout') proc.kill('SIGKILL');

  await new Promise((resolve) => dummy.close(resolve));
  finish();
}

function finish() {
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
