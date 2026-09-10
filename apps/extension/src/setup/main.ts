/**
 * 고정확도(Whisper) 엔진 설치 안내 페이지.
 *
 * 사용자가 해야 하는 일은 두 번의 클릭뿐이다: [설치 프로그램 내려받기] -> 내려받은 pkg 두 번 클릭.
 * 터미널도, 확장 ID 복사도 없다. (확장 ID 는 설치 프로그램을 만들 때 미리 넣어 둔다.)
 */

/**
 * Chrome 은 Native Messaging 매니페스트를 시작할 때 한 번 읽는다.
 * 그래서 .pkg 를 방금 설치한 사람은 재시작 전까지 계속 "설치 안 됨" 으로 보인다. 설치 실패로 오해하기 딱 좋아 문구로 알린다.
 * (이 화면은 지금 배포판의 빌드 진입점이 아니다. 외부 엔진을 다시 살릴 때를 위해 남겨 둔다.)
 */
const ENGINE_RESTART_HINT = '설치를 방금 했다면 Chrome 을 완전히 종료했다 다시 켠 뒤 눌러 주세요.';
import { ENGINE_FALLBACK_HINT, ENGINE_PKG_FILENAME, ENGINE_PKG_UNAVAILABLE, enginePkgUrl } from '../shared/engine-dist';

// 스토어 빌드에는 설치 프로그램이 들어 있지 않다. 배포처 주소가 정해지기 전까지는 버튼을 아예 감춘다.
const PKG_URL = enginePkgUrl();

const step1 = PKG_URL
  ? `
        <h2>1. 설치 프로그램 내려받기</h2>
        <a class="primary" id="download" href="${PKG_URL}" download="${ENGINE_PKG_FILENAME}">설치 프로그램 내려받기 (.pkg)</a>
        <p class="hint">내려받기 폴더에 <code>${ENGINE_PKG_FILENAME}</code> 가 저장됩니다.</p>
        <p class="warn">Chrome 이 “이 파일 형식은 해를 끼칠 수 있습니다” 라고 물으면 <b>[유지]</b> 를 누르세요. 설치 프로그램이라 뜨는 경고입니다.</p>`
  : `
        <h2>1. 설치 프로그램 준비 중</h2>
        <p class="warn">${ENGINE_PKG_UNAVAILABLE} ${ENGINE_FALLBACK_HINT}</p>
        <p class="hint">준비가 끝나면 확장을 업데이트하는 것만으로 이 자리에 내려받기 버튼이 생깁니다.</p>`;

const root = document.getElementById('root')!;
root.innerHTML = `
  <main>
    <h1>고정확도 엔진 설치</h1>
    <p class="lead">
      <b>빠른 모드(Chrome)</b>는 설치 없이 바로 쓸 수 있습니다. 이 엔진은 <b>고정확도(Whisper)</b> 모드에서만 필요합니다.
      한 번 설치하면 그다음부터는 자막을 시작할 때 자동으로 켜지고, 종료하면 함께 꺼집니다.
    </p>

    <ol class="steps">
      <li>${step1}
      </li>
      <li>
        <h2>2. 두 번 클릭해서 설치</h2>
        <p>안내에 따라 [계속] 을 누르고, 마지막에 Mac 로그인 암호를 입력하면 끝입니다.</p>
        <p class="warn">
          “확인되지 않은 개발자” 경고가 뜨면 파일을 <b>Control 키를 누른 채 클릭</b> → <b>열기</b> 를 고르세요.
          그 메뉴가 없으면 <b>시스템 설정 → 개인정보 보호 및 보안</b> 으로 가서 아래쪽의 <b>[무시하고 열기]</b> 를 누르면 됩니다.
          (아직 Apple 서명·공증 전인 개발 빌드입니다.)
        </p>
      </li>
      <li>
        <h2>3. 사이드패널로 돌아가기</h2>
        <p>사이드패널에서 <b>고정확도 (Whisper)</b> 를 고르고 <b>[다시 확인]</b> 을 누르면 연결됩니다.</p>
        <button class="ghost" id="recheck">지금 확인해 보기</button>
        <p class="status" id="status">아직 확인하지 않았습니다.</p>
      </li>
    </ol>

    <section class="note">
      <h3>이 엔진이 하는 일</h3>
      <p>
        음성 인식은 전부 이 컴퓨터 안에서 돌아갑니다. 오디오는 인터넷으로 나가지 않고, 계정이나 결제도 없습니다.
        엔진은 자막을 켤 때만 실행되고, 끄면 함께 종료됩니다.
      </p>
      ${PKG_URL ? `
      <h3>이 개발 빌드가 필요로 하는 것</h3>
      <p>
        이 설치 프로그램은 이 컴퓨터에 이미 준비된 whisper.cpp 실행 파일과 모델, Node.js 를 가리킵니다.
        스토어 배포판에서는 이 세 가지가 설치 프로그램 안에 함께 들어갑니다.
      </p>` : ''}
    </section>
  </main>
`;

const statusEl = document.getElementById('status')!;

async function recheck() {
  statusEl.textContent = '확인 중…';
  statusEl.className = 'status';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ENGINE_STATUS' });
    if (res?.installed) {
      statusEl.textContent = '설치됐습니다. 사이드패널에서 고정확도 모드로 자막을 시작할 수 있습니다.';
      statusEl.className = 'status ok';
    } else {
      // 설치 프로그램이 없는 빌드에서는 "방금 설치했다면 Chrome 을 다시 켜라" 는 말이 성립하지 않는다.
      // 설치한 적이 없기 때문이다. 대신 지금 쓸 수 있는 방법을 알려 준다.
      statusEl.textContent = PKG_URL
        ? `${res?.message ?? '아직 설치되지 않았습니다.'} ${ENGINE_RESTART_HINT}`
        : `${res?.message ?? ENGINE_PKG_UNAVAILABLE} ${ENGINE_FALLBACK_HINT}`;
      statusEl.className = 'status bad';
    }
  } catch (err) {
    statusEl.textContent = `확인하지 못했습니다: ${String(err)}`;
    statusEl.className = 'status bad';
  }
}

document.getElementById('recheck')!.addEventListener('click', () => void recheck());
void recheck();
