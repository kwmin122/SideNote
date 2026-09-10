/**
 * 캡처/메모/자막을 밖으로 내보내기 위한 순수 함수 모음.
 * 화면 문구만 _locales 에서 가져오고, 나머지는 그대로 단위 테스트할 수 있다.
 */
import { t, uiLanguage } from './i18n';

/** 00:12:43. 재생 위치 표기. */
export function formatClock(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 파일 이름에 못 쓰는 문자를 걷어낸다. 한글은 그대로 둔다. */
export function sanitizeFileName(name: string, fallback = 'lecture'): string {
  const cleaned = (name ?? '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export interface ExportCaptureMeta {
  title: string;
  pageUrl?: string;
  videoTimeSec?: number;
  memo: string;
  createdAt: number;
}

/** 캡처 1건의 파일 이름. 재생 위치를 알면 그걸 쓰고, 모르면 캡처 시각을 쓴다. */
export function captureFileName(meta: ExportCaptureMeta, ext = 'png'): string {
  const at = meta.videoTimeSec != null ? formatClock(meta.videoTimeSec).replace(/:/g, '-') : stamp(meta.createdAt);
  return `${sanitizeFileName(meta.title, t('defaultLectureTitle'))}_${at}.${ext}`;
}

/** 이미지를 못 붙이는 곳(메모장 등)에 대비한 보조 텍스트. */
export function captureClipboardText(meta: ExportCaptureMeta): string {
  const lines = [meta.title];
  if (meta.videoTimeSec != null) lines.push(t('playbackPos', formatClock(meta.videoTimeSec)));
  if (meta.pageUrl) lines.push(meta.pageUrl);
  lines.push('', meta.memo.trim() || t('noMemo'));
  return lines.join('\n');
}

/**
 * 캔버스 폭에 맞춰 줄바꿈한다. 실제 글자 폭 계산은 호출측(캔버스)이 넘긴다.
 * 한국어는 공백 없이 길게 이어지는 경우가 많아 단어가 넘치면 글자 단위로도 자른다.
 */
export function wrapTextByWidth(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (!paragraph.trim()) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = word;
      while (measure(line) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut -= 1;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ExportCapture {
  /** data:image/png;base64,... 형태. HTML 안에 그대로 박아 파일 하나로 만든다.
   *  비어 있으면 이미지 없는 메모 항목이다(메모만 남긴 노트 / 이미지가 사라진 캡처). */
  dataUrl: string;
  memo: string;
  videoTimeSec?: number;
  createdAt: number;
  captureType?: string;
}

export interface ExportBundle {
  title: string;
  pageUrl: string;
  generalMemo: string;
  transcripts: { startedAtMs: number; text: string; translation?: string }[];
  captures: ExportCapture[];
  exportedAt: number;
}

function elapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** 강의 하나를 파일 한 개로 묶는다. 이미지가 data URI 라 브라우저로 열면 그대로 보인다. */
export function buildSessionHtml(bundle: ExportBundle): string {
  const shots = bundle.captures
    .map((capture, index) => {
      const time = capture.videoTimeSec != null ? formatClock(capture.videoTimeSec) : '';
      // 이미지 없는 메모 항목도 반드시 남긴다. img 만 빼고 나머지는 캡처와 똑같이 그린다.
      const label = capture.dataUrl ? t('exportCaptureN', index + 1) : t('exportMemoN', index + 1);
      return [
        '<figure class="shot">',
        capture.dataUrl ? `<img src="${escapeHtml(capture.dataUrl)}" alt="${escapeHtml(t('exportCaptureN', index + 1))}">` : '',
        '<figcaption>',
        `<span class="chip">${escapeHtml(label)}${time ? ` · ${escapeHtml(time)}` : ''}</span>`,
        `<p>${escapeHtml(capture.memo.trim() || t('noMemo'))}</p>`,
        '</figcaption>',
        '</figure>'
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  const lines = bundle.transcripts
    .map((item) => {
      const translated = item.translation?.trim()
        ? `<span class="translated">${escapeHtml(item.translation.trim())}</span>`
        : '';
      return `<li><time>${escapeHtml(elapsed(item.startedAtMs))}</time><span>${escapeHtml(item.text)}${translated}</span></li>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="${escapeHtml(uiLanguage())}">
<meta charset="utf-8">
<title>${escapeHtml(t('exportDocTitle', bundle.title))}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 32px; background: #f5f7fb; color: #1b2333;
         font: 15px/1.6 system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }
  main { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 32px 0 12px; }
  a { color: #2563eb; }
  .meta { color: #5b6579; font-size: 13px; margin: 0 0 24px; }
  section { background: #fff; border: 1px solid #e3e8f0; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  .memo { white-space: pre-wrap; }
  .shot { margin: 0 0 24px; }
  .shot img { width: 100%; border-radius: 10px; border: 1px solid #e3e8f0; display: block; }
  .shot figcaption { padding-top: 10px; }
  .shot img + figcaption { padding-top: 10px; }
  .shot > figcaption:first-child { padding-top: 0; }
  .chip { display: inline-block; background: #e8efff; color: #2563eb; border-radius: 999px;
          padding: 2px 10px; font-size: 12px; font-weight: 600; }
  .shot figcaption p { white-space: pre-wrap; margin: 8px 0 0; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid #eef1f6; }
  li time { color: #2563eb; font-variant-numeric: tabular-nums; font-size: 13px; flex: 0 0 52px; }
  li .translated { display: block; margin-top: 2px; color: #2563eb; }
  .empty { color: #8a93a6; }
</style>
<main>
  <h1>${escapeHtml(bundle.title)}</h1>
  <p class="meta">
    ${bundle.pageUrl ? `<a href="${escapeHtml(bundle.pageUrl)}">${escapeHtml(bundle.pageUrl)}</a><br>` : ''}
    ${escapeHtml(t('exportExportedAt', new Date(bundle.exportedAt).toLocaleString(uiLanguage())))} ·
    ${escapeHtml(
      t(
        'exportSummary',
        bundle.captures.filter((c) => c.dataUrl).length,
        bundle.captures.filter((c) => !c.dataUrl).length,
        bundle.transcripts.length
      )
    )}
  </p>

  <section>
    <h2 style="margin-top:0">${escapeHtml(t('exportMyNotes'))}</h2>
    <div class="memo">${
      bundle.generalMemo.trim()
        ? escapeHtml(bundle.generalMemo)
        : `<span class="empty">${escapeHtml(t('exportNoNotes'))}</span>`
    }</div>
  </section>

  <section>
    <h2 style="margin-top:0">${escapeHtml(t('exportCaptures'))}</h2>
    ${shots || `<p class="empty">${escapeHtml(t('exportNoCaptures'))}</p>`}
  </section>

  <section>
    <h2 style="margin-top:0">${escapeHtml(t('exportTranscript'))}</h2>
    ${lines ? `<ul>\n${lines}\n</ul>` : `<p class="empty">${escapeHtml(t('exportNoTranscript'))}</p>`}
  </section>
</main>
</html>`;
}

/** 전체 저장 파일 이름. */
export function bundleFileName(title: string, exportedAt: number): string {
  return `${sanitizeFileName(title, t('defaultLectureTitle'))}_${stamp(exportedAt)}.html`;
}
