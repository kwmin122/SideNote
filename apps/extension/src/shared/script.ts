/**
 * 영상에 원래 들어 있는 자막(스크립트)을 다루는 순수 함수 모음.
 *
 * 페이지에서 긁어 오는 일 자체는 background 가 chrome.scripting 으로 시킨다(주입 함수는 import 를 못 쓴다).
 * 고르기·파싱·다듬기처럼 틀리면 바로 티가 나는 부분만 여기 모아 두고 단위 테스트한다.
 */
import type { CaptionTrackInfo, ScriptLine } from './contracts';

/** 페이지에서 읽어 온 자막 트랙 한 줄. baseUrl 은 그 페이지와 같은 출처라 페이지가 직접 받아야 한다. */
export interface RawCaptionTrack {
  lang: string;
  label: string;
  baseUrl: string;
  /** 자동 생성 자막이면 'asr'. */
  kind?: string;
}

function baseLang(code: string): string {
  return String(code ?? '').toLowerCase().split('-')[0];
}

/**
 * 어떤 트랙을 가져올지 고른다.
 * 1) 사용자가 고른 언어와 정확히 같은 것 → 2) 같은 언어(지역 표기 무시)
 * 3) 화면 언어와 같은 것 → 4) 사람이 올린 자막(자동 생성이 아닌 것) → 5) 첫 번째
 *
 * 자동 생성 자막을 뒤로 미루는 이유는 같은 언어가 둘 다 있을 때 사람이 단 자막이 훨씬 정확하기 때문이다.
 */
export function pickCaptionTrack(
  tracks: RawCaptionTrack[],
  prefer = '',
  uiLang = ''
): RawCaptionTrack | undefined {
  const usable = tracks.filter((track) => track && typeof track.baseUrl === 'string' && track.baseUrl);
  if (!usable.length) return undefined;
  const human = (track: RawCaptionTrack) => (track.kind === 'asr' ? 1 : 0);
  const byLang = (code: string) => {
    if (!code) return undefined;
    const exact = usable.filter((track) => track.lang.toLowerCase() === code.toLowerCase());
    const loose = usable.filter((track) => baseLang(track.lang) === baseLang(code));
    const pool = exact.length ? exact : loose;
    return [...pool].sort((a, b) => human(a) - human(b))[0];
  };
  return byLang(prefer) ?? byLang(uiLang) ?? [...usable].sort((a, b) => human(a) - human(b))[0];
}

/** 화면에 보여 줄 트랙 목록(주소는 뺀다). */
export function trackInfo(tracks: RawCaptionTrack[]): CaptionTrackInfo[] {
  return tracks
    .filter((track) => track && track.baseUrl)
    .map((track) => ({ lang: track.lang, label: track.label, kind: track.kind }));
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
}

/**
 * timedtext 의 json3 응답을 줄 목록으로 바꾼다.
 * 문자열을 받는 이유는 이 응답을 페이지가 대신 받아 오기 때문이다(확장에는 그 호스트 권한이 없다).
 */
export function parseJson3(text: string): ScriptLine[] {
  let parsed: { events?: Json3Event[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const events = Array.isArray(parsed?.events) ? parsed.events : [];
  const lines: ScriptLine[] = [];
  for (const event of events) {
    if (!Array.isArray(event?.segs)) continue;
    const body = event.segs.map((seg) => seg?.utf8 ?? '').join('');
    const startSec = Number(event.tStartMs ?? 0) / 1000;
    if (!Number.isFinite(startSec)) continue;
    const durSec = Number(event.dDurationMs ?? 0) / 1000;
    lines.push({ startSec, endSec: Number.isFinite(durSec) && durSec > 0 ? startSec + durSec : undefined, text: body });
  }
  return normalizeScriptLines(lines);
}

/**
 * 줄을 다듬는다. 자동 생성 자막은 같은 말을 여러 번 겹쳐 보내고(굴러가는 자막), 줄바꿈이 섞여 들어온다.
 * - 공백/줄바꿈을 한 칸으로 정리하고 빈 줄은 버린다
 * - 시간순으로 세운다
 * - 바로 앞 줄과 글자가 같으면 하나로 합친다(끝 시각만 늘린다)
 */
export function normalizeScriptLines(lines: ScriptLine[]): ScriptLine[] {
  const cleaned = lines
    .map((line) => ({
      startSec: Math.max(0, Number(line?.startSec ?? 0)),
      endSec: Number.isFinite(Number(line?.endSec)) ? Number(line?.endSec) : undefined,
      text: String(line?.text ?? '').replace(/\s+/g, ' ').trim()
    }))
    .filter((line) => line.text.length > 0 && Number.isFinite(line.startSec))
    .sort((a, b) => a.startSec - b.startSec);

  const out: ScriptLine[] = [];
  for (const line of cleaned) {
    const prev = out[out.length - 1];
    if (prev && prev.text === line.text) {
      prev.endSec = Math.max(prev.endSec ?? prev.startSec, line.endSec ?? line.startSec);
      continue;
    }
    out.push(line);
  }
  return out;
}

/** 00:12:43 형태. 스크립트는 강의 재생 위치가 기준이라 항상 시:분:초로 적는다. */
export function formatScriptClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** 통째로 복사하기용 텍스트. 시각을 앞에 달아 영상과 맞춰 보게 한다. */
export function scriptToText(lines: ScriptLine[], withClock = true): string {
  return lines
    .map((line) => (withClock ? `[${formatScriptClock(line.startSec)}] ${line.text}` : line.text))
    .join('\n');
}

/** 스크립트 전체 글자 수. 화면에 "얼마나 긴 강의인지" 보여 주는 데 쓴다. */
export function scriptCharCount(lines: ScriptLine[]): number {
  return lines.reduce((sum, line) => sum + line.text.length, 0);
}
