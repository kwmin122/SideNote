import { describe, expect, it } from 'vitest';
import {
  formatScriptClock,
  normalizeScriptLines,
  parseJson3,
  pickCaptionTrack,
  scriptCharCount,
  scriptToText,
  type RawCaptionTrack
} from '../src/shared/script';

const track = (lang: string, label: string, kind?: string): RawCaptionTrack => ({
  lang,
  label,
  baseUrl: `https://example.com/timedtext?lang=${lang}`,
  kind
});

describe('자막 트랙 고르기', () => {
  it('고른 언어와 정확히 같은 트랙을 먼저 쓴다', () => {
    const tracks = [track('en', 'English'), track('ko', '한국어'), track('ja', '日本語')];
    expect(pickCaptionTrack(tracks, 'ko')?.lang).toBe('ko');
  });

  it('지역 표기가 달라도 같은 언어면 고른다 (pt-BR ← pt)', () => {
    const tracks = [track('en', 'English'), track('pt-BR', 'Português')];
    expect(pickCaptionTrack(tracks, 'pt')?.lang).toBe('pt-BR');
  });

  it('고른 언어가 없으면 화면 언어를 본다', () => {
    const tracks = [track('en', 'English'), track('ja', '日本語')];
    expect(pickCaptionTrack(tracks, '', 'ja-JP')?.lang).toBe('ja');
  });

  it('같은 언어가 둘이면 자동 생성이 아닌 쪽을 쓴다', () => {
    const tracks = [track('en', 'English (auto-generated)', 'asr'), track('en', 'English')];
    expect(pickCaptionTrack(tracks, 'en')?.label).toBe('English');
  });

  it('아무것도 안 맞으면 사람이 단 자막 중 첫 번째를 쓴다', () => {
    const tracks = [track('de', 'Deutsch (auto)', 'asr'), track('fr', 'Français')];
    expect(pickCaptionTrack(tracks, 'ko', 'ko')?.lang).toBe('fr');
  });

  it('주소가 없는 트랙은 아예 후보에서 뺀다', () => {
    const broken = { lang: 'ko', label: '한국어', baseUrl: '' } as RawCaptionTrack;
    expect(pickCaptionTrack([broken], 'ko')).toBeUndefined();
  });

  it('트랙이 하나도 없으면 undefined 다', () => {
    expect(pickCaptionTrack([], 'ko')).toBeUndefined();
  });
});

describe('json3 자막 읽기', () => {
  it('시작 시각과 글자를 줄 단위로 뽑는다', () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
        { tStartMs: 2500, dDurationMs: 1500, segs: [{ utf8: 'second line' }] }
      ]
    });
    const lines = parseJson3(body);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ startSec: 0, endSec: 2, text: 'Hello world' });
    expect(lines[1].startSec).toBe(2.5);
  });

  it('segs 가 없는 이벤트(빈 구간 표시)는 버린다', () => {
    const body = JSON.stringify({ events: [{ tStartMs: 0 }, { tStartMs: 1000, segs: [{ utf8: 'ok' }] }] });
    expect(parseJson3(body).map((line) => line.text)).toEqual(['ok']);
  });

  it('JSON 이 아니면 빈 목록이다 (로그인 페이지 HTML 등)', () => {
    expect(parseJson3('<html>nope</html>')).toEqual([]);
    expect(parseJson3('')).toEqual([]);
  });
});

describe('자막 줄 다듬기', () => {
  it('줄바꿈과 겹친 공백을 한 칸으로 정리하고 빈 줄은 버린다', () => {
    const lines = normalizeScriptLines([
      { startSec: 1, text: '  안녕하세요\n  여러분  ' },
      { startSec: 2, text: '   ' }
    ]);
    expect(lines).toEqual([{ startSec: 1, endSec: undefined, text: '안녕하세요 여러분' }]);
  });

  it('시간순으로 세운다', () => {
    const lines = normalizeScriptLines([
      { startSec: 30, text: 'later' },
      { startSec: 5, text: 'earlier' }
    ]);
    expect(lines.map((line) => line.text)).toEqual(['earlier', 'later']);
  });

  it('자동 생성 자막이 같은 말을 되풀이하면 하나로 합친다', () => {
    const lines = normalizeScriptLines([
      { startSec: 1, endSec: 3, text: 'rolling caption' },
      { startSec: 2, endSec: 5, text: 'rolling caption' },
      { startSec: 6, text: 'next' }
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ startSec: 1, endSec: 5 });
  });
});

describe('스크립트 내보내기', () => {
  it('복사용 텍스트에는 시각이 앞에 붙는다', () => {
    const text = scriptToText([
      { startSec: 0, text: '시작' },
      { startSec: 3723, text: '한 시간 뒤' }
    ]);
    expect(text).toBe('[00:00:00] 시작\n[01:02:03] 한 시간 뒤');
  });

  it('시각 없이도 복사할 수 있다', () => {
    expect(scriptToText([{ startSec: 10, text: 'a' }], false)).toBe('a');
  });

  it('글자 수는 본문만 센다 (시각 표시는 빼고)', () => {
    expect(scriptCharCount([{ startSec: 0, text: '1234' }, { startSec: 1, text: '56' }])).toBe(6);
  });

  it('시각은 항상 시:분:초로 적는다', () => {
    expect(formatScriptClock(0)).toBe('00:00:00');
    expect(formatScriptClock(59.9)).toBe('00:00:59');
    expect(formatScriptClock(-5)).toBe('00:00:00');
  });
});
