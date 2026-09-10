import { describe, expect, it } from 'vitest';
import { capSegments, isMeaningfulTranscript, mergeSegment, transcriptToText } from '../src/shared/transcripts';
import type { TranscriptSegment } from '../src/shared/contracts';

const seg = (sequence: number, text: string): TranscriptSegment => ({
  id: `id-${sequence}`,
  sessionId: 's1',
  sequence,
  text,
  startedAtMs: sequence * 1000,
  endedAtMs: sequence * 1000 + 3000,
  createdAt: 0,
  status: 'FINAL'
});

describe('자막 목록', () => {
  it('순서가 뒤바뀌어 도착해도 sequence 오름차순으로 정렬한다', () => {
    let list: TranscriptSegment[] = [];
    for (const s of [3, 1, 2]) list = mergeSegment(list, seg(s, `문장${s}`));
    expect(list.map((x) => x.sequence)).toEqual([1, 2, 3]);
  });

  it('같은 sequence 가 다시 오면 중복 추가하지 않고 갱신한다', () => {
    let list = mergeSegment([], seg(1, '처음'));
    list = mergeSegment(list, seg(1, '수정됨'));
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('수정됨');
  });

  it('빈 자막과 구두점만 있는 자막은 저장 대상이 아니다', () => {
    expect(isMeaningfulTranscript('')).toBe(false);
    expect(isMeaningfulTranscript('   ')).toBe(false);
    expect(isMeaningfulTranscript('...')).toBe(false);
    expect(isMeaningfulTranscript('[음악]')).toBe(false);
    expect(isMeaningfulTranscript('안녕하세요')).toBe(true);
  });

  it('메모리 상한을 넘으면 오래된 자막부터 버린다', () => {
    const list = Array.from({ length: 10 }, (_, i) => seg(i + 1, `줄${i + 1}`));
    const capped = capSegments(list, 4);
    expect(capped.map((x) => x.sequence)).toEqual([7, 8, 9, 10]);
  });

  it('전체 복사용 텍스트는 순서대로 줄바꿈으로 이어붙인다', () => {
    const list = [seg(1, '첫 줄'), seg(2, '둘째 줄')];
    expect(transcriptToText(list)).toBe('첫 줄\n둘째 줄');
  });
});
