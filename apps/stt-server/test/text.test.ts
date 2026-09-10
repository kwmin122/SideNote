import { describe, expect, it } from 'vitest';
import { dedupAgainstPrevious, isUsableTranscript, normalizeForCompare } from '../src/text.js';
import { cleanTranscript } from '../src/whisper.js';

describe('overlap 자막 dedup', () => {
  it('직전 자막의 끝과 겹치는 앞부분을 잘라낸다', () => {
    const prev = '오늘은 프로세스 스케줄링에 대해 알아보겠습니다';
    const next = '스케줄링에 대해 알아보겠습니다 먼저 라운드 로빈부터 봅니다';
    expect(dedupAgainstPrevious(prev, next)).toBe('먼저 라운드 로빈부터 봅니다');
  });

  it('완전히 같은 자막이 다시 오면 통째로 버린다', () => {
    expect(dedupAgainstPrevious('안녕하세요 여러분', '안녕하세요 여러분')).toBe('');
  });

  it('직전 자막에 이미 포함된 내용이면 버린다', () => {
    expect(dedupAgainstPrevious('안녕하세요 여러분 반갑습니다', '여러분 반갑습니다')).toBe('');
  });

  it('구두점만 다른 반복도 같은 것으로 본다', () => {
    expect(dedupAgainstPrevious('네, 그렇습니다.', '네 그렇습니다')).toBe('');
  });

  it('겹치지 않는 새 문장은 그대로 둔다', () => {
    expect(dedupAgainstPrevious('첫 번째 주제입니다', '완전히 다른 이야기입니다')).toBe('완전히 다른 이야기입니다');
  });

  it('직전 자막이 없으면 그대로 통과시킨다', () => {
    expect(dedupAgainstPrevious('', '첫 자막입니다')).toBe('첫 자막입니다');
  });

  it('정규화는 공백과 구두점을 무시한다', () => {
    expect(normalizeForCompare('안녕, 하세요!')).toBe(normalizeForCompare('안녕 하세요'));
  });
});

describe('쓸모없는 자막 필터', () => {
  it('빈 문자열과 공백은 버린다', () => {
    expect(isUsableTranscript('')).toBe(false);
    expect(isUsableTranscript('   ')).toBe(false);
  });

  it('(음악) [박수] 같은 비음성 토큰은 버린다', () => {
    expect(isUsableTranscript('(음악)')).toBe(false);
    expect(isUsableTranscript('[박수]')).toBe(false);
    expect(isUsableTranscript('【음악】')).toBe(false);
  });

  it('실제 문장은 통과시킨다', () => {
    expect(isUsableTranscript('오늘 강의를 시작합니다')).toBe(true);
  });
});

describe('whisper 출력 정리', () => {
  it('타임스탬프 잔재와 여분 공백을 제거한다', () => {
    expect(cleanTranscript('[00:00:00.000 --> 00:00:03.000]   안녕하세요   여러분  \n')).toBe('안녕하세요 여러분');
  });
});

describe('dedupAgainstPrevious - 글자 단위 보정', () => {
  it('단어가 잘려 토큰이 어긋나도 겹친 구간을 지운다', () => {
    const prev = '전세계적으로 보안 기초 및 인공지능';
    const next = '보안기초 및 인공지능 보안 가이드와 규제를';
    expect(dedupAgainstPrevious(prev, next)).toBe('보안 가이드와 규제를');
  });

  it('겹치는 글자가 짧으면(우연한 일치) 지우지 않는다', () => {
    expect(dedupAgainstPrevious('오늘은 여기까지', '까지 온 김에 더 봅시다')).toBe('까지 온 김에 더 봅시다');
  });

  it('겹치는 구간이 없으면 그대로 둔다', () => {
    expect(dedupAgainstPrevious('프로세스 스케줄링을 봅니다', '메모리 관리로 넘어가겠습니다')).toBe('메모리 관리로 넘어가겠습니다');
  });
});
