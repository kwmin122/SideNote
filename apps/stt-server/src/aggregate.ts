/**
 * window 단위 인식 결과(fragment)를 읽을 수 있는 한 줄(line)로 합친다.
 *
 * 3~5초 window 는 문장 중간을 자르기 때문에 그대로 내보내면 자막이 잘게 부서져 보인다.
 * 여기서 문장 끝/무음/길이 상한을 기준으로 묶어 사이드패널에는 문장 단위로만 내보낸다.
 * (영상 위 오버레이는 묶기 전 fragment 를 그대로 받아 지연 없이 표시한다.)
 */
export interface Fragment {
  text: string;
  startedAtMs: number;
  endedAtMs: number;
}

export interface LineAggregatorOptions {
  /** 한 줄이 이 시간을 넘으면 문장이 안 끝나도 끊는다. */
  maxLineMs: number;
  /** 한 줄이 이 글자 수를 넘으면 끊는다. */
  maxLineChars: number;
  /** fragment 사이가 이만큼 비면 앞 문장이 끝난 것으로 본다(무음으로 window 가 건너뛰어짐). */
  gapMs: number;
}

/**
 * 한국어 강의에서 문장이 끝났다고 볼 수 있는 어미.
 * "필요", "중요" 처럼 명사로 끝나는 경우를 문장 끝으로 오인하지 않도록
 * 단독 '요'/'다' 가 아니라 종결어미 형태만 넣는다.
 */
const SENTENCE_TAIL =
  /(?:니다|니까|세요|해요|어요|아요|에요|예요|이죠|지요|죠|네요|군요|고요|는데요|거든요|잖아요|더라고요|나요|까요|겠죠|한다|이다|있다|없다|같다|았다|었다|된다|보자|하자)$/;

const PUNCT_TAIL = /[.!?…。？！]$/;

/** 이 fragment 로 문장이 끝났는지. 구두점이 있거나 종결어미로 끝나면 끝난 것으로 본다. */
export function endsSentence(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (PUNCT_TAIL.test(trimmed)) return true;
  const bare = trimmed.replace(/[)\]"'’”』」]+$/, '');
  return SENTENCE_TAIL.test(bare);
}

export class LineAggregator {
  private parts: Fragment[] = [];

  constructor(private readonly options: LineAggregatorOptions) {}

  /** 아직 확정되지 않은 진행 중인 줄. 오버레이가 실시간으로 보여주는 값. */
  get pending(): Fragment | null {
    return this.join();
  }

  get pendingCount(): number {
    return this.parts.length;
  }

  /** fragment 를 넣고, 이번에 확정된 줄이 있으면 돌려준다. */
  push(fragment: Fragment): Fragment[] {
    const text = fragment.text.trim();
    if (!text) return [];
    const done: Fragment[] = [];
    const last = this.parts[this.parts.length - 1];
    // 무음으로 window 를 건너뛰면 fragment 사이에 시간이 빈다. 그 지점이 문장 경계다.
    if (last && fragment.startedAtMs - last.endedAtMs > this.options.gapMs) {
      const flushed = this.flush();
      if (flushed) done.push(flushed);
    }
    this.parts.push({ ...fragment, text });
    if (this.shouldClose(text)) {
      const flushed = this.flush();
      if (flushed) done.push(flushed);
    }
    return done;
  }

  private shouldClose(lastText: string): boolean {
    if (endsSentence(lastText)) return true;
    const first = this.parts[0];
    const last = this.parts[this.parts.length - 1];
    if (last.endedAtMs - first.startedAtMs >= this.options.maxLineMs) return true;
    return this.charCount() >= this.options.maxLineChars;
  }

  private charCount(): number {
    return this.parts.reduce((sum, part, index) => sum + part.text.length + (index ? 1 : 0), 0);
  }

  private join(): Fragment | null {
    if (!this.parts.length) return null;
    const text = this.parts
      .map((part) => part.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return null;
    return {
      text,
      startedAtMs: this.parts[0].startedAtMs,
      endedAtMs: this.parts[this.parts.length - 1].endedAtMs
    };
  }

  /** 남은 fragment 를 한 줄로 확정한다. 없으면 null. */
  flush(): Fragment | null {
    const line = this.join();
    this.parts = [];
    return line;
  }

  reset() {
    this.parts = [];
  }
}
