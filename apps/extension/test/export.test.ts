import { describe, expect, it } from 'vitest';
import {
  buildSessionHtml,
  bundleFileName,
  captureClipboardText,
  captureFileName,
  escapeHtml,
  formatClock,
  sanitizeFileName,
  wrapTextByWidth
} from '../src/shared/export';

const AT = new Date('2026-03-04T05:06:07').getTime();

describe('파일 이름', () => {
  it('경로 구분자와 특수문자를 지운다', () => {
    expect(sanitizeFileName('1강/운영체제: 스케줄링*')).toBe('1강 운영체제 스케줄링');
  });

  it('제목이 비면 대체 이름을 쓴다', () => {
    expect(sanitizeFileName('   ', 'Lecture')).toBe('Lecture');
  });

  it('재생 위치를 알면 파일 이름에 넣는다', () => {
    const name = captureFileName({ title: '운영체제 1강', videoTimeSec: 763, memo: '', createdAt: AT });
    expect(name).toBe('운영체제 1강_00-12-43.png');
  });

  it('재생 위치를 모르면 캡처 시각을 쓴다', () => {
    const name = captureFileName({ title: '운영체제 1강', memo: '', createdAt: AT });
    expect(name).toBe('운영체제 1강_20260304-050607.png');
  });

  it('전체 저장은 html 파일로 나간다', () => {
    expect(bundleFileName('운영체제 1강', AT)).toBe('운영체제 1강_20260304-050607.html');
  });
});

describe('클립보드 보조 텍스트', () => {
  it('제목·재생 위치·주소·메모를 함께 담는다', () => {
    const text = captureClipboardText({
      title: '운영체제 1강',
      pageUrl: 'https://lms.example.com/vod/1',
      videoTimeSec: 763,
      memo: '스케줄러 비교표',
      createdAt: AT
    });
    expect(text).toBe('운영체제 1강\nAt 00:12:43\nhttps://lms.example.com/vod/1\n\n스케줄러 비교표');
  });

  it('메모가 없으면 없다고 남긴다', () => {
    const text = captureClipboardText({ title: '강의', memo: '  ', createdAt: AT });
    expect(text).toBe('강의\n\n(no note)');
  });
});

describe('캔버스 줄바꿈', () => {
  // 글자 하나를 10px 로 보는 가짜 측정기.
  const measure = (s: string) => s.length * 10;

  it('폭을 넘기 전에 단어 단위로 끊는다', () => {
    expect(wrapTextByWidth('가나다 라마바 사아자', 70, measure)).toEqual(['가나다 라마바', '사아자']);
  });

  it('한 단어가 폭보다 길면 글자 단위로 자른다', () => {
    expect(wrapTextByWidth('가'.repeat(7), 30, measure)).toEqual(['가가가', '가가가', '가']);
  });

  it('줄바꿈이 들어 있으면 그대로 지킨다', () => {
    expect(wrapTextByWidth('첫 줄\n둘째 줄', 100, measure)).toEqual(['첫 줄', '둘째 줄']);
  });
});

describe('전체 저장 HTML', () => {
  const html = buildSessionHtml({
    title: '운영체제 <1강>',
    pageUrl: 'https://lms.example.com/vod/1',
    generalMemo: '문맥 교환 비용 정리',
    transcripts: [
      { startedAtMs: 0, text: '안녕하세요' },
      { startedAtMs: 65000, text: '라운드 로빈을 봅니다' }
    ],
    captures: [
      { dataUrl: 'data:image/png;base64,AAA', memo: '비교표', videoTimeSec: 763, createdAt: AT },
      { dataUrl: 'data:image/png;base64,BBB', memo: '', createdAt: AT }
    ],
    exportedAt: AT
  });

  it('캡처 이미지를 data URI 로 안에 담는다(파일 하나로 열림)', () => {
    expect(html).toContain('src="data:image/png;base64,AAA"');
    expect(html).toContain('src="data:image/png;base64,BBB"');
  });

  it('캡처마다 메모가 함께 들어간다', () => {
    expect(html).toContain('비교표');
    expect(html).toContain('(no note)');
  });

  it('일반 메모와 자막을 모두 담는다', () => {
    expect(html).toContain('문맥 교환 비용 정리');
    expect(html).toContain('안녕하세요');
    expect(html).toContain('라운드 로빈을 봅니다');
    expect(html).toContain('<time>1:05</time>');
  });

  it('제목의 꺾쇠는 태그로 해석되지 않게 이스케이프한다', () => {
    expect(html).toContain('운영체제 &lt;1강&gt;');
    expect(html).not.toContain('<1강>');
  });

  it('재생 위치를 캡처 라벨에 붙인다', () => {
    expect(html).toContain('Capture 1 · 00:12:43');
  });
});

describe('전체 저장 HTML - 캡처 없는 메모', () => {
  // 이미지 없이 메모만 남긴 항목(타임라인의 "메모만 추가")도 저장에서 빠지면 안 된다.
  const html = buildSessionHtml({
    title: '운영체제 1강',
    pageUrl: '',
    generalMemo: '',
    transcripts: [],
    captures: [
      { dataUrl: '', memo: '이 부분 시험에 나온다고 함', videoTimeSec: 125, createdAt: AT, captureType: 'MEMO' },
      { dataUrl: 'data:image/png;base64,AAA', memo: '비교표', createdAt: AT }
    ],
    exportedAt: AT
  });

  it('이미지가 없어도 메모 본문이 남는다', () => {
    expect(html).toContain('이 부분 시험에 나온다고 함');
  });

  it('이미지가 없으면 img 태그를 만들지 않는다(깨진 이미지 방지)', () => {
    expect(html).not.toContain('src=""');
    expect((html.match(/<img /g) ?? []).length).toBe(1);
  });

  it('메모 항목에도 재생 위치가 붙는다', () => {
    expect(html).toContain('Note 1 · 00:02:05');
  });

  it('머리말에서 캡처 장수와 이미지 없는 메모 개수를 구분해서 센다', () => {
    // 항목 2개 = 이미지 1장 + 메모만 1개. 사이드패널 알림 문구와 같은 기준으로 센다.
    expect(html).toContain('1 captures · 1 notes');
  });
});

describe('보조 함수', () => {
  it('formatClock 은 시:분:초로 만든다', () => {
    expect(formatClock(0)).toBe('00:00:00');
    expect(formatClock(3723)).toBe('01:02:03');
    expect(formatClock(undefined)).toBe('');
  });

  it('escapeHtml 은 스크립트를 무력화한다', () => {
    expect(escapeHtml('<script>x</script>')).toBe('&lt;script&gt;x&lt;/script&gt;');
  });
});
