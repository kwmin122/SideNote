# SideNote (구 Chrome Study Sidepanel) — 구현 명세서

> 목표: **웹에서 강의/영상을 재생하면 Chrome 오른쪽 사이드패널에 라이브 자막이 누적되고, 중요한 순간을 캡처해 메모와 함께 저장할 수 있는 Chrome 확장 프로그램**을 구현한다.  
> 이번 버전은 **AI 질문/요약/챗봇 기능을 넣지 않는다.**

---

## 0. 구현 원칙

### 코딩 규칙

코드를 작성하기 전에 기존 아키텍처와 데이터 흐름을 먼저 파악한다.

기존 코드와 가장 가까운 패턴을 찾아 그 구조를 따른다.  
불필요하게 새로운 추상화나 프레임워크를 만들지 않는다.

각 모듈은 하나의 명확한 책임만 가진다.  
비즈니스 로직, 데이터 접근, 외부 API, 설정, side effect를 가능한 한 분리한다.

새 기능은 구현 전에 입력/출력/오류 계약을 정의한다.  
핵심 데이터는 명확한 타입으로 표현하고 `Any`/무분별한 `dict` 사용을 피한다.

독립적인 I/O 작업은 병렬화하고,  
데이터 의존성이 있는 작업은 명시적으로 순차 실행한다.

오류를 catch하고 무시하지 않는다.  
오류에는 실패한 컴포넌트와 작업의 맥락을 포함한다.  
실패 시 전체 요청을 실패시킬지 graceful degradation 할지 명시적으로 결정한다.

magic number와 기능 활성화 여부를 로직에 하드코딩하지 말고 config/parameter/feature flag로 분리한다.

외부 API, DB, 모델 등의 dependency는 교체 및 mocking 가능하게 설계한다.

중요한 로직에는 정상 경로뿐 아니라 다음을 검증하는 테스트를 작성한다.

- 빈 입력
- 경계값
- 잘못된 입력
- dependency failure
- 기존 데이터 호환성
- 중복 실행
- 재시도
- 사용자 중단
- 탭 종료
- 권한 거부

테스트 이름은 무엇을 검증하는지 문장처럼 명확하게 작성한다.

주석은 코드가 무엇을 하는지 반복하지 말고 **왜 이런 구현이나 제약이 필요한지** 설명한다.

변경은 요청된 범위에서 최소화한다.  
관련 없는 refactoring을 함께 수행하지 않는다.

작업 완료 후 반드시 아래를 보고한다.

1. 변경 파일
2. 변경 이유
3. 테스트 결과
4. 남은 위험

---

# 1. 제품 목표

## 한 줄 정의

**강의 영상을 틀어놓으면 오른쪽에 실시간 자막이 쌓이고, 중요한 화면을 버튼 한 번으로 캡처한 뒤 바로 메모할 수 있는 Chrome 확장 프로그램.**

## 핵심 사용 시나리오

1. 사용자가 대학 LMS, 온라인 강의 사이트, 일반 웹사이트에서 영상을 재생한다.
2. Chrome 확장 프로그램을 눌러 SideNote를 연다.
3. `라이브 자막 시작` 버튼을 누른다.
4. 현재 탭의 오디오가 캡처된다.
5. 음성이 STT로 변환되어 사이드패널에 실시간으로 누적된다.
6. 사용자는 중요한 설명을 복사할 수 있다.
7. 중요한 화면이 나오면 `캡처` 버튼을 누른다.
8. 현재 영상/화면이 이미지로 저장된다.
9. 캡처 바로 아래 메모장에 필기한다.
10. 자막, 캡처, 메모가 현재 강의 세션에 함께 저장된다.
11. 나중에 해당 강의를 다시 열어 기록을 볼 수 있다.

---

# 2. 이번 버전 범위

## 반드시 구현

### A. Chrome Side Panel
- Chrome 우측 사이드패널에서 실행
- 현재 탭과 연결된 학습 세션 표시
- 영상 페이지를 가리지 않고 동시에 사용 가능

### B. 라이브 자막
- 현재 탭 오디오 캡처
- 오디오를 실시간 스트림으로 STT Gateway에 전달
- Streaming STT의 `PARTIAL` 결과를 즉시 화면에 표시
- 문장이 확정되면 `FINAL` 결과로 교체 및 저장
- 선택적으로 강의 문맥/전문용어 보정 레이어 적용
- 자막을 시간순으로 사이드패널에 누적
- 각 자막 문장/블록에 시간 표시
- 자막 복사 가능
- 자동 스크롤
- 사용자가 위로 스크롤하면 자동 스크롤 일시 정지
- `자막 시작 / 일시정지 / 종료` 상태 제공

### C. 화면 캡처
- `캡처` 버튼 클릭 시 현재 화면 캡처
- 가능하면 현재 `<video>` 영역만 잘라 저장
- 영상 영역을 찾지 못하면 현재 탭 viewport 전체를 캡처
- 캡처 시각과 영상 `currentTime`을 함께 저장
- 캡처 이미지 미리보기
- 캡처 삭제 가능

### D. 메모
- 일반 강의 메모장
- 각 캡처별 메모
- 자동 저장
- 새로고침 후 복원
- 자막 텍스트를 선택/복사하여 메모에 붙여넣기 가능

### E. 강의 세션 저장
- 사이트 URL
- 페이지 제목
- 시작 시간
- 마지막 접근 시간
- 자막
- 캡처
- 메모
- 영상 시간 정보
- 로컬 저장

---

# 3. 이번 버전에서 하지 않는 것

아래 기능은 **구현하지 않는다.**

- AI 질문
- AI 요약
- AI 노트 생성
- 시험문제 생성
- 챗봇
- RAG
- 임베딩
- 사용자 계정
- Google 로그인
- 클라우드 동기화
- 결제/구독
- 팀 공유
- OCR
- 이미지 분석
- 자동 번역
- 모바일 지원

단, 향후 추가할 수 있도록 인터페이스를 과도하지 않은 수준에서 분리한다.

---

# 4. 권장 기술 스택

## Extension
- Chrome Extension Manifest V3
- TypeScript
- React
- Vite
- Chrome Side Panel API
- `chrome.tabCapture`
- `chrome.tabs.captureVisibleTab`
- Content Script
- Service Worker
- Offscreen Document 필요 시 사용

## 로컬 저장
- IndexedDB
- 래퍼 사용 시 Dexie 권장
- `chrome.storage.local`은 작은 설정값에만 사용

## STT Gateway
- Node.js + TypeScript
- Fastify 또는 Express
- WebSocket 권장
- STT provider는 interface로 분리

## STT Provider
초기 구현은 **Streaming STT**를 기본으로 한다.

```ts
interface StreamingSpeechToTextProvider {
  open(context: TranscriptContext): Promise<StreamingSTTSession>;
}

interface StreamingSTTSession {
  sendAudio(frame: AudioFrame): Promise<void>;
  onTranscript(handler: (result: TranscriptResult) => void): () => void;
  close(): Promise<void>;
}
```

Provider가 streaming을 지원하지 않는 경우에만 내부 adapter에서 chunk 기반 API로 변환한다.

실제 provider는 환경변수로 교체 가능해야 한다.

예:

```env
STT_PROVIDER=openai
OPENAI_API_KEY=...
```

API Key는 **절대 Chrome Extension 코드에 넣지 않는다.**

---

# 5. 전체 구조

```text
┌──────────────────────── Browser Tab ────────────────────────┐
│                                                             │
│  LMS / Udemy / Coursera / 일반 웹 영상                     │
│                                                             │
│  <video> 또는 기타 플레이어                                 │
│                                                             │
└───────────────┬───────────────────────┬─────────────────────┘
                │                       │
        audio capture             DOM / video info
                │                       │
                ▼                       ▼
        Extension Runtime        Content Script
                │                       │
                └───────────┬───────────┘
                            ▼
                   Background / Offscreen
                            │
                     WebSocket / HTTP
                            ▼
                       STT Gateway
                            │
                            ▼
                      STT Provider
                            │
                            ▼
                      TranscriptResult
                            │
                            ▼
                    Chrome Side Panel
                            │
               ┌────────────┴────────────┐
               ▼                         ▼
          Live Transcript           Capture + Memo
               │                         │
               └────────────┬────────────┘
                            ▼
                         IndexedDB
```

---

# 6. 업무 흐름 정의

## Flow 1. 앱 시작

```text
확장프로그램 클릭
→ Side Panel Open
→ 현재 active tab 조회
→ 기존 Session 검색
→ 있으면 복원
→ 없으면 새 Session 생성
→ READY 상태
```

## Flow 2. 라이브 자막 시작

```text
사용자 "자막 시작"
→ 탭 오디오 권한 확인
→ capture 시작
→ audio stream 생성
→ STT gateway WebSocket 연결
→ 오디오 frame/PCM 지속 전송
→ PARTIAL transcript 수신 즉시 화면 반영
→ FINAL transcript 수신
→ 선택적 강의 문맥 보정
→ final transcript 저장
```

## Flow 3. 일시정지

```text
사용자 "일시정지"
→ 새 audio chunk 생성 중지
→ 현재 처리 중 요청은 완료 허용
→ PAUSED 상태
→ 기존 transcript 유지
```

## Flow 4. 자막 종료

```text
사용자 "종료"
→ capture 종료
→ 남은 audio buffer flush
→ STT 결과 반영
→ WebSocket 종료
→ STOPPED 상태
```

## Flow 5. 캡처

```text
사용자 "캡처"
→ 현재 탭 확인
→ content script에서 video 영역/현재시간 조회
→ captureVisibleTab
→ video 영역 있으면 crop
→ 없으면 viewport 그대로 사용
→ Capture 생성
→ IndexedDB 저장
→ Side Panel에 즉시 표시
```

## Flow 6. 메모

```text
사용자 입력
→ local state 즉시 반영
→ debounce
→ IndexedDB 저장
→ 저장 상태 표시
```

---

# 7. 상태 정의

상태를 암묵적으로 처리하지 말고 명시적으로 정의한다.

## SessionStatus

```ts
type SessionStatus =
  | "READY"
  | "CAPTURING"
  | "PAUSED"
  | "STOPPED"
  | "ERROR";
```

### READY
- 세션은 열려 있음
- 오디오 캡처 안 함

### CAPTURING
- 현재 탭 오디오 수집 중
- STT 결과 수신 가능

### PAUSED
- 세션은 유지
- 신규 오디오 수집 중지

### STOPPED
- 자막 세션 종료
- 기존 데이터 열람 가능

### ERROR
- 캡처/STT 등 핵심 작업 실패
- 오류 원인과 재시도 UI 제공

---

## STTConnectionStatus

```ts
type STTConnectionStatus =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "FAILED";
```

---

## SaveStatus

```ts
type SaveStatus =
  | "IDLE"
  | "SAVING"
  | "SAVED"
  | "FAILED";
```

---

# 8. 핵심 데이터 정의

## StudySession

```ts
interface StudySession {
  id: string;
  tabOrigin: string;
  pageUrl: string;
  pageTitle: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  generalMemo: string;
}
```

---

## TranscriptSegment

```ts
interface TranscriptSegment {
  id: string;
  sessionId: string;

  sequence: number;

  text: string;

  startedAtMs: number;
  endedAtMs: number;

  videoTimeSec?: number;

  createdAt: number;

  status: "PARTIAL" | "FINAL";
}
```

### 규칙
- DB 영구 저장은 원칙적으로 `FINAL` 위주
- partial은 UI 표시용
- final이 도착하면 동일 segment의 partial 대체
- sequence 순서를 보장

---

## Capture

```ts
interface Capture {
  id: string;
  sessionId: string;

  imageBlobId: string;

  captureType: "VIDEO_REGION" | "VIEWPORT";

  videoTimeSec?: number;

  pageUrl: string;
  createdAt: number;

  memo: string;
}
```

---

## AudioChunk

```ts
interface AudioChunk {
  id: string;
  sessionId: string;

  sequence: number;

  mimeType: string;

  startedAtMs: number;
  endedAtMs: number;

  blob: Blob;
}
```

---

## TranscriptResult

```ts
interface TranscriptResult {
  chunkId: string;
  sequence: number;

  text: string;

  isFinal: boolean;

  language?: string;

  startedAtMs?: number;
  endedAtMs?: number;
}
```

---

# 9. 정보 구조 설계

사이드패널은 기능을 과도하게 나누지 않는다.

```text
SideNote
│
├─ Header
│  ├─ 현재 페이지 제목
│  ├─ 연결 상태
│  └─ 설정
│
├─ Control Bar
│  ├─ 자막 시작 / 일시정지 / 재개
│  ├─ 종료
│  └─ 캡처
│
├─ Tabs
│  ├─ 자막
│  └─ 노트
│
├─ 자막 Tab
│  └─ Transcript Timeline
│
└─ 노트 Tab
   ├─ 일반 메모
   └─ Capture Notes
```

---

# 10. 화면별 핵심 목표

## 10.1 Sidepanel — READY

### 목표
사용자가 무엇을 해야 하는지 3초 안에 이해.

### 표시
- 현재 강의 제목
- `라이브 자막 시작`
- `캡처`
- 일반 메모장

### 빈 상태 문구
`라이브 자막을 시작하면 현재 탭의 음성이 여기에 표시됩니다.`

---

## 10.2 CAPTURING

### 목표
자막이 정상적으로 수집되고 있음을 명확하게 보여줌.

### 표시
- LIVE indicator
- 자막 누적
- `일시정지`
- `종료`
- `캡처`

### 각 자막
```text
12:43
The CPU accesses off-chip memory...
[복사]
```

영상 시간이 확인되지 않으면 wall-clock 기준 표시 가능.

---

## 10.3 PAUSED

### 목표
사용자가 데이터가 사라졌다고 오해하지 않도록 함.

### 표시
- `일시정지됨`
- 기존 자막 유지
- `계속하기`
- `종료`

---

## 10.4 ERROR

### 목표
오류 이유와 다음 행동을 명확하게 제공.

예:

```text
현재 탭의 오디오를 캡처할 수 없습니다.
[다시 시도]

가능한 원인
- Chrome 권한이 거부됨
- 현재 탭이 지원되지 않음
```

stack trace를 사용자에게 노출하지 않는다.

---

# 11. 캡처 설계

## 우선순위

### 1순위
현재 페이지에서 실제 재생 중인 `<video>` element 감지.

선정 조건 예:
- `paused === false`
- viewport와 교차
- visible
- 크기 일정 이상

영상이 여러 개면:
1. 재생 중
2. 화면 면적 가장 큰 영상
순서로 선택.

### 2순위
적합한 video element를 못 찾으면 viewport 전체 캡처.

---

## 캡처 처리

`chrome.tabs.captureVisibleTab()`은 전체 viewport를 반환하므로:

1. content script에서 video bounding rect 조회
2. devicePixelRatio 조회
3. screenshot 생성
4. 좌표를 pixel 단위로 변환
5. Canvas/OffscreenCanvas로 crop
6. Blob 저장

좌표 오차 가능성을 테스트한다.

---

# 12. 메모 설계

## 일반 메모
강의 전체에 대한 자유 메모.

## 캡처 메모
각 Capture에 종속.

## 저장 정책

- 입력 즉시 UI state 반영
- `500~1000ms` debounce 후 DB 저장
- debounce 값은 config로 관리
- 창 닫기 직전 가능한 경우 flush

UI:

```text
저장 중...
저장됨
저장 실패 [다시 시도]
```

사용자가 저장 성공 여부를 알 수 있어야 한다.

---

# 13. 라이브 자막 설계

## 오디오 캡처

Chrome tab audio를 얻는다.

권장:
- `chrome.tabCapture`
- 필요 시 service worker + offscreen document

Manifest V3에서는 service worker lifecycle을 고려해야 한다.

---

## Streaming 정책

파일 단위 업로드를 기본으로 하지 않는다. 브라우저에서 얻은 오디오를 WebSocket 세션에 연속 전송하고, STT Provider가 제공하는 partial/final 이벤트를 사용한다.

config 예:

```ts
interface AudioConfig {
  frameDurationMs: number;
  maxBufferedFrames: number;
  reconnectBackoffMs: number[];
}
```

초기값 예:
- frame: 100~250ms
- buffer: 네트워크 순간 단절을 견딜 수 있는 제한된 크기
- reconnect: 1000 / 2000 / 5000ms

Provider가 streaming 입력을 지원하지 않을 때만 compatibility adapter 내부에서 짧은 chunk 방식으로 변환한다. 값은 config에 두고 로직에 직접 박지 않는다.

---

## 순서 보장

STT 요청이 병렬 처리되어 결과가 뒤섞일 수 있다.

따라서:
- 각 chunk에 `sequence`
- 각 transcript에도 `sequence`
- 화면 출력은 sequence 기준 정렬

독립적인 upload/STT는 제한된 병렬 처리가 가능하지만,
최종 transcript 조립 순서는 보장한다.

---

# 13.1 강의 문맥 보정 레이어

STT 결과를 그대로 저장하기 전에 선택적으로 `TranscriptEnhancer`를 거칠 수 있다.

목표:
- 한국어/영어 혼합 강의의 전문용어 표기 보정
- `CPU`, `MMU`, `Transformer` 같은 용어 복원
- 문장부호 및 문장 경계 보정
- 의미를 바꾸는 요약이나 임의 내용 추가 금지

```ts
interface TranscriptEnhancer {
  enhance(input: FinalTranscript, context: LectureContext): Promise<FinalTranscript>;
}
```

원칙:
- PARTIAL에는 무거운 보정을 적용하지 않는다.
- FINAL에만 비동기 보정을 적용한다.
- 보정 실패 시 원본 FINAL을 그대로 저장/표시한다.
- 원문과 보정본을 구분 가능하게 보존할 수 있다.
- 초기 MVP에서는 feature flag로 끌 수 있어야 한다.

---

# 14. STT API 명세

## 연결

권장: WebSocket

```text
WS /v1/transcription
```

### Client → Server: session.init

```json
{
  "type": "session.init",
  "sessionId": "uuid",
  "language": "auto"
}
```

### Server → Client

```json
{
  "type": "session.ready",
  "sessionId": "uuid"
}
```

---

### Client → Server: audio.chunk

binary 또는 metadata + binary frame 사용.

metadata:

```json
{
  "type": "audio.chunk",
  "chunkId": "uuid",
  "sequence": 17,
  "startedAtMs": 12345,
  "endedAtMs": 15345,
  "mimeType": "audio/webm"
}
```

---

### Server → Client: transcript

```json
{
  "type": "transcript",
  "chunkId": "uuid",
  "sequence": 17,
  "text": "The operating system manages memory.",
  "isFinal": true
}
```

---

### Server → Client: error

```json
{
  "type": "error",
  "code": "STT_PROVIDER_FAILED",
  "message": "Speech recognition temporarily failed.",
  "retryable": true
}
```

---

# 15. API 오류 계약

오류 코드를 문자열로 통일한다.

```ts
type ErrorCode =
  | "TAB_NOT_FOUND"
  | "TAB_CAPTURE_PERMISSION_DENIED"
  | "TAB_CAPTURE_FAILED"
  | "VIDEO_ELEMENT_NOT_FOUND"
  | "SCREENSHOT_FAILED"
  | "IMAGE_CROP_FAILED"
  | "STORAGE_WRITE_FAILED"
  | "STORAGE_READ_FAILED"
  | "STT_CONNECTION_FAILED"
  | "STT_PROVIDER_FAILED"
  | "STT_RATE_LIMITED"
  | "STT_AUTH_FAILED"
  | "NETWORK_OFFLINE"
  | "UNKNOWN";
```

오류 객체:

```ts
interface AppError {
  code: ErrorCode;
  component: string;
  operation: string;
  message: string;
  retryable: boolean;
  cause?: unknown;
}
```

---

# 16. I/F 명세

## Sidepanel ↔ Service Worker

message contract를 타입으로 정의한다.

예:

```ts
type ExtensionMessage =
  | { type: "CAPTION_START"; tabId: number }
  | { type: "CAPTION_PAUSE"; sessionId: string }
  | { type: "CAPTION_RESUME"; sessionId: string }
  | { type: "CAPTION_STOP"; sessionId: string }
  | { type: "CAPTURE_REQUEST"; tabId: number }
  | { type: "SESSION_GET"; tabId: number };
```

응답도 discriminated union 사용.

---

## Service Worker ↔ Content Script

```ts
type ContentMessage =
  | { type: "GET_VIDEO_STATE" }
  | { type: "GET_VIDEO_RECT" }
  | { type: "SEEK_VIDEO"; timeSec: number };
```

초기 MVP에서는 SEEK 기능은 구현하지 않아도 되지만,
영상 현재시간 조회 구조는 분리한다.

---

# 17. IndexedDB 설계

Store:

```text
sessions
transcripts
captures
imageBlobs
```

## Index

### sessions
- `id`
- `pageUrl`
- `updatedAt`

### transcripts
- `id`
- `[sessionId+sequence]`
- `sessionId`

### captures
- `id`
- `[sessionId+createdAt]`

### imageBlobs
- `id`

이미지 base64 문자열을 session 객체 안에 직접 쌓지 않는다.

---

# 18. 사용자/권한 관리

이번 버전은 로그인 없음.

## Chrome permissions
필요한 최소 권한만 요청.

예상:
- `sidePanel`
- `activeTab`
- `tabCapture`
- `storage`
- `scripting`

모든 사이트 접근 권한(`<all_urls>`)은 정말 필요한지 검토한다.

가능하면 사용자가 기능을 실행한 탭에서만 동작하도록 제한.

---

# 19. 개인정보/보안 원칙

- 사용자의 영상/오디오를 불필요하게 영구 서버 저장하지 않는다.
- STT용 audio chunk는 처리 완료 후 서버에서 폐기.
- 서버 로그에 원문 audio binary 기록 금지.
- extension에 STT API secret 저장 금지.
- production에서는 HTTPS/WSS만 허용.
- 메모/캡처는 기본적으로 로컬 저장.
- 디버그 로그에도 transcript 전체를 무조건 출력하지 않는다.
- 민감 사이트에서 사용될 수 있으므로 개인정보 입력 가능성을 전제로 한다.

---

# 20. 안정성 대비

필수 체크 항목을 구현에서 빠뜨리지 않는다.

## 20.1 사용자/권한
- 오디오 캡처 권한 거부
- 현재 탭 변경
- 탭 종료
- Side Panel 닫힘
- Chrome 재시작
- 확장 프로그램 업데이트

## 20.2 API 변경
STT provider 응답을 UI에 직접 전달하지 않는다.

```text
Provider Response
→ Adapter
→ TranscriptResult
→ Application
```

provider가 바뀌어도 UI/DB 타입은 유지.

---

## 20.3 인증 만료
STT backend API credential 만료/invalid 시:

- `STT_AUTH_FAILED`
- 자동 무한 재시도 금지
- UI에서 자막 중단 이유 표시
- 기존 캡처/메모는 정상 사용 가능

즉 **STT가 죽어도 메모와 캡처까지 죽이지 않는다.**

---

## 20.4 데이터 오류
DB record parse 실패 시:
- 해당 record만 격리
- 전체 앱 crash 금지
- schema version 관리
- migration 실패 로그 남김

---

## 20.5 중복 실행

사용자가 `자막 시작` 버튼을 연속으로 눌러도 capture stream이 2개 만들어지면 안 된다.

세션 단위 mutex/state guard 필요.

```text
READY → START 가능
CAPTURING → START 무시
PAUSED → RESUME
STOPPED → 새 session 또는 명시적 restart
```

---

## 20.6 Rate Limit

STT provider가 429를 반환하면:

- `STT_RATE_LIMITED`
- exponential backoff
- 무한 재시도 금지
- buffer 최대 크기 제한
- buffer 초과 시 오래된 audio를 조용히 버리지 말고 사용자에게 일부 자막 누락 표시

---

## 20.7 실행 실패

### STT 실패
- 캡처/메모 유지
- 자막만 ERROR

### 캡처 실패
- 자막/메모 유지
- 캡처에만 오류 표시

### DB 저장 실패
- 화면 입력값 즉시 삭제 금지
- 메모리를 유지하고 retry 가능

즉 기능별 graceful degradation.

---

## 20.8 네트워크 끊김

```text
CONNECTED
→ network loss
→ RECONNECTING
→ backoff
→ reconnect 성공
→ buffered chunk 전송
```

단 buffer limit 초과 시 사용자에게 누락 가능성을 알린다.

---

# 21. 배치 명세

이번 MVP에는 정기 배치 작업이 거의 필요 없다.

다만 로컬 데이터 정리를 위해 선택적으로 다음을 구현할 수 있다.

## Cleanup

조건:
- orphan imageBlob
- session 삭제 후 남은 transcript/capture

실행 시점:
- extension startup 후 idle
- session 삭제 직후

주의:
주기적 background timer에 의존하지 않는다.
Manifest V3 service worker는 항상 살아있지 않다.

---

# 22. 설정 정의

예:

```ts
interface AppConfig {
  audioFrameDurationMs: number;
  maxBufferedFrames: number;

  memoSaveDebounceMs: number;

  sttReconnectBackoffMs: number[];

  maxTranscriptSegmentsInMemory: number;

  featureFlags: {
    cropVideoRegion: boolean;
    savePartialTranscript: boolean;
    transcriptEnhancer: boolean;
  };
}
```

환경별 config를 분리한다.

```text
development
test
production
```

---

# 23. Feature Flag

이번 버전에서도 위험한 기능은 flag로 끌 수 있어야 한다.

예:
- `cropVideoRegion`
- `savePartialTranscript`
- `transcriptEnhancer`

향후:
- `translation`
- `cloudSync`
- `aiStudy`

하지만 미래 기능 때문에 현재 구조를 과도하게 추상화하지 않는다.

---

# 24. UX 세부 규칙

## 자막
- 최신 자막은 아래에 추가
- 사용자 스크롤이 최하단 근처일 때만 자동 스크롤
- 선택 가능한 일반 텍스트
- 복사 버튼 제공
- 너무 긴 transcript는 virtualization 고려

## 캡처
- 저장 즉시 썸네일 표시
- 클릭하면 크게 보기
- 삭제 전 확인
- 캡처 실패 시 메모장까지 막지 않음

## 메모
- 자동 저장
- 수동 저장 버튼에 의존하지 않음
- `저장됨` 상태 표시
- plain text부터 시작
- 초기 버전에 복잡한 rich text editor 넣지 않는다

---

# 25. 접근성

- 주요 버튼 keyboard focus 가능
- icon-only 버튼에 aria-label
- 상태를 색상 하나로만 표현하지 않음
- LIVE / PAUSED / ERROR 텍스트 병행
- 최소 클릭 영역 확보

---

# 26. 성능 기준

초기 목표:

- Side Panel open: 체감 지연 없이 표시
- 캡처 버튼 → preview: 가능한 한 1초 내
- 메모 입력: 입력 지연 없어야 함
- 라이브 자막: STT provider 포함 목표 지연 2~5초
- transcript 1,000개 이상에서도 UI freeze 없어야 함

성능 목표는 테스트 환경과 provider에 따라 측정하여 보고.

---

# 27. 테스트 계획

## Unit Test

### 상태
- READY에서 START하면 CAPTURING이 된다
- CAPTURING에서 START를 다시 호출해도 중복 stream이 생기지 않는다
- PAUSED에서 RESUME하면 CAPTURING으로 복귀한다
- ERROR 이후 retry 가능한 오류만 재시도한다

### Transcript
- sequence가 뒤섞여 도착해도 화면 순서는 올바르다
- 빈 transcript는 저장하지 않는다
- partial 이후 final이 올바르게 대체된다

### Memo
- debounce 후 저장된다
- 저장 실패 시 사용자 입력이 사라지지 않는다

### Capture
- video rect가 있으면 crop한다
- video rect가 없으면 viewport capture로 fallback
- 잘못된 rect에서 전체 앱이 crash하지 않는다

---

## Integration Test

- tab capture → audio chunk 생성
- mocked STT → transcript UI 표시
- captureVisibleTab → IndexedDB 저장
- Side Panel reopen → session 복원
- network disconnect → reconnect
- provider 429 → backoff
- DB write failure → retry UI

---

## Manual Test

최소 아래 환경에서 직접 확인:

1. YouTube
2. HTML5 video 샘플 페이지
3. 대학 LMS 한 곳
4. iframe 내부 플레이어 한 곳
5. 영상 없는 일반 페이지
6. 여러 영상이 동시에 있는 페이지
7. 전체화면 영상
8. 탭 mute
9. 탭 전환
10. 탭 종료

특정 DRM 플레이어는 제한이 있을 수 있으며 실패 시 지원 불가 상태를 명확히 표시.

---

# 28. 브라우저 제한/위험

## DRM
일부 DRM 영상은 video frame 직접 접근이 제한될 수 있다.

대응:
- 탭 화면 캡처 fallback
- 지원 불가능한 경우 명시

## iframe
cross-origin iframe 내부 video DOM에 접근 못할 수 있다.

대응:
- 영상 영역 crop 실패 시 viewport capture

## Manifest V3 Service Worker
background가 언제든 suspend될 수 있음.

대응:
- 장기 media 처리 로직을 service worker 하나에만 의존하지 않는다.
- 필요하면 offscreen document 사용.
- 상태는 IndexedDB/storage에 보존.

---

# 29. 폴더 구조 예시

기존 프로젝트가 없다면 다음 정도로 시작한다.

```text
/
├─ apps/
│  ├─ extension/
│  │  ├─ src/
│  │  │  ├─ background/
│  │  │  ├─ content/
│  │  │  ├─ offscreen/
│  │  │  ├─ sidepanel/
│  │  │  ├─ storage/
│  │  │  ├─ capture/
│  │  │  ├─ transcription/
│  │  │  ├─ shared/
│  │  │  └─ config/
│  │  └─ manifest.json
│  │
│  └─ stt-server/
│     └─ src/
│        ├─ routes/
│        ├─ providers/
│        ├─ domain/
│        ├─ config/
│        └─ errors/
│
├─ packages/
│  └─ contracts/
│
└─ README.md
```

단, 기존 코드베이스가 있다면 **이 구조를 강제로 적용하지 말고 기존 구조를 따른다.**

---

# 30. 구현 순서

한 번에 구현하더라도 내부 작업 순서는 아래대로 한다.

## Step 1
기존 코드/환경 파악

## Step 2
Manifest V3 + Side Panel 최소 실행

## Step 3
Session/IndexedDB 데이터 계층

## Step 4
메모 자동 저장

## Step 5
화면 캡처

## Step 6
video element 감지 + crop

## Step 7
tab audio capture

## Step 8
Streaming STT gateway + provider adapter

## Step 9
PARTIAL/FINAL live transcript UI

## Step 9.5
선택적 강의 문맥/전문용어 보정 레이어

## Step 10
오류/재연결/중복실행 방지

## Step 11
테스트

## Step 12
README + 실행 방법 + 결과 보고

---

# 31. 완료 조건 Definition of Done

아래가 모두 만족되어야 완료다.

### Side Panel
- [ ] 확장 프로그램 버튼으로 Side Panel을 열 수 있다.
- [ ] 현재 탭 제목이 보인다.

### Live Caption
- [ ] 사용자가 자막을 시작할 수 있다.
- [ ] 현재 탭 음성이 STT로 전달된다.
- [ ] 자막이 오른쪽 패널에 시간순으로 누적된다.
- [ ] 자막 텍스트 선택/복사가 가능하다.
- [ ] pause/resume/stop이 정상 동작한다.
- [ ] 중복 start로 capture가 중복 생성되지 않는다.

### Capture
- [ ] 캡처 버튼으로 현재 화면을 저장할 수 있다.
- [ ] video 영역을 찾으면 영상 중심 crop을 시도한다.
- [ ] 실패하면 viewport 캡처로 fallback한다.
- [ ] 캡처에 시간 정보가 저장된다.
- [ ] 캡처를 삭제할 수 있다.

### Memo
- [ ] 일반 메모를 작성할 수 있다.
- [ ] 캡처별 메모를 작성할 수 있다.
- [ ] 자동 저장된다.
- [ ] 새로고침 후 복원된다.

### Stability
- [ ] STT가 실패해도 메모/캡처는 계속 사용 가능하다.
- [ ] 캡처가 실패해도 자막/메모는 계속 사용 가능하다.
- [ ] network failure/reconnect 처리가 있다.
- [ ] rate limit 처리가 있다.
- [ ] permission denied 처리가 있다.
- [ ] tab close 처리가 있다.
- [ ] storage failure 처리가 있다.

### Test
- [ ] 핵심 상태 전이 unit test
- [ ] transcript 순서 test
- [ ] memo persistence test
- [ ] capture fallback test
- [ ] STT failure test
- [ ] duplicate execution test

---

# 32. 구현자에게 주는 최종 지시

이 문서를 기준으로 **실제로 실행 가능한 MVP를 끝까지 구현한다.**

중간에 TODO, pseudo-code, placeholder만 남기고 완료했다고 하지 않는다.

외부 서비스의 credential이 없어 실행할 수 없는 부분은:
1. 실제 adapter를 구현하고
2. mock provider도 제공하며
3. `.env.example`에 필요한 변수를 명확히 작성하고
4. credential을 넣으면 실제 동작하도록 만든다.

핵심 기능 하나가 실패했다고 전체 앱을 막지 않는다.

- STT 실패 → 캡처/메모 가능
- 캡처 실패 → 자막/메모 가능
- 저장 실패 → 입력값 즉시 삭제 금지

기존 코드가 있다면 먼저 분석한 뒤 최소 변경한다.

임의로 AI, 로그인, 결제, 번역, 클라우드 기능을 추가하지 않는다.

UI는 화려함보다 **강의를 보면서 즉시 사용할 수 있는 밀도 높은 사이드패널 UX**를 우선한다.

---

# 33. 작업 완료 보고 형식

최종 응답은 반드시 아래 순서로 작성한다.

## 1. 구현 결과
실제로 동작하는 기능을 간단히 설명.

## 2. 변경 파일
파일별 변경 내용.

## 3. 데이터 흐름
최종 구현된 실제 흐름.

## 4. 테스트 결과
실행한 명령과 통과/실패 개수.

## 5. 실행 방법
개발자가 그대로 따라 할 수 있게 작성.

## 6. 남은 위험
- Chrome API 제약
- DRM/iframe
- STT provider
- latency
- 비용
등 실제 남은 것만 작성.

## 7. 범위 외
이번 작업에서 의도적으로 구현하지 않은 것 명시.

---

# 34. 핵심 철학

이 프로젝트의 첫 버전은 AI 제품이 아니다.

핵심은 아래 세 가지다.

> **듣기 → 실시간 자막으로 남기기**  
> **보기 → 캡처로 남기기**  
> **생각 → 메모로 남기기**

사용자가 강의 영상을 멈추거나 다른 앱으로 이동하지 않고  
**한 화면 안에서 강의를 보고, 자막을 복사하고, 중요한 장면을 캡처하고, 바로 필기할 수 있게 만드는 것**이 이번 MVP의 목표다.

---

# 35. 2026-09 구현 결정 — 로컬 Whisper MVP

초기 실제 구현의 기본 STT provider는 **로컬 `whisper.cpp` + multilingual Whisper `small` 모델**로 한다.

선택 이유:
- API 키와 사용량 과금 없이 로컬에서 실행 가능
- 한국어/영어 혼용 강의에 사용할 수 있는 multilingual 모델
- macOS/Apple Silicon을 포함한 로컬 실행 경로가 성숙함
- `whisper.cpp` provider를 별도 adapter로 두어 향후 true streaming ASR 또는 cloud provider로 교체 가능

## 실제 데이터 흐름

```text
Chrome tabCapture
→ Offscreen Document
→ Web Audio PCM16
→ ws://127.0.0.1:8787/v1/transcription
→ Local STT Gateway
→ whisper.cpp / ggml-small.bin
→ TranscriptResult
→ Chrome Side Panel
→ IndexedDB
```

## 구현 정책

Whisper 원 모델은 native true-streaming ASR가 아니므로 MVP에서는 짧은 PCM window를 연속으로 처리해 near-real-time 자막을 만든다.

초기값:
- STT window: 3000ms
- language: auto
- model: `small`
- 단순 RMS 기반 silence gate 적용

추후 정확도/지연 개선:
1. overlap + transcript dedup
2. VAD 고도화
3. 강의 제목/과목 기반 initial prompt 또는 context 보정
4. true streaming ASR provider 추가
5. `large-v3-turbo` 정확도 모드 선택지

## 로컬 설치

```bash
./scripts/setup-whisper.sh small
npm install
npm run dev:server
npm run build -w @study/extension
```

설치 스크립트가 `whisper.cpp` 소스 clone, native build, ggml 모델 다운로드를 담당한다.

## 현재 구현 완료 범위

- Manifest V3 / Side Panel
- 탭 오디오 캡처
- 캡처 중에도 사용자에게 탭 오디오 재생 유지
- PCM16 WebSocket 전송
- 로컬 whisper.cpp adapter
- silence gate
- 시작 / 일시정지 / 재개 / 종료
- transcript 시간순 표시/복사
- transcript IndexedDB 저장
- 일반 강의 메모 저장
- viewport 캡처
- 재생 중 video element 탐색 및 가능할 경우 video 영역 crop
- 캡처별 메모/삭제
- 영상 currentTime 캡처 기록
- 로컬 STT health endpoint
- whisper.cpp + 모델 자동 설치 스크립트

## 남은 외부 의존성

실행 머신에서 다음 설치/다운로드가 필요하다.
- Node.js/npm dependencies
- CMake/build toolchain
- `whisper.cpp`
- ggml Whisper model

모델과 `whisper.cpp`는 저장소에 대용량 binary를 직접 commit하지 않고 설치 스크립트로 가져온다.
