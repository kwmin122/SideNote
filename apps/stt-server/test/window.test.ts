import { describe, expect, it } from 'vitest';
import { PcmWindower, rms } from '../src/window.js';

const SR = 16000;
const bytesFor = (ms: number) => Math.floor((ms * SR * 2) / 1000);
const tone = (ms: number, amplitude = 8000) => {
  const samples = Math.floor((ms * SR) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(Math.round(amplitude * Math.sin(i / 12)), i * 2);
  return buffer;
};

describe('겹치는 오디오 window', () => {
  it('3초 window 를 2.4초씩 전진시키며 잘라낸다', () => {
    const w = new PcmWindower({ sampleRate: SR, windowMs: 3000, overlapMs: 600, maxBacklogMs: 60000 });
    w.push(tone(9000));

    const first = w.next()!;
    expect(first.pcm.length).toBe(bytesFor(3000));
    expect(first.startedAtMs).toBe(0);
    expect(first.endedAtMs).toBe(3000);

    const second = w.next()!;
    // overlap 을 반영해 2400ms 만 전진해야 한다 (3000ms 전진하면 타임스탬프가 밀린다)
    expect(second.startedAtMs).toBe(2400);
    expect(second.endedAtMs).toBe(5400);

    const third = w.next()!;
    expect(third.startedAtMs).toBe(4800);
  });

  it('window 가 다 차기 전에는 아무것도 내보내지 않는다', () => {
    const w = new PcmWindower({ sampleRate: SR, windowMs: 3000, overlapMs: 600, maxBacklogMs: 60000 });
    w.push(tone(2000));
    expect(w.next()).toBeNull();
    w.push(tone(1200));
    expect(w.next()).not.toBeNull();
  });

  it('연속된 window 는 overlapMs 만큼 실제로 겹친다', () => {
    const w = new PcmWindower({ sampleRate: SR, windowMs: 3000, overlapMs: 600, maxBacklogMs: 60000 });
    w.push(tone(9000));
    const a = w.next()!;
    const b = w.next()!;
    const overlapBytes = bytesFor(600);
    expect(a.pcm.subarray(a.pcm.length - overlapBytes).equals(b.pcm.subarray(0, overlapBytes))).toBe(true);
  });

  it('backlog 상한을 넘으면 오래된 오디오를 버리고 타임스탬프를 밀어준다', () => {
    const w = new PcmWindower({ sampleRate: SR, windowMs: 3000, overlapMs: 600, maxBacklogMs: 5000 });
    w.push(tone(20000));
    expect(w.droppedMs).toBeGreaterThan(0);
    expect(w.bufferedMs).toBeLessThanOrEqual(5000);
    const first = w.next()!;
    // 버린 만큼 시작 시각이 앞으로 밀려 있어야 한다
    expect(first.startedAtMs).toBe(w.droppedMs);
  });

  it('종료 시 남은 꼬리를 flush 하고, 너무 짧으면 버린다', () => {
    const w = new PcmWindower({ sampleRate: SR, windowMs: 3000, overlapMs: 600, maxBacklogMs: 60000 });
    w.push(tone(1500));
    expect(w.flush(800)).not.toBeNull();
    w.push(tone(200));
    expect(w.flush(800)).toBeNull();
  });

  it('기본 flush 하한은 1200ms 라 Whisper 가 환각을 내는 짧은 꼬리를 버린다', () => {
    const w = new PcmWindower({ sampleRate: SR, windowMs: 3000, overlapMs: 600, maxBacklogMs: 60000 });
    w.push(tone(900));
    expect(w.flush()).toBeNull();
    w.push(tone(600)); // 합계 1500ms
    const tail = w.flush();
    expect(tail).not.toBeNull();
    expect(tail!.endedAtMs - tail!.startedAtMs).toBe(1500);
  });

  it('overlap 이 window 보다 크면 즉시 실패한다', () => {
    expect(() => new PcmWindower({ sampleRate: SR, windowMs: 1000, overlapMs: 1000, maxBacklogMs: 1000 })).toThrow();
  });

  it('무음 window 의 RMS 는 0 이고 소리가 있으면 커진다', () => {
    expect(rms(Buffer.alloc(3200))).toBe(0);
    expect(rms(tone(200))).toBeGreaterThan(1000);
  });
});
