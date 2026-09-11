# SideNote

> **English below the Korean intro — see [English](#english).**

Chrome에서 재생 중인 강의 탭의 소리를 **Chrome 내장 기기 내(on-device) 음성인식**으로 실시간 자막화하고,
오른쪽 Side Panel에 **자막 · 메모 · 화면 캡처**를 함께 쌓아두는 Chrome 확장입니다.

- 음성 인식은 전부 이 컴퓨터 안에서 돕니다. 외부 API도, API 키도, 과금도, 켜 둘 서버도 없습니다.
- 설치는 확장 하나뿐입니다. 동반 프로그램(.pkg)도, `nativeMessaging` 권한도 쓰지 않습니다.
- **모든 사이트 권한을 요구하지 않습니다.** 넓은 `host_permissions` 대신 `activeTab` 만 써서, 툴바 아이콘을 누른
  그 탭에서만 동작합니다. 설치 화면에 "방문하는 모든 웹사이트의 데이터 읽기/변경" 경고가 뜨지 않습니다.
- **영상마다 노트가 따로 생깁니다.** 다른 영상으로 넘어가면 자막이 자동으로 새로 시작되고, 이전 영상의
  자막·메모·캡처는 [기록] 에 남습니다.
- STT가 실패해도 메모와 캡처는 계속 동작하고, 캡처가 실패해도 자막과 메모는 계속 동작합니다.
- Chrome 139 이상이 필요합니다(`SpeechRecognition.available()` / `install()` / `processLocally`가 그 버전부터입니다).
- 화면 글자 언어는 오른쪽 위에서 직접 고릅니다(영어·한국어·일본어·중국어 간체, 기본값은 브라우저 언어).
  말소리 언어는 [자막 설정] 에서 22개 중 골라 씁니다.
- **번역도 기기 안에서 합니다.** [자막 설정] 에서 자막 언어를 고르면 Chrome 내장 번역기(Translator API)가
  확정된 자막 줄마다 그 언어로 옮겨 보여 줍니다. 말소리 언어와 같은 언어를 고르면 옮기지 않고 말한 그대로
  보여 줍니다. 여기도 API 키·과금·서버가 없습니다.

---

## English

SideNote is a Chrome extension that turns the audio of the lecture tab you are watching into live captions using
**Chrome's built-in on-device speech recognition**, and stacks **captions, notes, and screen captures** together
in the right-hand Side Panel.

- Recognition runs entirely on your computer. No external API, no API key, no billing, no server to keep running.
- One extension is the whole install. No companion program (`.pkg`), no `nativeMessaging` permission.
- **It does not ask for access to every site.** Instead of broad `host_permissions` it uses `activeTab` alone, so it
  works only on the tab where you clicked the toolbar icon — no "read and change all your data on the websites you
  visit" warning at install time.
- **Each video gets its own notebook.** Move to another video and captions restart automatically; the previous
  video's captions, notes, and captures stay in [History].
- If speech recognition fails, notes and captures keep working; if capture fails, captions and notes keep working.
- Requires Chrome 139+ (`SpeechRecognition.available()` / `install()` / `processLocally` landed in that version).
- **Translation runs on-device too.** Under [Caption settings] you pick the caption language and Chrome's
  built-in Translator API translates every finished caption line into it. Pick the language that is being
  spoken and captions stay exactly as spoken. Again with no API key, no billing, no server.

### Languages

The **interface language** is chosen in the top right of the panel: English, Korean, Japanese, Simplified
Chinese, or "Browser language", which follows Chrome's own UI language. All four ship in the package
(`apps/extension/public/_locales/`); adding another language means dropping in one more
`_locales/<lang>/messages.json` and one line in `UI_LANGUAGES` — every visible string goes through `t()` in
`apps/extension/src/shared/i18n.ts`. Chrome cannot repoint `chrome.i18n` at runtime, so a manual choice makes
`t()` fetch that folder's `messages.json` and read from it instead; the choice is stored in `uiLang` and applied
before the panel renders, and the service worker and offscreen document apply it too so their messages match.

The **caption language** is separate and chosen in the panel, so a Korean-language browser can caption an
English lecture. The list lives in `apps/extension/src/shared/languages.ts` (22 locales: English, Korean,
Japanese, Chinese, Spanish, French, German, Italian, Portuguese, Russian, Hindi, Arabic, Indonesian,
Vietnamese, Thai, Turkish, Dutch, Polish, Swedish). Chrome downloads the on-device speech pack for the
chosen language on first use; Chrome does not expose an API to enumerate which packs a given machine
supports, so the extension checks availability at runtime and reports what it finds.

The **caption language** is a second choice next to the spoken language, handled by Chrome's built-in
Translator API (Chrome 138+, on-device, no key and no per-call cost). `apps/extension/src/transcription/translator.ts`
wraps it: it maps each caption locale to a translator code (`cmn-Hans-CN` → `zh`), creates one translator
per session, and returns an empty string on every failure path — so an unsupported device or language pair
loses the translation only, never the captions. Chrome downloads the language-pair model on first use, which
is why the panel warms the translator up inside your click, the same way it warms the speech pack. Only
**finished** lines are translated: interim recognition results keep being rewritten while someone speaks, so
translating them would make the screen flicker for nothing. When the caption language equals the spoken
language no translator is created at all and the interim line streams live, and the overlay clears itself after
a few seconds of silence instead of leaving the last line on the video.

### Build it yourself

```bash
npm install
npm run typecheck && npm test && npm run build
```

Then open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick `apps/extension/dist`.
`npm run release:chrome` produces the Web Store ZIP in `release/` and runs 15 pre-upload checks.

Store copy: `store/STORE-LISTING.en.md`, privacy policy: `store/PRIVACY.en.md`.

---

## Mac에서 처음부터 따라 하기 (8단계)

1~4단계는 터미널, 5~8단계는 Chrome 화면에서 합니다.

### 1. 필수 도구 확인

```bash
node -v && npm -v && git --version
```

`node`가 없으면 `brew install node`, `git`이 없으면 `xcode-select --install`을 먼저 실행하세요.
(검증에 쓴 환경: macOS 26.3.1 / Node v25.9.0 / npm 11.12.1 / Chrome 152)

### 2. 프로젝트 폴더로 이동

```bash
cd ~/orca/projects/my-study
```

### 3. 의존성 설치

```bash
npm install
```

### 4. 타입 검사 + 테스트 + 빌드

```bash
npm run typecheck && npm test && npm run build
```

확장 142개 + 서버 54개, 총 **196개 테스트**가 통과해야 합니다.
빌드 결과는 `apps/extension/dist/`에 Chrome이 바로 읽을 수 있는 형태로 나옵니다.

```bash
ls apps/extension/dist
```

`manifest.json`, `background.js`, `sidepanel.html`, `offscreen.html`, `icons/`, `assets/`가 보이면 성공입니다.

### 5. Chrome에 확장 로드

1. 주소창에 `chrome://extensions` 입력
2. 오른쪽 위 **개발자 모드** 켜기
3. 왼쪽 위 **압축해제된 확장 프로그램을 로드합니다** 클릭
4. `~/orca/projects/my-study/apps/extension/dist` 폴더 선택

폴더 경로를 Finder에서 열려면:

```bash
open apps/extension/dist
```

### 6. 강의 탭에서 자막 시작

1. 강의/인강 영상을 **재생**합니다.
2. **그 강의 탭에서** 툴바의 **SideNote** 아이콘을 클릭합니다. 오른쪽에 Side Panel이 열립니다.
   - 이 클릭이 Chrome이 요구하는 "사용자 호출"(`activeTab`)입니다. 이걸 해야 그 탭의 오디오 캡처·화면 캡처·영상 위 자막이 동작합니다.
     SideNote 는 넓은 호스트 권한을 선언하지 않아, **아이콘을 누른 탭 말고는 어떤 페이지에도 접근하지 않습니다.**
   - **주소가 바뀌면(다른 강의로 이동, 새로고침) 권한이 회수됩니다.** 패널 위쪽에 노란 안내가 뜨면 아이콘을 한 번 더 누르세요.
3. **자막 시작**을 누릅니다. Chrome이 탭 소리 공유를 물어보면 허용합니다.
   - 처음 한 번은 Chrome이 음성 인식 언어팩(ko-KR)을 내려받는 동안 잠시 기다릴 수 있습니다.
4. 오른쪽 위 칩이 `실시간 연결됨`으로 바뀌고 몇 초 뒤부터 자막이 아래로 쌓입니다.

- **일시정지 / 계속하기 / 종료** 버튼으로 제어합니다.
- 자막 줄의 **복사**는 그 줄만, 위쪽 **전체 복사**는 전부 클립보드로 복사합니다.
- 목록은 항상 맨 아래로 따라가지만, 위로 스크롤해 읽는 중에는 따라가지 않습니다(**자동 스크롤** 토글이 자동으로 꺼짐). 다시 켜거나 맨 아래로 내리면 재개됩니다.
- **영상 위 자막** 토글을 켜면 유튜브 자막처럼 영상 아래쪽에 자막이 겹쳐 보입니다. 확정된 줄 + 인식 중인 말을 합쳐 두 줄까지만 띄우고, 영상 크기·스크롤·전체화면을 따라 위치가 바뀝니다. 이 오버레이는 저장하지 않는 화면 표시일 뿐이라, 꺼도 패널의 자막 기록은 그대로 쌓입니다.

### 7. 영상이 바뀔 때 — 현재 자막 · 기록

- 같은 탭에서 **다른 영상**으로 넘어가면 자막 화면이 비워지고 새 노트가 시작됩니다. 이전 영상 자막이 섞이지 않습니다.
- **같은 영상**으로 돌아오면(새로고침, `?t=903s` 같은 재생 위치가 붙은 주소 포함) 원래 쓰던 노트를 이어서 씁니다.
- 위쪽 **[기록 ▾]** 에 지난 노트가 사이트·시각·자막 수와 함께 쌓입니다. 눌러서 언제든 다시 엽니다.
- **[+ 새 자막 시작]** 은 지금 영상에서 노트를 새로 시작합니다(지금까지 쌓인 것은 기록에 남습니다).
- **[현재 자막 지우기]** 는 이 노트의 자막만 지웁니다. **메모와 캡처는 그대로 남습니다.**
- 자막을 **받는 도중에** 다음 영상으로 넘어가면, 자막이 엉뚱한 노트에 쌓이지 않도록 그 자리에서 자막이 종료됩니다. 종료 직후 화면은 새 영상의 노트로 바뀌므로, [자막 시작] 을 다시 누르면 새 영상 노트에 쌓입니다.

### 8. 메모, 화면 캡처, 저장 확인

- **현재 자막 / 노트** 탭으로 화면을 바꿉니다. 자막 탭에는 자막·간단 메모·캡처 썸네일이, 노트 탭에는 큰 메모장과 캡처별 메모가 있습니다.
- **내 노트** 칸에 적으면 0.6초 뒤 자동 저장되고 `저장됨`으로 표시됩니다. 실패하면 `저장 실패`와 **다시 시도** 버튼이 뜹니다.
- **캡처** 버튼을 누르면 현재 화면이 저장됩니다. 재생 중인 영상이 있으면 그 영역만 잘라내고(`영상 영역`), 못 찾으면 화면 전체(`화면 전체`)를 저장하며 영상 재생 위치도 함께 남습니다.
- 캡처마다 메모를 달 수 있고 **삭제**로 지웁니다(자막 탭 썸네일은 마우스를 올리면 `×`, 노트 탭은 **삭제** 버튼).
- 캡처의 **복사**는 이미지 아래에 제목·재생 위치·메모까지 그려 넣은 PNG 한 장을 클립보드에 올립니다. 이미지와 텍스트를 따로 넣으면 붙여넣는 앱이 둘 중 하나만 골라 메모가 사라지므로, 한 장으로 합쳐 둡니다(노션·슬랙·카톡 어디에 붙여도 캡처와 메모가 함께 갑니다). 이미지를 못 붙이는 메모장류를 위해 `text/plain` 도 함께 넣습니다.
- 캡처의 **저장**은 같은 PNG를 `강의제목_00-12-43.png` 로 내려받습니다.
- 컨트롤 아래 **전체 저장**은 그 강의의 자막 전체 + 내 노트 + 모든 캡처(+캡처별 메모)를 HTML 파일 하나로 묶어 내려받습니다. 이미지가 파일 안에 들어 있어 인터넷 없이 더블클릭만으로 열리고, 그대로 인쇄하거나 PDF로 저장할 수 있습니다.
- 강의 플레이어가 iframe 안에 있는 사이트(대학 LMS의 VOD 뷰어 등)에서는 영상 영역 좌표를 신뢰할 수 없어 **화면 전체**로 저장합니다. 재생 위치(`영상 12:43`)는 iframe 안이어도 함께 기록됩니다.


Side Panel을 닫았다 다시 열거나 탭을 새로고침해도 자막·메모·캡처가 그대로 남아 있어야 합니다.

---

## 구조

```
apps/extension/          Chrome MV3 확장  ← 배포되는 것은 이것 하나뿐
  src/background/        서비스 워커: 상태 머신, tabCapture, 화면 캡처
  src/offscreen/         오프스크린 문서: 오디오 트랙 → 인식기, 자막 저장
  src/sidepanel/         React UI (현재 자막/기록/노트)
  src/transcription/     인식기 어댑터
    provider.ts            어댑터 인터페이스 (다른 엔진으로 교체 가능한 자리)
    chrome-speech.ts       Chrome 기기 내 음성인식 제공자  ← 지금 쓰는 유일한 경로
  src/storage/db.ts      Dexie(IndexedDB) 스키마와 쿼리 (v3)
  src/shared/            상태 머신·자막 병합·캡처 crop·pageKey 등 순수 로직(테스트 대상)
    url.ts                 세션 복원 키. 유튜브처럼 경로가 같고 ?v= 로만 영상이 갈리는 사이트를 구분
scripts/release-chrome.mjs 웹스토어 ZIP 빌더 + 업로드 전 검사 13가지
store/                   웹스토어 제출 원고 (등록정보 · 개인정보 · 배포 순서)
```

빌드에 들어가지 않는 워크스페이스는 아래 **부록**을 보세요.

### 오디오가 흐르는 길

```
탭 소리
  └─ chrome.tabCapture (background)
       └─ offscreen document
            ├─ AudioContext(원본 샘플레이트) → 스피커   ※ 소리가 끊기지 않게 되돌려 줌
            └─ 오디오 트랙 → Chrome SpeechRecognition (processLocally: true)
                 └─ 이 컴퓨터 안에서 인식 → transcript → IndexedDB → Side Panel
```

## 알려진 한계

- **자막은 완벽하지 않습니다.** 기기 내 인식 모델의 한계로 조사나 어미가 틀릴 수 있습니다. 받아쓰기 대체재가 아니라 복습용 보조 자막입니다.
- **Chrome 139 미만에서는 자막이 만들어지지 않습니다.** 매니페스트의 `minimum_chrome_version`으로 설치 자체를 막아 뒀습니다.
- **언어팩이 없으면 첫 시작이 지연되거나 실패할 수 있습니다.** 패널이 이유와 다음 행동(Chrome 설정 → 언어에서 추가)을 안내합니다. 이때도 메모와 캡처는 그대로 동작합니다.
- **이전 버전에서 한 노트에 섞여 저장된 유튜브 자막은 되돌릴 수 없습니다.** v3 마이그레이션이 노트의 키를 영상별로 다시 계산하지만, 이미 한 줄씩 번갈아 저장된 자막을 영상별로 나눌 수는 없습니다. 새로 만드는 노트부터 영상별로 갈립니다.
- Chrome이 탭 소리를 캡처하는 동안에는 그 소리를 오프스크린 문서가 스피커로 되돌려 보냅니다. 아주 짧은 지연이 생길 수 있습니다.
- 자막·메모·캡처는 이 브라우저의 IndexedDB에만 저장됩니다. 다른 기기와 동기화되지 않습니다. 남기고 싶으면 **전체 저장**으로 HTML 파일을 내보내세요.
- **영상 위 자막은 일부 사이트에서 안 보일 수 있습니다.** 플레이어가 `<video>` 자체를 전체화면으로 올리면 그 위에는 아무것도 못 그리므로 오버레이를 자동으로 숨깁니다(패널 자막은 계속 쌓입니다). 브라우저 전체화면(F11)이나 플레이어 컨테이너 전체화면에서는 정상 동작합니다.

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| 자막이 안 쌓임 | 영상이 실제로 **소리를 내며 재생 중**인지. 무음 구간에서는 자막이 나오지 않습니다 |
| `음성 인식에 실패했습니다` | 패널에 뜬 문구가 그대로 원인입니다(Chrome 버전 / 언어팩 / 마이크 권한). 메모·캡처는 계속 쓸 수 있습니다 |
| 자막 시작이 회색 | 그 탭에서 SideNote 아이콘을 한 번 눌러 주세요. 주소가 바뀌면 Chrome이 권한을 회수합니다 |
| 이전 영상 자막이 남아 보임 | 이전 버전에서 만든 노트입니다. [+ 새 자막 시작] 을 누르면 지금부터는 영상별로 갈립니다 |
| 확장 로드 실패 | `npm run build` 후 `apps/extension/dist`(상위 폴더 아님)를 선택했는지 |
| 코드 수정 후 반영 안 됨 | `npm run build` → `chrome://extensions`에서 새로고침 아이콘 클릭 |

## 개발용 명령

```bash
npm run typecheck        # 두 워크스페이스 타입 검사
npm test                 # 단위/통합 테스트 196개 (확장 142 + 서버 54)
npm run build            # 확장 빌드 → apps/extension/dist
npm run release:chrome   # 웹스토어 ZIP → release/ (+ 업로드 전 검사 13가지)
```

---

## 배포 (Chrome 웹스토어)

```
npm run release:chrome
```

`release/sidenote-<버전>.zip` 이 만들어지고 업로드 전 검사 16가지가 자동으로 돌아갑니다.
이 ZIP 은 `manifest.json` 이 최상단에 있고, 설치 프로그램(.pkg)·macOS 부산물·소스맵은 들어가지 않으며,
설명해 둔 권한 7개 외의 권한(특히 `nativeMessaging`)이나 넓은 호스트 권한(`host_permissions`)이 들어오면 FAIL 로 막습니다.
개발용 `apps/extension/dist/` 는 건드리지 않습니다(스토어 빌드는 `dist-store/` 에 따로 만듭니다).

- 대시보드에 붙여 넣을 원고: `store/STORE-LISTING.md`
- 공개 주소에 올릴 개인정보 처리방침: `store/PRIVACY.md`
- 눌러야 하는 순서 전체: `store/DEPLOY.md`

---

# 부록: 배포에 포함되지 않는 워크스페이스 (외부 Whisper 엔진 실험)

`apps/stt-server/`(Fastify + WebSocket 게이트웨이)와 `apps/native-host/`(macOS 동반 실행기)는
로컬 whisper.cpp 를 자막 엔진으로 쓰던 경로입니다. **지금 배포판은 이 경로를 쓰지 않습니다.**

- 확장 빌드 진입점(`apps/extension/vite.config.ts`)에 들어 있지 않아 번들에 포함되지 않습니다.
- `nativeMessaging` 권한이 매니페스트에서 빠졌고, `release:chrome` 이 그것을 매번 검사합니다.
- 확장 쪽 `src/transcription/client.ts`, `src/background/native.ts`, `src/setup/main.ts`,
  `src/shared/engine-dist.ts` 도 같은 이유로 디스크에만 남아 있습니다(빌드 산출물에는 없습니다).

아래 내용은 그 워크스페이스를 다시 살릴 때를 위한 기록입니다. 지금 확장을 쓰거나 배포하는 데에는 필요 없습니다.

<details>
<summary>whisper 게이트웨이 설정 · 모델 · 품질 측정 기록 (펼치기)</summary>

## 설정

`.whisper-env`(설치 스크립트가 생성)와 환경변수로 조정합니다. 환경변수가 항상 우선입니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `8787` | 게이트웨이 포트 |
| `WHISPER_PORT` | `8788` | whisper-server 포트 |
| `WHISPER_MODEL` | `.whisper-env`에 적힌 경로 | 모델 경로. `setup:whisper`가 마지막에 받은 모델로 채웁니다 |
| `WHISPER_LANGUAGE` | `ko` | 인식 언어 |
| `WHISPER_THREADS` | CPU 코어의 절반 | 스레드 수 |
| `STT_WINDOW_MS` | `5000` | window 길이. 짧게 줄이면 자막이 빨리 뜨지만 문장이 잘게 부서짐 |
| `STT_OVERLAP_MS` | `1200` | 겹치는 구간. window 경계에서 단어가 잘리는 것을 막음 |
| `WHISPER_BEAM_SIZE` | `3` | beam search 폭. `0`이면 greedy(빠르고 덜 정확) |
| `STT_LINE_MAX_MS` | `15000` | 문장이 안 끝나도 자막 한 줄을 여기서 끊음 |
| `STT_LINE_MAX_CHARS` | `90` | 자막 한 줄의 최대 글자 수 |
| `STT_PROMPT_CONTEXT_CHARS` | `260` | 직전 자막을 Whisper 프롬프트로 되돌려주는 길이 |
| `STT_MIN_RMS` | `180` | 이 값 미만이면 무음으로 보고 Whisper를 호출하지 않음 |
| `STT_MAX_BACKLOG_SEC` | `20` | 밀린 오디오 상한. 넘으면 오래된 것부터 버림 |
| `WHISPER_SERVER_URL` | (없음) | 이미 떠 있는 whisper-server에 붙을 때. 설정하면 새로 띄우지 않음 |

### 모델 바꾸기

`npm run setup:whisper <모델이름>`을 실행하면 그 모델을 받고 `.whisper-env`를 새로 씁니다.
그다음부터 `npm run start:server`는 그 모델로 뜹니다.

```bash
npm run setup:whisper large-v3-turbo   # 권장. 가장 정확
npm run setup:whisper small            # 가벼움. 메모리 여유가 없을 때
```

한 번만 다른 모델로 띄워보고 싶으면 환경변수로 덮어씁니다(`.whisper-env`는 그대로).

```bash
WHISPER_MODEL=$PWD/models/ggml-small.bin npm run start:server
```

M5 맥에서 실측한 5초 window 하나당 인식 시간입니다. 이 값이 **3.8초**(window가 넘어가는 간격)를
넘으면 인식이 실시간을 못 따라가 밀린 오디오를 버리게 되고, 자막이 중간중간 빕니다.

| 모델 | 파일 크기 | 5초 window 인식 시간 | 실시간 대비 | 여유 |
| --- | --- | --- | --- | --- |
| `small` | 465MB | 224ms | 0.04배 | 충분 |
| `large-v3-turbo` | 1.5GB | 593ms | 0.12배 | 충분 |

둘 다 여유가 커서 turbo를 써도 자막이 늦게 뜨지 않습니다. 대신 모델을 메모리에 올려두므로
turbo는 램을 1.5GB 정도 더 씁니다.

## 자막 품질

"자막이 너무 잘게 끊겨서 나온다"는 문제를 실측으로 잡은 결과입니다.
`.cache/e2e-ko-long.wav`(4문장 21.24초, 중간에 2초 무음)를 `npm run e2e:stt` 로 돌린 값입니다.

| 항목 | 이전(3초 window / 0.6초 overlap, greedy, `small`) | 지금(5초 / 1.2초, beam 3, `large-v3-turbo`) |
| --- | --- | --- |
| 인식되는 window 수 | 2.4초마다 = 9개 | 3.8초마다 = 6개 |
| 실제로 나온 자막 줄 수 | window마다 1줄 = 9줄 | **4줄** (문장 수와 같음) |
| window 하나를 인식하는 시간 | 0.22초 | 0.59초 |
| 강의에서 첫 자막이 뜨기까지 | 약 3.2초 | 약 5.6초 |

두 줄을 구분해서 읽어야 합니다. E2E는 음성 파일을 한 번에 밀어 넣으므로 **인식 시간**만 잽니다
(0.22초 → 0.59초는 window 길이와 무관하게 모델을 `small`에서 `large-v3-turbo`로 바꾼 값입니다).

실제 강의에서는 window를 채울 만큼의 소리가 실시간으로 쌓여야 첫 인식이 시작됩니다. 그래서
자막 시작을 누르고 **첫 줄이 뜨기까지 약 5.6초**(5초치 소리 + 0.6초 인식)를 기다립니다.
예전 3초 window에서는 약 3.2초였습니다. 2.4초 더 기다리는 대신 그 한 줄이 문장 하나를
통째로 담고 있습니다(예전에는 `...알아보게`에서 잘렸습니다). 첫 줄 이후로는 3.8초마다 갱신됩니다.

무엇을 바꿔서 이렇게 됐는지:

1. **window를 5초로 늘리고 겹침을 1.2초로**(`STT_WINDOW_MS` / `STT_OVERLAP_MS`).
   한국어 한 문장은 3초에 안 들어가서, 3초 window는 문장을 반드시 두 동강 냈습니다.
2. **window 자막을 문장 단위로 묶음**(`src/aggregate.ts`). 마침표·물음표나 15초/90자를 넘길 때까지 이어 붙입니다.
3. **말이 멈추면 그 자리에서 줄을 끊음.** window 전체가 조용해질 때뿐 아니라 **window 끝 1초**만
   조용해도 끊습니다. 그래서 5초 window 안에 있는 2초짜리 쉼도 줄 경계가 됩니다
   (실측: 무음 시작 10600ms → 자막 줄이 12600ms에서 끊김).
4. **beam search 3**(`WHISPER_BEAM_SIZE`). 같은 오디오·같은 모델로 A/B 한 결과:

   | | greedy(`WHISPER_BEAM_SIZE=0`) | beam 3 (기본값) |
   | --- | --- | --- |
   | 1문장 | `안녕하세여, 오늘 강의에서는...` | `안녕하세요. 오늘 강의에서는...` |
   | 4문장 | `...시험 범위를 하시겠습니다.` | `...시험 범위를 알려드리겠습니다.` |

6. **직전 자막을 다음 window 프롬프트로 넘김**(`STT_PROMPT_CONTEXT_CHARS`). 문맥이 이어져
   고유명사·전문 용어가 덜 틀립니다. 30초 이상 조용하면 초기화합니다.

5. **모델을 `large-v3-turbo`로**(위 §모델 바꾸기). 같은 오디오·같은 설정으로 `small`과 비교한 결과,
   겹침 구간이 깨지는 현상이 사라졌습니다.

   | | `small` | `large-v3-turbo` (기본값) |
   | --- | --- | --- |
   | 겹침 구간 | `...정리하고, **문 맥 교화 시 이하고, 문 맥 교환** 비용을...` | `...정리하고 **문맵 교환** 비용을...` |
   | 용어 | `라운드로빈` / `우선 순위` | `라운드 로빈` / `우선순위` (원문 일치) |
   | 첫 문장 | `안녕하세여 오늘...` | `안녕하세요 오늘...` |

   `small`은 첫 5초 안에 문장을 못 끝내지만 turbo는 끝내기 때문에, 짧은 문장은 진행 중 자막을
   거치지 않고 바로 확정 자막으로 뜹니다.


### 그때의 알려진 한계

- **window가 겹치는 구간에서 같은 말이 두 번 다르게 들리면 글자가 깨질 수 있습니다.**
  겹친 1.2초를 Whisper가 앞뒤 window에서 서로 다르게 받아쓰면 글자가 하나도 안 겹쳐,
  중복 제거가 이어 붙일 자리를 못 찾고 둘 다 남습니다
  (`small` 실측: `문맥 교환` → `...문 맥 교화 시 이하고, 문 맥 교환 비용을...`).
  기본 모델 `large-v3-turbo`에서는 같은 구간이 `문맵 교환` 한 번으로 나와 이 현상이 관찰되지 않았습니다.
  비슷하기만 하면 지우는 방식은 실제로 두 번 말한 문장까지 지워버려서 쓰지 않았습니다.
- **프롬프트가 첫 단어를 삼킬 수 있습니다.** 강의 페이지 제목을 Whisper 프롬프트로 넘겨 전문 용어 인식률을 올리지만(실측: `안녕하세여 → 안녕하세요`, `운영 체제 → 운영체제`), Whisper는 프롬프트를 "직전에 이미 말한 문장"으로 취급합니다. 그래서 오디오 첫머리가 제목과 같은 단어로 시작하면 그 부분을 건너뜁니다(실측: 제목이 `프로세스 스케줄링`일 때 해당 구간에서 `스케줄링`이 누락). 3초 window가 문장 중간에서 시작하는 실제 강의에서는 드물게 나타납니다.
- **1.2초 미만의 마지막 꼬리는 버립니다.** Whisper가 그보다 짧은 오디오에서는 없는 말을 지어내기 때문입니다(실측: 0.83초 → `고개기스입니다`).

</details>
