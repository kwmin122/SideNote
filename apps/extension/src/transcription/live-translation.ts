/**
 * 확정되기 전의 자막 줄을 번역해 흘려보낸다.
 *
 * Chrome 내장 인식기는 말이 멈춰야 한 줄을 확정한다. 쉬지 않고 말하는 강의에서는 그 한 줄이
 * 수십 초짜리가 되는데, 확정될 때까지 기다렸다가 번역하면 화면이 그동안 비어 있고
 * 마지막에 한꺼번에 쏟아진다. 그래서 인식 중간 결과도 번역해서 내보낸다.
 *
 * 번역기를 매 글자마다 두드리면 밀리므로 최소 간격을 두고, 그 사이에 들어온 글자는
 * 마지막 것만 남겼다가 한 번에 넘긴다. 앞 조각은 CaptionTranslator 의 캐시가 받아 주므로
 * 실제로 새로 번역되는 것은 뒤에 붙은 조각뿐이다.
 */
export class LiveTranslation {
  /** 지금 화면에 흘려보낸 번역. 줄이 확정되면 이 값이 확정 줄의 번역으로 올라간다. */
  translation = '';
  private text = '';
  private sent = '';
  private timer?: ReturnType<typeof setTimeout>;
  private lastAt = 0;

  constructor(
    private readonly translate: (text: string) => Promise<string>,
    private readonly onUpdate: (translation: string) => void,
    private readonly intervalMs = 400
  ) {}

  /** 인식 중간 결과가 들어왔다. */
  push(text: string): void {
    this.text = text.trim();
    if (!this.text || this.text === this.sent || this.timer !== undefined) return;
    const wait = Math.max(0, this.intervalMs - (Date.now() - this.lastAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, wait);
  }

  private async run(): Promise<void> {
    const source = this.text;
    if (!source || source === this.sent) return;
    this.sent = source;
    this.lastAt = Date.now();

    const translated = await this.translate(source);
    // 기다리는 사이에 줄이 확정됐거나(flush) 새 줄이 시작됐으면 이 번역은 이미 지난 줄의 것이다.
    if (!this.text || this.sent !== source) return;
    if (translated) {
      this.translation = translated;
      this.onUpdate(translated);
    }
    // 그동안 말이 더 붙었으면 이어서 한 번 더.
    if (this.text !== this.sent) this.push(this.text);
  }

  /** 줄이 확정됐다. 지금까지 흘려보낸 번역을 돌려주고 비운다. */
  flush(): string {
    const carried = this.translation;
    this.clear();
    return carried;
  }

  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.text = '';
    this.sent = '';
    this.translation = '';
  }
}
