/**
 * Chrome 에 내장된 언어 모델(Prompt API, Gemini Nano)을 감싼다.
 *
 * 왜 이걸 쓰는가: 키도 서버도 없이 이 컴퓨터 안에서 돈다. 강의 자막·메모·캡처는 밖으로 나가면 안 되는 자료고,
 * 확장 코드에 API key 를 넣는 것은 어차피 불가능하다(패키지를 열면 그대로 보인다).
 *
 * 어디서 도는가: 사이드패널(확장 페이지)에서만 쓴다. 서비스워커/워커 문맥에는 이 API 가 없다.
 * 없는 Chrome 도 많으므로 호출 전에 availability() 로 확인하고, 없으면 화면에서 AI 기능을 접는다.
 */

/** unavailable = 이 기기/Chrome 에서 못 씀, downloadable = 첫 사용 때 모델을 받아야 함. */
export type AiAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface LanguageModelLike {
  availability?: (options?: unknown) => Promise<string>;
  create: (options?: unknown) => Promise<AiSessionLike>;
  params?: () => Promise<unknown>;
}

interface AiSessionLike {
  prompt: (input: unknown, options?: unknown) => Promise<string>;
  promptStreaming: (input: unknown, options?: unknown) => AsyncIterable<string> | ReadableStream<string>;
  destroy: () => void;
  inputUsage?: number;
  inputQuota?: number;
}

function api(): LanguageModelLike | undefined {
  const model = (globalThis as unknown as { LanguageModel?: LanguageModelLike }).LanguageModel;
  return typeof model?.create === 'function' ? model : undefined;
}

/** 이 Chrome 에 내장 모델 API 자체가 있는가. 없으면 화면에서 AI 탭을 접는다. */
export function promptApiSupported(): boolean {
  return api() !== undefined;
}

/**
 * 쓸 수 있는 상태인지 묻는다.
 * 이미지를 같이 넣을 생각이면 그 조건까지 붙여 물어야 한다(모델이 텍스트만 받는 경우가 있다).
 */
export async function aiAvailability(withImage = false): Promise<AiAvailability> {
  const model = api();
  if (!model?.availability) return model ? 'available' : 'unavailable';
  try {
    const options = withImage ? { expectedInputs: [{ type: 'image' }] } : undefined;
    const value = String(await model.availability(options));
    if (value === 'available' || value === 'downloadable' || value === 'downloading') return value;
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export interface AiSessionOptions {
  /** 이 대화 전체에 적용되는 역할 지시. 매 질문마다 다시 보내지 않는다. */
  system: string;
  /** 모델을 처음 받을 때의 진행률(0~100). 몇 분 걸리므로 화면에 보여 줘야 한다. */
  onDownload?: (percent: number) => void;
  /** 캡처 이미지를 같이 넣을 대화인가. */
  withImage?: boolean;
}

export interface AiSession {
  /** 한 번에 답을 받는다. */
  ask(text: string, options?: { image?: Blob; responseConstraint?: unknown; signal?: AbortSignal }): Promise<string>;
  /** 답이 만들어지는 대로 조금씩 받는다. 화면에 글자가 흐르게 하는 용도다. */
  stream(text: string, onChunk: (partial: string) => void, options?: { image?: Blob; signal?: AbortSignal }): Promise<string>;
  /** 남은 문맥 여유(0~1). 1 이면 아직 넉넉하다. */
  usage(): { used: number; quota: number } | undefined;
  destroy(): void;
}

function contentFor(text: string, image?: Blob): unknown {
  if (!image) return text;
  // 멀티모달 입력은 역할/내용 배열 형태로만 받는다.
  return [{ role: 'user', content: [{ type: 'text', value: text }, { type: 'image', value: image }] }];
}

/** ReadableStream 과 async iterable 을 둘 다 받는다. Chrome 버전에 따라 어느 쪽인지 다르다. */
async function drain(
  source: AsyncIterable<string> | ReadableStream<string>,
  onChunk: (chunk: string) => void
): Promise<void> {
  const iterable = source as AsyncIterable<string>;
  if (typeof iterable?.[Symbol.asyncIterator] === 'function') {
    for await (const chunk of iterable) onChunk(String(chunk ?? ''));
    return;
  }
  const reader = (source as ReadableStream<string>).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onChunk(String(value ?? ''));
  }
}

export async function createAiSession(options: AiSessionOptions): Promise<AiSession> {
  const model = api();
  if (!model) throw new Error('LanguageModel unavailable');

  const create = async (withImage: boolean) =>
    model.create({
      initialPrompts: [{ role: 'system', content: options.system }],
      ...(withImage ? { expectedInputs: [{ type: 'image' }] } : {}),
      monitor(monitor: { addEventListener: (name: string, fn: (event: any) => void) => void }) {
        monitor.addEventListener('downloadprogress', (event: any) => {
          const loaded = Number(event?.loaded ?? 0);
          // loaded 는 0~1 로 온다. 화면에는 퍼센트로 보여 준다.
          options.onDownload?.(Math.max(0, Math.min(100, Math.round(loaded * 100))));
        });
      }
    });

  let session: AiSessionLike;
  try {
    session = await create(Boolean(options.withImage));
  } catch (err) {
    // 이미지 입력을 지원하지 않는 Chrome 이면 그 조건만 빼고 다시 만든다(글로만 대화한다).
    if (!options.withImage) throw err;
    session = await create(false);
  }

  return {
    async ask(text, ask = {}) {
      const result = await session.prompt(contentFor(text, ask.image), {
        ...(ask.responseConstraint ? { responseConstraint: ask.responseConstraint } : {}),
        ...(ask.signal ? { signal: ask.signal } : {})
      });
      return String(result ?? '');
    },
    async stream(text, onChunk, ask = {}) {
      let full = '';
      const source = session.promptStreaming(contentFor(text, ask.image), ask.signal ? { signal: ask.signal } : undefined);
      await drain(source, (chunk) => {
        full += chunk;
        onChunk(full);
      });
      return full;
    },
    usage() {
      if (typeof session.inputUsage !== 'number' || typeof session.inputQuota !== 'number') return undefined;
      return { used: session.inputUsage, quota: session.inputQuota };
    },
    destroy() {
      try {
        session.destroy();
      } catch {
        /* 이미 닫혔다 */
      }
    }
  };
}
