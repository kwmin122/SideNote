import { describe, expect, it } from 'vitest';
import { NATIVE_HOST_SLOW, WhisperHost } from '../src/background/native';
import { engineMissingMessage } from '../src/shared/engine-dist';

/** chrome.runtime.connectNative 가 주는 포트 대역. */
class FakePort {
  messages: unknown[] = [];
  disconnected = 0;
  private onMsg: ((message: any) => void)[] = [];
  private onDis: (() => void)[] = [];

  onMessage = { addListener: (cb: (message: any) => void) => this.onMsg.push(cb) };
  onDisconnect = { addListener: (cb: () => void) => this.onDis.push(cb) };

  postMessage(message: unknown) {
    this.messages.push(message);
  }

  disconnect() {
    this.disconnected += 1;
  }

  emit(message: any) {
    this.onMsg.forEach((cb) => cb(message));
  }

  drop() {
    this.onDis.forEach((cb) => cb());
  }
}

function hostWith(port: FakePort | undefined, readyTimeoutMs = 50) {
  let opened = 0;
  const host = new WhisperHost({
    readyTimeoutMs,
    connect: () => {
      opened += 1;
      return port as any;
    }
  });
  return { host, port, opened: () => opened };
}

describe('WhisperHost - 네이티브 동반 앱', () => {
  it('ready 를 받으면 성공하고 포트를 들고 있는다(포트를 들고 있는 동안만 서버가 산다)', async () => {
    const port = new FakePort();
    const { host } = hostWith(port);
    const pending = host.ensure();
    port.emit({ type: 'ready', spawned: true, port: 8787 });
    const result = await pending;
    expect(result).toEqual({ ok: true, spawned: true });
    expect(host.isConnected()).toBe(true);
    expect(port.disconnected).toBe(0);
  });

  it('이미 떠 있는 서버에 붙었으면 새로 띄우지 않았다고 알려준다', async () => {
    const port = new FakePort();
    const { host } = hostWith(port);
    const pending = host.ensure();
    port.emit({ type: 'ready', spawned: false });
    expect((await pending).spawned).toBe(false);
  });

  it('호스트가 설치돼 있지 않아 connectNative 가 던지면 설치 안내를 준다(캡처는 막지 않는다)', async () => {
    const host = new WhisperHost({
      readyTimeoutMs: 50,
      connect: () => {
        throw new Error('Specified native messaging host not found.');
      }
    });
    const result = await host.ensure();
    expect(result.ok).toBe(false);
    // 최종 사용자에게 터미널 명령을 보여주면 안 된다. 설치는 버튼 한 번으로 끝나야 한다.
    // 문구 자체는 이 빌드에 설치 버튼이 있는지에 따라 달라지므로 engine-dist 의 판단을 그대로 쓴다.
    expect(result.message).toContain(engineMissingMessage());
    expect(result.message).not.toContain('install.sh');
    expect(result.message).not.toContain('npm');
    expect(host.isConnected()).toBe(false);
  });

  it('연결하자마자 끊기면(미등록) 설치 안내를 준다', async () => {
    const port = new FakePort();
    const { host } = hostWith(port);
    const pending = host.ensure();
    port.drop();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.message).toBe(engineMissingMessage());
  });

  it('호스트가 error 를 보내면 그 이유를 그대로 전하고 포트를 닫는다', async () => {
    const port = new FakePort();
    const { host } = hostWith(port);
    const pending = host.ensure();
    port.emit({ type: 'error', message: '게이트웨이가 시작하자마자 종료됐습니다.' });
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.message).toContain('종료됐습니다');
    expect(port.disconnected).toBe(1);
    expect(host.isConnected()).toBe(false);
  });

  it('응답이 없으면 상한에서 포기하되 실패로만 알린다', async () => {
    const port = new FakePort();
    const { host } = hostWith(port, 20);
    const result = await host.ensure();
    expect(result).toEqual({ ok: false, message: NATIVE_HOST_SLOW });
    expect(port.disconnected).toBe(1);
  });

  it('이미 연결돼 있으면 포트를 다시 열지 않는다(중복 서버 방지)', async () => {
    const port = new FakePort();
    const { host, opened } = hostWith(port);
    const pending = host.ensure();
    port.emit({ type: 'ready', spawned: true });
    await pending;
    await host.ensure();
    expect(opened()).toBe(1);
  });

  it('release() 는 포트를 끊는다 = 네이티브 프로세스와 STT 서버가 함께 죽는다', async () => {
    const port = new FakePort();
    const { host } = hostWith(port);
    const pending = host.ensure();
    port.emit({ type: 'ready', spawned: true });
    await pending;
    host.release();
    expect(port.disconnected).toBe(1);
    expect(host.isConnected()).toBe(false);
    host.release();
    expect(port.disconnected).toBe(1); // 두 번 눌러도 한 번만
  });

  it('연결된 뒤에 호스트가 죽으면 다음 시작에서 다시 연결한다', async () => {
    const first = new FakePort();
    const second = new FakePort();
    let nth = 0;
    const host = new WhisperHost({
      readyTimeoutMs: 50,
      connect: () => {
        nth += 1;
        return (nth === 1 ? first : second) as any;
      }
    });
    const pending = host.ensure();
    first.emit({ type: 'ready', spawned: true });
    await pending;

    first.drop(); // 호스트가 죽었다
    expect(host.isConnected()).toBe(false);

    const again = host.ensure();
    second.emit({ type: 'ready', spawned: true });
    expect((await again).ok).toBe(true);
    expect(nth).toBe(2);
  });

  it('heartbeat 는 서비스워커를 깨워두는 용도라 상태를 바꾸지 않는다', async () => {
    const port = new FakePort();
    const { host } = hostWith(port);
    const pending = host.ensure();
    port.emit({ type: 'ready', spawned: true });
    await pending;
    port.emit({ type: 'heartbeat', ts: Date.now() });
    port.emit({ type: 'status', state: 'starting' });
    expect(host.isConnected()).toBe(true);
    expect(port.disconnected).toBe(0);
  });
});

describe('WhisperHost.probe - 고정확도 엔진 설치 여부 확인', () => {
  it('첫 메시지 한 줄만 받고 설치됨으로 보고, 확인용 포트는 바로 닫는다(서버를 띄우지 않는다)', async () => {
    const port = new FakePort();
    const { host } = hostWith(port);
    const pending = host.probe(50);
    // 호스트는 실행되자마자 status 를 보낸다. 게이트웨이는 그 뒤에 뜬다.
    port.emit({ type: 'status', state: 'starting' });
    expect(await pending).toEqual({ installed: true });
    expect(port.disconnected).toBe(1);
    // 세션용 포트를 붙잡으면 안 된다. 붙잡으면 자막을 켜지도 않았는데 서버가 살아 있게 된다.
    expect(host.isConnected()).toBe(false);
  });

  it('등록돼 있지 않으면 Chrome 이 곧바로 끊는다 = 설치 안 됨', async () => {
    const port = new FakePort();
    const { host } = hostWith(port);
    const pending = host.probe(50);
    port.drop();
    const result = await pending;
    expect(result.installed).toBe(false);
    expect(result.reason).toBe('missing');
    expect(result.message).toContain(engineMissingMessage());
  });

  it('connectNative 자체가 던져도 예외를 밖으로 내보내지 않는다', async () => {
    const host = new WhisperHost({
      connect: () => {
        throw new Error('Native host not found');
      }
    });
    const result = await host.probe(50);
    expect(result.installed).toBe(false);
    expect(result.reason).toBe('missing');
    expect(result.message).toContain('Native host not found');
  });

  it('아무 응답이 없으면 상한에서 끊고 설치 안 됨으로 본다', async () => {
    const port = new FakePort();
    const { host } = hostWith(port);
    const result = await host.probe(10);
    expect(result.installed).toBe(false);
    // 대답이 늦은 것과 아예 안 깔린 것은 안내 문구가 달라야 한다. 카드 제목이 이 값으로 갈린다.
    expect(result.reason).toBe('slow');
    expect(result.message).toBe(NATIVE_HOST_SLOW);
    expect(port.disconnected).toBe(1);
  });

  it('이미 연결된 세션이 있으면 새 포트를 열지 않는다', async () => {
    const port = new FakePort();
    const { host, opened } = hostWith(port);
    const pending = host.ensure();
    port.emit({ type: 'ready', spawned: true });
    await pending;
    expect(await host.probe(10)).toEqual({ installed: true });
    expect(opened()).toBe(1);
  });
});
