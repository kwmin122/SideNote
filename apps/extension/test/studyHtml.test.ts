import { describe, expect, it } from 'vitest';
import { STUDY_RESPONSE_SCHEMA, buildStudyHtml, coerceStudyDoc, studyFileName, type StudyDoc } from '../src/ai/study';

const META = { pageUrl: 'https://example.com/watch?v=abc', generatedAt: Date.UTC(2026, 0, 2, 3, 4), sourceNote: '' };

const DOC: StudyDoc = {
  title: '선형대수 3강',
  summary: '고윳값과 고유벡터를 다룬다.',
  sections: [{ heading: '고윳값', points: ['Av = λv 를 만족하는 λ', '특성방정식으로 구한다'] }],
  terms: [{ term: '고유벡터', meaning: '방향이 변하지 않는 벡터' }],
  quiz: [{ question: '고윳값의 정의는?', answer: 'Av = λv 를 만족하는 스칼라' }]
};

describe('모델 답 다듬기', () => {
  it('제대로 된 JSON 문자열을 그대로 읽는다', () => {
    const doc = coerceStudyDoc(JSON.stringify(DOC), '대체 제목');
    expect(doc.title).toBe('선형대수 3강');
    expect(doc.sections[0].points).toHaveLength(2);
  });

  it('코드블록으로 감싸 와도 가운데 JSON 만 잘라 읽는다', () => {
    const wrapped = '```json\n' + JSON.stringify(DOC) + '\n```';
    expect(coerceStudyDoc(wrapped, '대체 제목').title).toBe('선형대수 3강');
  });

  it('앞뒤에 설명을 붙여 와도 읽는다', () => {
    const chatty = `네, 정리했습니다.\n${JSON.stringify(DOC)}\n도움이 되셨길 바랍니다.`;
    expect(coerceStudyDoc(chatty, '대체 제목').summary).toBe('고윳값과 고유벡터를 다룬다.');
  });

  it('JSON 이 아니면 제목만 남기고 빈 문서가 된다', () => {
    const doc = coerceStudyDoc('모르겠습니다', '대체 제목');
    expect(doc).toMatchObject({ title: '대체 제목', summary: '', sections: [], terms: [], quiz: [] });
  });

  it('제목이 비어 오면 강의 제목으로 채운다', () => {
    expect(coerceStudyDoc({ title: '  ', sections: [] }, '대체 제목').title).toBe('대체 제목');
  });

  it('빈 항목과 모양이 어긋난 항목은 버린다', () => {
    const doc = coerceStudyDoc(
      {
        title: 'x',
        sections: [{ heading: '', points: [] }, { heading: 'ok', points: ['a', '', 3] }],
        terms: [{ term: '', meaning: '버려짐' }, { term: '남음', meaning: '' }],
        quiz: [{ answer: '질문 없음' }, { question: '남는 질문', answer: '답' }]
      },
      '대체 제목'
    );
    expect(doc.sections).toEqual([{ heading: 'ok', points: ['a'] }]);
    expect(doc.terms).toEqual([{ term: '남음', meaning: '' }]);
    expect(doc.quiz).toEqual([{ question: '남는 질문', answer: '답' }]);
  });

  it('배열이 통째로 빠져 와도 빈 배열로 채운다', () => {
    expect(coerceStudyDoc({ title: 'x', summary: 'y' }, '대체 제목').terms).toEqual([]);
  });

  it('스키마는 제목·요약·소제목을 반드시 받도록 묶여 있다', () => {
    expect(STUDY_RESPONSE_SCHEMA.required).toEqual(['title', 'summary', 'sections']);
    expect(STUDY_RESPONSE_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('HTML 공부파일 만들기', () => {
  it('내용이 그대로 들어간다', () => {
    const html = buildStudyHtml(DOC, META);
    expect(html).toContain('선형대수 3강');
    expect(html).toContain('특성방정식으로 구한다');
    expect(html).toContain('고유벡터');
    expect(html).toContain('고윳값의 정의는?');
  });

  it('모델이 태그를 섞어 보내도 글자로만 들어간다', () => {
    const evil: StudyDoc = {
      ...DOC,
      title: '<script>alert(1)</script>',
      summary: 'a < b && c > d',
      sections: [{ heading: '<img src=x onerror=alert(1)>', points: ['<b>bold</b>'] }]
    };
    const html = buildStudyHtml(evil, META);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;&amp;');
  });

  it('주소도 태그로 새지 않는다', () => {
    const html = buildStudyHtml(DOC, { ...META, pageUrl: 'https://x.test/"><script>alert(1)</script>' });
    expect(html).not.toContain('"><script>');
  });

  it('바깥에서 무엇도 불러오지 않는다', () => {
    const html = buildStudyHtml(DOC, META);
    expect(html).not.toMatch(/<script\s/);
    expect(html).not.toMatch(/src="http/);
    expect(html).not.toMatch(/<link\s/);
  });

  it('퀴즈는 눌러야 답이 보인다', () => {
    const html = buildStudyHtml(DOC, META);
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>');
  });

  it('비어 있는 덩이는 아예 그리지 않는다', () => {
    const html = buildStudyHtml({ ...DOC, terms: [], quiz: [] }, META);
    expect(html).not.toContain('<details>');
    expect(html).not.toContain('Key terms');
  });
});

describe('파일 이름', () => {
  it('제목과 만든 시각이 들어간다', () => {
    const name = studyFileName('선형대수 3강', new Date(2026, 0, 2, 3, 4).getTime());
    expect(name).toMatch(/_study_20260102-0304\.html$/);
    expect(name.startsWith('선형대수 3강')).toBe(true);
  });

  it('파일 이름에 못 쓰는 글자는 걸러진다', () => {
    const name = studyFileName('a/b:c*d?', Date.now());
    expect(name).not.toMatch(/[/:*?]/);
  });

  it('제목이 비면 기본 제목으로 짓는다', () => {
    expect(studyFileName('   ', Date.now())).toMatch(/^Lecture_study_/);
  });
});
