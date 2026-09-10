export interface AudioWindow {
  pcm: Buffer;
  startedAtMs: number;
  endedAtMs: number;
}

export interface WindowerOptions {
  sampleRate: number;
  windowMs: number;
  /** 문장이 window 경계에서 잘리지 않도록 겹치는 구간. */
  overlapMs: number;
  /** 처리 대기 오디오 상한. 넘으면 오래된 오디오를 버린다. */
  maxBacklogMs: number;
}

/**
 * PCM16 스트림을 겹치는 window 로 잘라낸다.
 * window 는 windowMs 길이이고, 다음 window 는 (windowMs - overlapMs) 만큼 전진한다.
 * 인식이 실시간보다 느려 backlog 가 쌓이면 오래된 오디오를 버려 지연이 누적되지 않게 한다.
 */
export class PcmWindower {
  private queue: Buffer = Buffer.alloc(0);
  private cursorMs = 0;
  droppedMs = 0;

  constructor(private readonly options: WindowerOptions) {
    if (options.overlapMs >= options.windowMs) throw new Error('overlapMs 는 windowMs 보다 작아야 합니다.');
  }

  private get bytesPerMs() {
    return (this.options.sampleRate * 2) / 1000;
  }

  private get windowBytes() {
    return Math.floor(this.options.windowMs * this.bytesPerMs);
  }

  private get advanceBytes() {
    return Math.floor((this.options.windowMs - this.options.overlapMs) * this.bytesPerMs);
  }

  get bufferedMs() {
    return Math.floor(this.queue.length / this.bytesPerMs);
  }

  push(chunk: Buffer) {
    this.queue = this.queue.length ? Buffer.concat([this.queue, chunk]) : chunk;
    this.trimBacklog();
  }

  /** 오래된 오디오를 버리되, 타임스탬프가 어긋나지 않도록 cursor 도 함께 밀어준다. */
  private trimBacklog() {
    const maxBytes = Math.floor(this.options.maxBacklogMs * this.bytesPerMs);
    if (this.queue.length <= maxBytes) return;
    const excess = this.queue.length - maxBytes;
    // window 경계에 맞춰 버려야 이후 window 가 정렬을 유지한다.
    const drop = Math.ceil(excess / this.advanceBytes) * this.advanceBytes;
    const actual = Math.min(drop, this.queue.length);
    this.queue = this.queue.subarray(actual);
    const droppedMs = Math.floor(actual / this.bytesPerMs);
    this.cursorMs += droppedMs;
    this.droppedMs += droppedMs;
  }

  /** 완성된 window 가 있으면 반환한다. */
  next(): AudioWindow | null {
    if (this.queue.length < this.windowBytes) return null;
    const pcm = Buffer.from(this.queue.subarray(0, this.windowBytes));
    this.queue = this.queue.subarray(this.advanceBytes);
    const startedAtMs = this.cursorMs;
    this.cursorMs += this.options.windowMs - this.options.overlapMs;
    return { pcm, startedAtMs, endedAtMs: startedAtMs + this.options.windowMs };
  }

  /**
   * 종료 시 남은 꼬리를 마지막 window 로 내보낸다.
   * Whisper 는 1초 미만 오디오에서 없는 말을 지어내므로(실측: 0.83초 → "고개기스입니다")
   * 그보다 짧은 꼬리는 버리는 편이 낫다.
   */
  flush(minMs = 1200): AudioWindow | null {
    const minBytes = Math.floor(minMs * this.bytesPerMs);
    if (this.queue.length < minBytes) return null;
    const pcm = Buffer.from(this.queue);
    const durationMs = Math.floor(pcm.length / this.bytesPerMs);
    const startedAtMs = this.cursorMs;
    this.queue = Buffer.alloc(0);
    this.cursorMs += durationMs;
    return { pcm, startedAtMs, endedAtMs: startedAtMs + durationMs };
  }
}

/** 16-bit PCM 의 RMS. 무음 window 를 Whisper 로 보내지 않기 위한 게이트. */
export function rms(pcm: Buffer): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const value = pcm.readInt16LE(i);
    sum += value * value;
    count += 1;
  }
  return count ? Math.sqrt(sum / count) : 0;
}
