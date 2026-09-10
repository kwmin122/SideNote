# SideNote 배포 순서 (실제로 눌러야 하는 것만)

배포 대상은 **Chrome 확장 하나**입니다. 자막은 Chrome 에 내장된 기기 내 음성인식만으로 만들기 때문에,
따로 설치할 프로그램도, 켜 둘 서버도, 별도로 배포할 엔진도 없습니다.

| | SideNote 확장 |
| --- | --- |
| 무엇 | Chrome 확장 (Manifest V3) |
| 어디로 | Chrome 웹스토어 |
| 지금 상태 | **제출 가능** |
| 필요한 것 | 개발자 등록비 $5 (1회) |

---

## A-0. 패키지 만들기

```
npm run release:chrome
```

→ `release/sidenote-0.3.0.zip` 이 만들어지고, 업로드 전 검사 13가지가 자동으로 돌아갑니다.
하나라도 FAIL 이면 스크립트가 실패로 끝나며, 그 상태로는 올리지 말라고 알려 줍니다.

검사에 포함된 것 중 중요한 세 가지:

- **`manifest.json` 이 ZIP 최상단에 있는지** — 웹스토어는 `dist/manifest.json` 형태를 거절합니다.
- **선언한 권한이 설명해 둔 7개(`sidePanel`, `activeTab`, `tabCapture`, `storage`, `offscreen`, `tabs`, `scripting`)뿐인지** —
  `store/STORE-LISTING.md` 에 사유를 적어 둔 목록과 대조합니다. 여기 없는 권한이 하나라도 들어오면 FAIL 입니다.
  `nativeMessaging` 은 따로 한 번 더 검사합니다(외부 엔진이 없으므로 절대 들어가면 안 됩니다).
- **`minimum_chrome_version` 이 139 이상인지** — 자막을 만드는 유일한 경로인 Chrome 기기 내 음성인식
  (`SpeechRecognition.available()` / `install()` / `processLocally`)이 Chrome 139부터입니다. 이 줄이 없으면
  구버전 사용자는 설치는 되는데 자막이 한 줄도 안 나오고, 심사자가 구버전으로 열면 죽은 확장으로 보입니다.

나머지는 실행 파일(.pkg) 미포함, macOS 부산물(`.DS_Store`, `._*`) 미포함, 소스맵 미포함,
아이콘 4종 존재, 아이콘이 자리표시자가 아닌지, 이름이 `SideNote` 인지, 진입점 3종 존재 여부입니다.

## A-1. 개발자 등록 (한 번)

1. https://chrome.google.com/webstore/devconsole 접속 → Google 계정 로그인
2. 안내에 따라 **등록비 $5** 결제 (평생 1회, 카드 필요)
3. 개발자 이름·이메일 입력 후 저장

## A-2. 항목 만들기

1. 대시보드에서 **[새 항목]** 클릭
2. `release/sidenote-0.3.0.zip` 을 끌어다 놓기 → 업로드
3. 업로드가 성공하면 편집 화면으로 넘어갑니다

## A-3. 등록정보 채우기

`store/STORE-LISTING.md` 의 1번 항목을 순서대로 복사해 붙여 넣습니다.
스크린샷만 직접 찍어야 합니다(같은 문서에 찍는 법을 표로 정리해 뒀습니다).

## A-4. 개인정보 보호 탭 채우기

1. `store/PRIVACY.md` 내용을 공개 주소에 올립니다 (가장 빠른 방법: https://gist.github.com → 공개 Gist)
2. 그 주소를 **개인정보처리방침 URL** 칸에 넣습니다
3. `store/STORE-LISTING.md` 의 2번 항목(단일 목적, 권한별 사유, 체크박스)을 그대로 채웁니다

## A-5. 배포 설정 후 제출

1. **배포** 탭 → 공개 상태를 **일부 공개(Unlisted)** 로 선택
2. 오른쪽 위 **[검토를 위해 제출]**
3. 심사는 보통 며칠 이내입니다. 결과는 등록한 이메일로 옵니다.

## A-6. 승인 후

승인되면 스토어 주소가 생깁니다:
```
https://chromewebstore.google.com/detail/sidenote/<32자 ID>
```
실제 사용자에게서 문제가 나오지 않는 것을 확인한 뒤, 대시보드에서 공개 상태를
**일부 공개(Unlisted) → 공개(Public)** 로 바꾸고 다시 제출합니다.

---

## 사용자에게 절대 보이면 안 되는 것 (설계 원칙)

확장 ID 복사 · 터미널 · bash · npm · Homebrew · Node 설치.
사용자 경로는 **웹스토어에서 설치 → 강의 탭에서 아이콘 클릭 → [자막 시작]** 세 동작뿐이어야 합니다.
그래서 이 배포판에서는 동반 설치 프로그램과 `nativeMessaging` 을 아예 들어내고, 자막 경로를
Chrome 내장 인식 하나로 고정했습니다.

## 이 저장소에 남아 있는 다른 워크스페이스

`apps/native-host/`, `apps/stt-server/` 는 외부 인식 엔진을 실험하던 코드입니다.
**확장 빌드에도, 스토어 ZIP 에도 들어가지 않습니다**(`vite.config.ts` 진입점과 `release:chrome` 권한 검사가 둘 다 막습니다).
지금 배포와 무관하므로 배포 과정에서 건드릴 필요가 없습니다.
