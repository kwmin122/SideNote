/**
 * 자막이 화면에 머무는 시간.
 *
 * 말이 끊기면 마지막 자막이 영상 위에 그대로 남는다. 방송 자막(roll-up)이나 Chrome 자체
 * 실시간 자막도 새로 들어오는 말이 없으면 몇 초 뒤에 화면을 비운다. 자막이 갱신될 때마다
 * 타이머를 다시 걸고, 조용한 채로 시간이 다 지나면 화면을 비우게 한다.
 */
export class CaptionDwell {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly onExpire: () => void,
    private readonly holdMs = 5000
  ) {}

  /** 자막을 새로 그렸다. 빈 글자는 이미 비운 것이므로 타이머를 걸지 않는다. */
  touch(text: string): void {
    this.cancel();
    if (!text) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onExpire();
    }, this.holdMs);
  }

  cancel(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
