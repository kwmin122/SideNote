/**
 * 현재 이 컴퓨터의 Chrome 에 로드된 "우리 확장" 의 ID 를 찾아낸다.
 *
 * 사용자에게 chrome://extensions 에서 32자 ID 를 복사시키지 않기 위한 장치다.
 * Chrome 은 프로필의 Preferences 에 압축 해제 확장의 설치 경로를 남기므로, dist 경로가 일치하는
 * 항목의 키가 곧 확장 ID 다. 스토어 배포판 ID 는 발급된 뒤 EXTRA_EXTENSION_IDS 로 더해 주면 된다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ID_RE = /^[a-p]{32}$/;

/** Chrome 계열 사용자 데이터 디렉터리(macOS). */
export function chromeUserDirs(home = os.homedir()) {
  return [
    'Google/Chrome',
    'Google/Chrome Beta',
    'Google/Chrome Dev',
    'Google/Chrome Canary',
    'Chromium'
  ].map((name) => path.join(home, 'Library/Application Support', name));
}

function profileDirs(userDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(userDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && (e.name === 'Default' || e.name.startsWith('Profile')))
    .map((e) => path.join(userDir, e.name));
}

/** 확장이 설치된 경로가 distPath 와 같은(또는 그 아래) 항목의 ID 를 모은다. */
export function detectExtensionIds(distPath, home = os.homedir()) {
  const wanted = path.resolve(distPath);
  const found = new Set();
  for (const userDir of chromeUserDirs(home)) {
    for (const profile of profileDirs(userDir)) {
      for (const file of ['Preferences', 'Secure Preferences']) {
        let data;
        try {
          data = JSON.parse(fs.readFileSync(path.join(profile, file), 'utf8'));
        } catch {
          continue;
        }
        const settings = data?.extensions?.settings ?? {};
        for (const [id, meta] of Object.entries(settings)) {
          if (!ID_RE.test(id)) continue;
          const installed = typeof meta?.path === 'string' ? path.resolve(meta.path) : '';
          if (installed === wanted || installed.startsWith(`${wanted}${path.sep}`)) found.add(id);
        }
      }
    }
  }
  return [...found];
}

/** 이미 등록해 둔 매니페스트에 들어 있던 ID. 재설치로 기존 연결이 끊기지 않게 한다. */
export function idsFromInstalledManifests(hostName, home = os.homedir()) {
  const found = new Set();
  const dirs = [
    ...chromeUserDirs(home).map((dir) => path.join(dir, 'NativeMessagingHosts')),
    '/Library/Google/Chrome/NativeMessagingHosts',
    '/Library/Google/Chrome Beta/NativeMessagingHosts',
    '/Library/Google/Chrome Canary/NativeMessagingHosts',
    '/Library/Application Support/Chromium/NativeMessagingHosts'
  ];
  for (const dir of dirs) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(path.join(dir, `${hostName}.json`), 'utf8'));
    } catch {
      continue;
    }
    for (const origin of json?.allowed_origins ?? []) {
      const id = String(origin).replace('chrome-extension://', '').replace(/\/$/, '');
      if (ID_RE.test(id)) found.add(id);
    }
  }
  return [...found];
}

export function isExtensionId(value) {
  return ID_RE.test(String(value));
}

// node ext-ids.mjs <distPath> => 찾은 ID 를 줄바꿈으로 출력 (install.sh 가 그대로 읽는다)
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const dist = process.argv[2] ?? path.resolve(process.cwd(), 'apps/extension/dist');
  process.stdout.write(`${detectExtensionIds(dist).join('\n')}\n`);
}
