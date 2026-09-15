/**
 * "HTML 공부파일 만들기". 모델에게 정해진 모양(JSON)으로 받아서, HTML 은 여기서 직접 그린다.
 *
 * 모델에게 HTML 을 통째로 쓰게 하지 않는 이유: 태그가 깨지거나 스크립트가 섞여 들어올 수 있고,
 * 그대로 파일로 저장하면 그게 곧 사용자가 여는 페이지가 된다. 값만 받아서 escape 해 넣으면 그런 일이 없다.
 */
import { escapeHtml, sanitizeFileName } from '../shared/export';
import { t, uiLanguage } from '../shared/i18n';

export interface StudySection {
  heading: string;
  points: string[];
}

export interface StudyTerm {
  term: string;
  meaning: string;
}

export interface StudyQuiz {
  question: string;
  answer: string;
}

export interface StudyDoc {
  title: string;
  summary: string;
  sections: StudySection[];
  terms: StudyTerm[];
  quiz: StudyQuiz[];
}

/** Prompt API 의 responseConstraint. 이 모양으로만 답하게 묶는다. */
export const STUDY_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['title', 'summary', 'sections'],
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['heading', 'points'],
        additionalProperties: false,
        properties: {
          heading: { type: 'string' },
          points: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    terms: {
      type: 'array',
      items: {
        type: 'object',
        required: ['term', 'meaning'],
        additionalProperties: false,
        properties: { term: { type: 'string' }, meaning: { type: 'string' } }
      }
    },
    quiz: {
      type: 'array',
      items: {
        type: 'object',
        required: ['question', 'answer'],
        additionalProperties: false,
        properties: { question: { type: 'string' }, answer: { type: 'string' } }
      }
    }
  }
} as const;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 모델 답을 화면에 띄울 수 있는 모양으로 다듬는다.
 * 스키마로 묶어 두어도 배열이 통째로 빠지거나 빈 문자열이 섞여 오는 일이 있어, 받는 쪽에서 한 번 더 거른다.
 * JSON 이 아예 아니면(코드블록으로 감싸서 오는 경우 등) 중괄호 구간만 잘라 다시 읽어 본다.
 */
export function coerceStudyDoc(value: unknown, fallbackTitle: string): StudyDoc {
  let raw: any = value;
  if (typeof raw === 'string') {
    const text = raw.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    try {
      raw = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
    } catch {
      raw = {};
    }
  }
  const sections = list(raw?.sections)
    .map((item: any) => ({
      heading: str(item?.heading),
      points: list(item?.points).map(str).filter(Boolean)
    }))
    .filter((section) => section.heading || section.points.length);
  const terms = list(raw?.terms)
    .map((item: any) => ({ term: str(item?.term), meaning: str(item?.meaning) }))
    .filter((term) => term.term);
  const quiz = list(raw?.quiz)
    .map((item: any) => ({ question: str(item?.question), answer: str(item?.answer) }))
    .filter((item) => item.question);
  return {
    title: str(raw?.title) || fallbackTitle,
    summary: str(raw?.summary),
    sections,
    terms,
    quiz
  };
}

export interface StudyMeta {
  pageUrl: string;
  generatedAt: number;
  /** 어떤 자료로 만들었는지 한 줄 설명(스크립트 N줄 / 자막 N줄 …). */
  sourceNote: string;
}

/**
 * 파일 하나로 끝나는 공부 자료를 만든다. 열면 그대로 읽히고, 퀴즈는 눌러야 답이 보인다.
 * 바깥에서 무엇도 불러오지 않는다(글꼴·스크립트·이미지 전부 없음).
 */
export function buildStudyHtml(doc: StudyDoc, meta: StudyMeta): string {
  const sections = doc.sections
    .map(
      (section) => `<section>
    <h2>${escapeHtml(section.heading)}</h2>
    <ul>${section.points.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ul>
  </section>`
    )
    .join('\n  ');

  const terms = doc.terms.length
    ? `<section>
    <h2>${escapeHtml(t('studyTerms'))}</h2>
    <dl>${doc.terms
      .map((term) => `<dt>${escapeHtml(term.term)}</dt><dd>${escapeHtml(term.meaning)}</dd>`)
      .join('')}</dl>
  </section>`
    : '';

  const quiz = doc.quiz.length
    ? `<section>
    <h2>${escapeHtml(t('studyQuiz'))}</h2>
    ${doc.quiz
      .map(
        (item) => `<details><summary>${escapeHtml(item.question)}</summary><p>${escapeHtml(item.answer)}</p></details>`
      )
      .join('')}
  </section>`
    : '';

  return `<!doctype html>
<html lang="${escapeHtml(uiLanguage())}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 32px; background: #f5f7fb; color: #1b2333;
         font: 15px/1.7 system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }
  main { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 6px; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  a { color: #2563eb; }
  .meta { color: #5b6579; font-size: 13px; margin: 0 0 24px; }
  section { background: #fff; border: 1px solid #e3e8f0; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .lead { white-space: pre-wrap; }
  ul { margin: 0; padding-left: 20px; }
  li { margin: 4px 0; }
  dl { margin: 0; }
  dt { font-weight: 600; margin-top: 10px; }
  dd { margin: 2px 0 0; color: #414b60; }
  details { border-top: 1px solid #eef1f6; padding: 10px 0; }
  details:first-of-type { border-top: 0; }
  summary { cursor: pointer; font-weight: 600; }
  details p { margin: 8px 0 0; color: #414b60; }
  footer { color: #8a93a6; font-size: 12px; text-align: center; padding: 8px 0 0; }
</style>
<main>
  <h1>${escapeHtml(doc.title)}</h1>
  <p class="meta">
    ${meta.pageUrl ? `<a href="${escapeHtml(meta.pageUrl)}">${escapeHtml(meta.pageUrl)}</a><br>` : ''}
    ${escapeHtml(t('studyGeneratedAt', new Date(meta.generatedAt).toLocaleString(uiLanguage())))}${
      meta.sourceNote ? ` · ${escapeHtml(meta.sourceNote)}` : ''
    }
  </p>
  ${doc.summary ? `<section><h2>${escapeHtml(t('studySummary'))}</h2><p class="lead">${escapeHtml(doc.summary)}</p></section>` : ''}
  ${sections}
  ${terms}
  ${quiz}
  <footer>${escapeHtml(t('studyFooter'))}</footer>
</main>
</html>`;
}

export function studyFileName(title: string, generatedAt: number): string {
  const d = new Date(generatedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const at = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${sanitizeFileName(title, t('defaultLectureTitle'))}_study_${at}.html`;
}
