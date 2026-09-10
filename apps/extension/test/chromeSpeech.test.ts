import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChromeSpeechProvider,
  CHROME_STT_NOT_LOCAL,
  CHROME_STT_UNSUPPORTED,
  requestLanguagePack
} from '../src/transcription/chrome-speech';
import type { ErrorCode, STTConnectionStatus } from '../src/shared/contracts';
import type { ProviderTranscript, SttClientHandlers } from '../src/transcription/client';

/** Chrome 내장 인식기 대역. 실제 Chrome 없이 콜백 순서만 재현한다. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static startThrows = false;

  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  processLocally = false;
  started = 0;
  stopped = 0;
  aborted = 0;
  lastTrack: unknown;
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(track?: unknown) {
    if (FakeRecognition.startThrows) throw new Error('start 실패');
    this.started += 1;
    this.lastTrack = track;
    this.onstart?.();
  }

  stop() {
    this.stopped += 1;
  }

  abort() {
    this.aborted += 1;
  }

  /** Chrome 이 보내는 onresult 를 흉내낸다. results 는 누적되고 resultIndex 부터가 새 내용이다. */
  private history: any[] = [];

  emit(entries: { text: string; isFinal: boolean }[], resultIndex = this.history.length) {
    const built = entries.map((entry) => {
      const result: any = [{ transcript: entry.text }];
      result.isFinal = entry.isFinal;
      return result;
    });
    this.history = [...this.history.slice(0, resultIndex), ...built];
    this.onresult?.({ resultIndex, results: this.history });
  }
}

function fakeTrack(readyState: 'live' | 'ended' = 'live', kind = 'audio') {
  return { kind, readyState, stop: () => {} } as unknown as MediaStreamTrack;
}

interface Recorder {
  handlers: SttClientHandlers;
  finals: ProviderTranscript[];
  partials: string[];
  statuses: STTConnectionStatus[];
  errors: { code: ErrorCode; message: string }[];
  notices: string[];
}

function recorder(): Recorder {
  const finals: ProviderTranscript[] = [];
  const partials: string[] = [];
  const statuses: STTConnectionStatus[] = [];
  const errors: { code: ErrorCode; message: string }[] = [];
  const notices: string[] = [];
  return {
    finals,
    partials,
    statuses,
    errors,
    notices,
    handlers: {
      onTranscript: (result) => finals.push(result),
      onPartial: (text) => partials.push(text),
      onStatus: (status) => statuses.push(status),
      onError: (code, message) => errors.push({ code, message }),
      onNotice: (message) => notices.push(message)
    }
  };
}

const scope = globalThis as unknown as Record<string, unknown>;

function installCtor(options: { available?: string; install?: boolean; withStatics?: boolean } = {}) {
  const Ctor: any = FakeRecognition;
  if (options.withStatics !== false) {
    Ctor.available = vi.fn(async () => options.available ?? 'available');
    Ctor.install = vi.fn(async () => options.install ?? true);
  } else {
    delete Ctor.available;
    delete Ctor.install;
  }
  scope.SpeechRecognition = Ctor;
  return Ctor;
}

beforeEach(() => {
  FakeRecognition.instances = [];
  FakeRecognition.startThrows = false;
});

afterEach(() => {
  delete scope.SpeechRecognition;
  delete scope.webkitSpeechRecognition;
  delete (FakeRecognition as any).available;
  delete (FakeRecognition as any).install;
});

describe('ChromeSpeechProvider - 시작 조건', () => {
  it('Web Speech API 가 없으면 실패하고 이유를 알려준다(offscreen 미지원 판별용)', async () => {
    const rec = recorder();
    const provider = new ChromeSpeechProvider();
    const ok = await provider.connect({ sessionId: 's1', audioTrack: fakeTrack() }, rec.handlers);
    expect(ok).toBe(false);
    expect(rec.errors[0]?.message).toBe(CHROME_STT_UNSUPPORTED);
    expect(rec.statuses.at(-1)).toBe('FAILED');
  });

  it('on-device 확인 API 가 없으면 인식기를 만들지 않는다(오디오를 서버로 보내지 않기 위해)', async () => {
    installCtor({ withStatics: false });
    const rec = recorder();
    const ok = await new ChromeSpeechProvider().connect({ sessionId: 's1', audioTrack: fakeTrack() }, rec.handlers);
    expect(ok).toBe(false);
    expect(rec.errors[0]?.message).toBe(CHROME_STT_NOT_LOCAL);
    expect(FakeRecognition.instances.length).toBe(0);
  });

  it('언어팩을 쓸 수 없으면 인식기를 만들지 않는다', async () => {
    installCtor({ available: 'unavailable' });
    const rec = recorder();
    const ok = await new ChromeSpeechProvider().connect({ sessionId: 's1', audioTrack: fakeTrack() }, rec.handlers);
    expect(ok).toBe(false);
    expect(FakeRecognition.instances.length).toBe(0);
    expect(rec.errors[0]?.code).toBe('STT_PROVIDER_FAILED');
  });

  it('제공자는 install() 을 직접 부르지 않는다 (offscreen 에는 사용자 제스처가 없어 NotAllowedError 가 난다)', async () => {
    // downloadable 인 채로 안 바뀐다 = 클릭 쪽 install() 이 아직 안 붙었다.
    const Ctor = installCtor({ available: 'downloadable' });
    const rec = recorder();
    const ok = await new ChromeSpeechProvider({ packPollMs: 1, packStartTimeoutMs: 5, packTimeoutMs: 60_000 }).connect(
      { sessionId: 's1', audioTrack: fakeTrack() },
      rec.handlers
    );
    expect(ok).toBe(false);
    expect(Ctor.install).not.toHaveBeenCalled();
    // 무한 대기 대신, 사용자가 무엇을 하면 되는지 알려준다.
    expect(rec.errors[0]?.message).toContain('한 번 더 눌러');
    expect(FakeRecognition.instances.length).toBe(0);
  });

  it('언어팩 다운로드는 오류가 아니라 알림으로 나가고, 끝나면 자동으로 시작한다', async () => {
    const Ctor = installCtor({ available: 'downloadable' });
    // 클릭 쪽 install() 이 붙어 downloadable -> downloading -> available 로 흘러가는 상황.
    let asked = 0;
    Ctor.available = vi.fn(async () => {
      asked += 1;
      return asked === 1 ? 'downloadable' : asked === 2 ? 'downloading' : 'available';
    });
    const rec = recorder();
    const ok = await new ChromeSpeechProvider({ packPollMs: 1, packStartTimeoutMs: 60_000, packTimeoutMs: 200 }).connect(
      { sessionId: 's1', audioTrack: fakeTrack() },
      rec.handlers
    );
    expect(ok).toBe(true);
    // 사용자가 다시 누를 필요가 없어야 한다 = 오류 배너가 뜨면 안 된다.
    expect(rec.errors).toEqual([]);
    expect(rec.notices.length).toBe(2);
    expect(rec.notices[0]).toContain('내려받는 중');
    expect(rec.notices.at(-1)).toContain('준비');
  });

  it('이미 내려받는 중(downloading)이면 install 을 다시 부르지 않고 기다린다', async () => {
    // 두 번째 install() 은 "이미 받는 중" 이라 false 를 주고, 그걸 실패로 보고하면 안 된다.
    const Ctor = installCtor({ available: 'downloading', install: false });
    let asked = 0;
    Ctor.available = vi.fn(async () => {
      asked += 1;
      return asked >= 3 ? 'available' : 'downloading';
    });
    const rec = recorder();
    const ok = await new ChromeSpeechProvider({ packPollMs: 1, packTimeoutMs: 500 }).connect(
      { sessionId: 's1', audioTrack: fakeTrack() },
      rec.handlers
    );
    expect(ok).toBe(true);
    expect(Ctor.install).not.toHaveBeenCalled();
    expect(rec.errors).toEqual([]);
    expect(FakeRecognition.instances[0]?.started).toBe(1);
  });

  it('클릭 쪽 설치가 끝나 available 로 바뀌면 제공자는 그대로 시작한다', async () => {
    const Ctor = installCtor({ available: 'downloadable' });
    let asked = 0;
    Ctor.available = vi.fn(async () => {
      asked += 1;
      return asked === 1 ? 'downloadable' : 'available';
    });
    const rec = recorder();
    const ok = await new ChromeSpeechProvider({ packPollMs: 1, packTimeoutMs: 200 }).connect(
      { sessionId: 's1', audioTrack: fakeTrack() },
      rec.handlers
    );
    expect(ok).toBe(true);
    expect(Ctor.install).not.toHaveBeenCalled();
    expect(rec.errors).toEqual([]);
  });

  it('기다려도 끝나지 않으면 상한에서 멈추고 이유를 알려준다', async () => {
    installCtor({ available: 'downloading' });
    const rec = recorder();
    const ok = await new ChromeSpeechProvider({ packPollMs: 1, packTimeoutMs: 20 }).connect(
      { sessionId: 's1', audioTrack: fakeTrack() },
      rec.handlers
    );
    expect(ok).toBe(false);
    expect(rec.errors.at(-1)?.code).toBe('STT_PROVIDER_FAILED');
    expect(rec.statuses.at(-1)).toBe('FAILED');
  });

  it('기다리는 중에 사용자가 종료하면 곧바로 빠져나온다', async () => {
    installCtor({ available: 'downloading' });
    const rec = recorder();
    const provider = new ChromeSpeechProvider({ packPollMs: 1, packTimeoutMs: 60_000 });
    const pending = provider.connect({ sessionId: 's1', audioTrack: fakeTrack() }, rec.handlers);
    provider.close();
    expect(await pending).toBe(false);
    expect(FakeRecognition.instances.length).toBe(0);
  });

  it('언어팩을 기다리는 동안 일시정지하면 자막이 몰래 시작되지 않는다', async () => {
    const Ctor = installCtor({ available: 'downloading' });
    let calls = 0;
    Ctor.available = vi.fn(async () => (++calls >= 2 ? 'available' : 'downloading'));
    const rec = recorder();
    const provider = new ChromeSpeechProvider({ packPollMs: 1, packTimeoutMs: 60_000 });
    const pending = provider.connect({ sessionId: 's1', audioTrack: fakeTrack() }, rec.handlers);
    provider.pause();

    expect(await pending).toBe(true);
    // 인식기는 만들어 두되 시작하지는 않는다. 화면은 "일시정지" 상태다.
    expect(FakeRecognition.instances.length).toBe(1);
    expect(FakeRecognition.instances[0].started).toBe(0);
    expect(rec.errors).toEqual([]);

    // 재개를 누르면 그때 시작한다.
    provider.resume();
    expect(FakeRecognition.instances[0].started).toBe(1);
  });

  it('오디오 트랙이 살아 있지 않으면 시작하지 않는다', async () => {
    installCtor();
    const rec = recorder();
    const ok = await new ChromeSpeechProvider().connect({ sessionId: 's1', audioTrack: fakeTrack('ended') }, rec.handlers);
    expect(ok).toBe(false);
    expect(FakeRecognition.instances.length).toBe(0);
  });

  it('정상 경로에서는 on-device 설정으로 트랙을 물려 시작한다', async () => {
    const Ctor = installCtor();
    const rec = recorder();
    const track = fakeTrack();
    const ok = await new ChromeSpeechProvider().connect({ sessionId: 's1', audioTrack: track }, rec.handlers);
    expect(ok).toBe(true);
    expect(Ctor.available).toHaveBeenCalledWith({ langs: ['ko-KR'], processLocally: true });
    const instance = FakeRecognition.instances[0];
    expect(instance.processLocally).toBe(true);
    expect(instance.lang).toBe('ko-KR');
    expect(instance.continuous).toBe(true);
    expect(instance.interimResults).toBe(true);
    expect(instance.lastTrack).toBe(track);
    expect(rec.statuses.at(-1)).toBe('CONNECTED');
  });
});

describe('ChromeSpeechProvider - 자막 전달', () => {
  async function connected() {
    installCtor();
    const rec = recorder();
    const provider = new ChromeSpeechProvider();
    await provider.connect({ sessionId: 's1', audioTrack: fakeTrack() }, rec.handlers);
    return { provider, rec, instance: FakeRecognition.instances[0] };
  }

  it('진행 중 결과는 오버레이용 partial 로만 나간다', async () => {
    const { rec, instance } = await connected();
    instance.emit([{ text: '오늘 강의에서는', isFinal: false }]);
    expect(rec.partials).toEqual(['오늘 강의에서는']);
    expect(rec.finals.length).toBe(0);
  });

  it('확정 결과는 순번을 붙여 transcript 로 나간다', async () => {
    const { rec, instance } = await connected();
    instance.emit([{ text: '첫 문장입니다.', isFinal: true }]);
    instance.emit([{ text: '둘째 문장입니다.', isFinal: true }], 1);
    expect(rec.finals.map((f) => f.text)).toEqual(['첫 문장입니다.', '둘째 문장입니다.']);
    expect(rec.finals.map((f) => f.sequence)).toEqual([1, 2]);
    expect(rec.finals.every((f) => f.isFinal)).toBe(true);
    expect(rec.finals[0].endedAtMs).toBeGreaterThanOrEqual(rec.finals[0].startedAtMs);
  });

  it('같은 문장이 다시 확정되면 한 번만 내보낸다(재시작 중복 방지)', async () => {
    const { rec, instance } = await connected();
    instance.emit([{ text: '같은 문장', isFinal: true }]);
    instance.emit([{ text: '같은 문장', isFinal: true }], 1);
    expect(rec.finals.length).toBe(1);
  });

  it('빈 결과는 버린다', async () => {
    const { rec, instance } = await connected();
    instance.emit([{ text: '   ', isFinal: true }]);
    expect(rec.finals.length).toBe(0);
  });

  it('PCM 프레임을 보내도 인식기에는 아무 일도 일어나지 않는다', async () => {
    const { provider, instance } = await connected();
    provider.send(new ArrayBuffer(8));
    expect(instance.started).toBe(1);
    expect(instance.stopped).toBe(0);
  });
});

describe('ChromeSpeechProvider - 끊김/일시정지', () => {
  async function connected() {
    installCtor();
    const rec = recorder();
    const provider = new ChromeSpeechProvider();
    await provider.connect({ sessionId: 's1', audioTrack: fakeTrack() }, rec.handlers);
    return { provider, rec, instance: FakeRecognition.instances[0] };
  }

  it('무음으로 세션이 끝나면 자동으로 다시 켠다', async () => {
    const { instance } = await connected();
    instance.onend?.();
    expect(instance.started).toBe(2);
  });

  it('일시정지하면 인식기를 멈추고 다시 켜지 않는다', async () => {
    const { provider, instance } = await connected();
    provider.pause();
    expect(instance.stopped).toBe(1);
    instance.onend?.();
    expect(instance.started).toBe(1);
  });

  it('재개하면 다시 켠다', async () => {
    const { provider, instance } = await connected();
    provider.pause();
    instance.onend?.();
    provider.resume();
    expect(instance.started).toBe(2);
  });

  it('종료한 뒤에는 다시 켜지 않는다', async () => {
    const { provider, instance } = await connected();
    provider.close();
    expect(instance.aborted).toBe(1);
    instance.onend?.();
    expect(instance.started).toBe(1);
  });

  it('트랙이 끝났으면 다시 켜지 않는다', async () => {
    installCtor();
    const rec = recorder();
    const track = fakeTrack();
    const provider = new ChromeSpeechProvider();
    await provider.connect({ sessionId: 's1', audioTrack: track }, rec.handlers);
    (track as unknown as { readyState: string }).readyState = 'ended';
    FakeRecognition.instances[0].onend?.();
    expect(FakeRecognition.instances[0].started).toBe(1);
  });

  it('언어 미지원 오류는 재시작 없이 실패로 끝낸다', async () => {
    const { rec, instance } = await connected();
    instance.onerror?.({ error: 'language-not-supported' });
    expect(rec.statuses.at(-1)).toBe('FAILED');
    instance.onend?.();
    expect(instance.started).toBe(1);
  });

  it('no-speech 는 오류로 보고하지 않는다', async () => {
    const { rec, instance } = await connected();
    instance.onerror?.({ error: 'no-speech' });
    expect(rec.errors.length).toBe(0);
  });

  it('계속 끊기면 상한에서 멈춘다(무한 재시작 방지)', async () => {
    const { rec, instance } = await connected();
    for (let i = 0; i < 25; i += 1) instance.onend?.();
    expect(instance.started).toBe(21); // 최초 1 + 재시작 20
    expect(rec.statuses.at(-1)).toBe('FAILED');
  });

  it('중간에 자막이 나오면 재시작 상한을 다시 채운다(긴 강의에서 멈추지 않게)', async () => {
    const { rec, instance } = await connected();
    for (let i = 0; i < 15; i += 1) instance.onend?.();
    instance.emit([{ text: '강의가 계속되고 있습니다.', isFinal: true }]);
    for (let i = 0; i < 15; i += 1) instance.onend?.();
    expect(rec.statuses.at(-1)).not.toBe('FAILED');
    expect(instance.started).toBe(31);
  });

  it('재시작이 예외로 실패하면 재연결 중에 갇히지 않고 실패로 알린다', async () => {
    const { rec, instance } = await connected();
    FakeRecognition.startThrows = true;
    instance.onend?.();
    expect(rec.statuses.at(-1)).toBe('FAILED');
    expect(rec.errors.at(-1)?.code).toBe('STT_PROVIDER_FAILED');
  });

  it('종료 시 마지막 문장을 기다렸다가 반환한다', async () => {
    const { provider, instance } = await connected();
    const done = provider.endSession(50);
    expect(instance.stopped).toBe(1);
    instance.emit([{ text: '마지막 문장입니다.', isFinal: true }]);
    await expect(done).resolves.toBeUndefined();
  });

  it('마지막 문장이 오지 않아도 유예 시간 뒤에 반환한다', async () => {
    const { provider } = await connected();
    await expect(provider.endSession(20)).resolves.toBeUndefined();
  });
});

describe('requestLanguagePack (사이드패널 클릭 안에서 부르는 설치 시작점)', () => {
  it('클릭 시점에 install() 을 정확한 질의로 부른다', async () => {
    const Ctor = installCtor({ available: 'downloadable', install: true });
    await expect(requestLanguagePack('ko-KR')).resolves.toBe(true);
    expect(Ctor.install).toHaveBeenCalledWith({ langs: ['ko-KR'], processLocally: true });
  });

  it('install() 이 거부돼도 던지지 않는다 (자막 시작을 막으면 안 된다)', async () => {
    const Ctor = installCtor({ available: 'downloadable' });
    Ctor.install = vi.fn(async () => {
      throw new DOMException('Requires handling a user gesture', 'NotAllowedError');
    });
    await expect(requestLanguagePack('ko-KR')).resolves.toBe(false);
  });

  it('Web Speech API 가 없는 문서에서도 조용히 false 를 준다', async () => {
    await expect(requestLanguagePack('ko-KR')).resolves.toBe(false);
  });
});
