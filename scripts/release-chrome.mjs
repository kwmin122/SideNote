#!/usr/bin/env node
/**
 * Chrome 웹스토어 업로드용 ZIP 빌더.
 *
 * 웹스토어는 "manifest.json 이 압축 파일 최상단에 있는" ZIP 만 받는다. dist/ 폴더째로 압축하면
 * dist/manifest.json 이 되어 업로드가 거절된다. 그래서 dist 안에서 압축한다.
 *
 * 이 확장은 자막을 Chrome 기기 내 음성인식만으로 만든다. 외부 엔진도, 동반 설치 프로그램도 없다.
 * 그래서 패키지에 실행 파일(.pkg)이 없어야 하고, nativeMessaging 권한도 없어야 한다. 아래에서 둘 다 검사한다.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const extRoot = path.join(repoRoot, 'apps/extension');
// dist/ 는 건드리지 않는다. 개발자가 chrome://extensions 에 로드해 둔 폴더라,
// 스토어 빌드가 그 자리를 비우는 순간 로드해 둔 확장이 깨진다. 스토어 빌드는 별도 폴더에 만든다.
const dist = path.join(extRoot, 'dist-store');
const releaseDir = path.join(repoRoot, 'release');
const stage = path.join(releaseDir, 'stage');

/**
 * 스토어 패키지에서 빼는 최상위 폴더. 지금은 비어 있다(외부 엔진을 아예 빌드에 넣지 않는다).
 * 나중에 실행 파일 계열 자산이 public/ 에 다시 생기면 여기에 이름을 넣는다.
 */
const SKIP_DIRS = new Set();
/**
 * 심사에서 설명해야 할 권한만 남긴다.
 * 여기 없는 권한이 매니페스트에 들어오면 FAIL 이다 - 설명 문구(STORE-LISTING.md)와 어긋난 채로 올라가는 것을 막는다.
 */
const ALLOWED_PERMISSIONS = new Set(['sidePanel', 'activeTab', 'tabCapture', 'storage', 'offscreen', 'tabs', 'scripting']);
const skipFile = (name) => name === '.DS_Store' || name.startsWith('._');

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

function copyTree(from, to, rel = '') {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!rel && SKIP_DIRS.has(entry.name)) {
        console.log(`  제외: ${relPath}/`);
        continue;
      }
      copyTree(path.join(from, entry.name), path.join(to, entry.name), relPath);
      continue;
    }
    if (skipFile(entry.name)) continue;
    fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
  }
}

function main() {
  console.log('1) 스토어용으로 빌드합니다');
  execFileSync('npm', ['run', 'typecheck', '-w', '@study/extension'], { cwd: repoRoot, stdio: 'inherit' });
  execFileSync('npx', ['vite', 'build', '--outDir', 'dist-store', '--emptyOutDir'], {
    cwd: extRoot,
    stdio: 'inherit'
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  const zipName = `${manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${manifest.version}.zip`;
  const zipPath = path.join(releaseDir, zipName);

  console.log('\n2) 패키지를 만듭니다');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  copyTree(dist, stage);
  // 확장속성이 남으면 ZIP 안에 ._ 짝파일이 같이 들어간다. 심사자가 보는 패키지를 깨끗하게 유지한다.
  try {
    execFileSync('/usr/bin/xattr', ['-c', '-r', stage], { stdio: 'ignore' });
  } catch {
    /* xattr 이 없어도 치명적이지 않다 */
  }
  // "." 를 넘겨 stage 안에서 압축한다 = manifest.json 이 ZIP 최상단에 온다.
  execFileSync('/usr/bin/zip', ['-X', '-r', '-q', zipPath, '.'], { cwd: stage });

  console.log('\n3) 업로드 전에 확인합니다');
  const listing = execFileSync('/usr/bin/unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  check('manifest.json 이 ZIP 최상단에 있다 (웹스토어 필수)', listing.includes('manifest.json'));
  check('background.js 가 최상단에 있다', listing.includes('background.js'));
  check('sidepanel.html 이 들어 있다', listing.includes('sidepanel.html'));
  check('offscreen.html 이 들어 있다', listing.includes('offscreen.html'));
  check(
    '아이콘 4종이 들어 있다',
    [16, 32, 48, 128].every((size) => listing.includes(`icons/icon-${size}.png`))
  );
  check(
    '설치 프로그램(.pkg)이 들어 있지 않다',
    !listing.some((name) => name.endsWith('.pkg')),
    listing.filter((name) => name.endsWith('.pkg')).join(', ')
  );
  // 자막을 브라우저 안에서만 만드는 확장이므로 외부 프로그램과 말을 섞을 이유가 없다.
  // 권한이 하나라도 늘면 심사 설명이 늘고, 사용자가 보는 설치 경고 문구도 바뀐다.
  const permissions = manifest.permissions ?? [];
  const extraPermissions = permissions.filter((name) => !ALLOWED_PERMISSIONS.has(name));
  check('설명해 둔 권한만 들어 있다 (nativeMessaging 등 추가 권한 없음)', extraPermissions.length === 0, extraPermissions.join(', '));
  check('nativeMessaging 권한이 없다 (외부 엔진 없음)', !permissions.includes('nativeMessaging'));
  check(
    'macOS 부산물(._, .DS_Store)이 없다',
    !listing.some((name) => name.includes('.DS_Store') || path.basename(name).startsWith('._')),
    listing.filter((name) => name.includes('.DS_Store') || path.basename(name).startsWith('._')).join(', ')
  );
  check('이름이 SideNote 다', manifest.name === 'SideNote', manifest.name);
  check('아이콘이 자리표시자가 아니다 (128px 파일이 1KB 이상)', fs.statSync(path.join(stage, 'icons/icon-128.png')).size > 1024);
  // 스토어 빌드에서 자막을 만드는 유일한 경로가 Chrome on-device 음성인식이다.
  // 그 API(SpeechRecognition.available/install/processLocally)는 Chrome 139 부터라, 그 아래 버전에 설치되면
  // 설치는 되는데 자막이 한 줄도 안 나온다. 심사자가 구버전으로 열어 보는 경우도 막는다.
  check(
    'minimum_chrome_version 이 139 이상이다 (on-device 음성인식 최소 버전)',
    Number.parseInt(manifest.minimum_chrome_version ?? '0', 10) >= 139,
    String(manifest.minimum_chrome_version)
  );
  check(
    '소스맵이 들어 있지 않다',
    !listing.some((name) => name.endsWith('.map'))
  );

  const sizeKb = Math.round(fs.statSync(zipPath).size / 1024);
  console.log(`\n${pass} pass / ${fail} fail`);
  if (fail > 0) {
    console.error('\n업로드하지 마세요. 위 FAIL 을 먼저 고쳐야 합니다.');
    process.exit(1);
  }
  console.log(`\n업로드할 파일: ${zipPath} (${sizeKb}KB)`);
  console.log('다음: https://chrome.google.com/webstore/devconsole → [새 항목] → 이 ZIP 을 올립니다.');
}

main();
