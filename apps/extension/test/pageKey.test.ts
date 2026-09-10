import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { pageKeyOf } from '../src/shared/url';
import { StudyDb } from '../src/storage/db';

/**
 * 사용자가 실제로 겪은 증상: 유튜브에서 다른 영상을 틀어도 앞 영상 자막이 그대로 남아 있었다.
 * 원인은 세션 키가 origin + 경로뿐이라 /watch?v=AAA 와 /watch?v=BBB 가 같은 키였던 것.
 */
describe('세션 키(pageKey)', () => {
  it('유튜브에서 영상이 바뀌면 키도 달라진다', () => {
    const a = pageKeyOf('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    const b = pageKeyOf('https://www.youtube.com/watch?v=BBBBBBBBBBB');
    expect(a).not.toBe(b);
  });

  it('같은 영상이면 재생 위치(t)·재생목록(list) 이 붙어도 같은 키다', () => {
    const plain = pageKeyOf('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    expect(pageKeyOf('https://www.youtube.com/watch?v=AAAAAAAAAAA&t=903s')).toBe(plain);
    expect(pageKeyOf('https://www.youtube.com/watch?list=PL123&v=AAAAAAAAAAA&index=4')).toBe(plain);
  });

  it('유튜브 계열 주소(m., -nocookie) 도 영상별로 갈린다', () => {
    expect(pageKeyOf('https://m.youtube.com/watch?v=AAA')).not.toBe(pageKeyOf('https://m.youtube.com/watch?v=BBB'));
    expect(pageKeyOf('https://www.youtube-nocookie.com/watch?v=AAA')).not.toBe(
      pageKeyOf('https://www.youtube-nocookie.com/watch?v=BBB')
    );
  });

  it('유튜브가 아닌 강의 사이트는 예전과 똑같이 경로만 본다', () => {
    // 유데미·인프런처럼 강의마다 경로가 다른 사이트는 쿼리를 무시해야 새로고침·이어보기에서 노트가 유지된다.
    expect(pageKeyOf('https://www.udemy.com/course/python/learn/lecture/12?start=0')).toBe(
      'https://www.udemy.com/course/python/learn/lecture/12'
    );
    expect(pageKeyOf('https://www.udemy.com/course/python/learn/lecture/12')).not.toBe(
      pageKeyOf('https://www.udemy.com/course/python/learn/lecture/13')
    );
  });

  it('유튜브라도 v 가 없으면(홈·쇼츠) 경로만으로 구분한다', () => {
    expect(pageKeyOf('https://www.youtube.com/')).toBe('https://www.youtube.com');
    expect(pageKeyOf('https://www.youtube.com/shorts/XYZ')).toBe('https://www.youtube.com/shorts/XYZ');
    expect(pageKeyOf('https://www.youtube.com/shorts/XYZ')).not.toBe(pageKeyOf('https://www.youtube.com/shorts/ABC'));
  });

  it('주소가 없거나 파싱할 수 없어도 던지지 않는다', () => {
    expect(pageKeyOf(undefined)).toBe('about:blank');
    expect(pageKeyOf('')).toBe('about:blank');
    // URL 로 못 읽는 문자열은 예전처럼 그대로 키가 된다(강의 페이지가 아니므로 굳이 나누지 않는다).
    expect(pageKeyOf('그냥 문자열')).toBe('그냥 문자열');
  });
});

/**
 * 키 규칙이 바뀌면 이미 저장된 노트의 pageKey 가 옛 규칙 그대로 남는다.
 * 그대로 두면 예전 유튜브 노트를 다시 찾지 못하고 빈 노트가 생긴다. v3 upgrade 가 이것을 막는다.
 */
describe('DB v3 업그레이드', () => {
  it('예전에 저장된 세션의 pageKey 를 새 규칙으로 다시 계산한다', async () => {
    const name = `upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(2).stores({
      sessions: 'id, pageKey, tabOrigin, updatedAt',
      transcripts: 'id, sessionId, sequence, [sessionId+sequence]',
      captures: 'id, sessionId, createdAt, imageBlobId',
      imageBlobs: 'id, createdAt'
    });
    await legacy.open();
    await legacy.table('sessions').add({
      id: 'old-1',
      pageKey: 'https://www.youtube.com/watch', // 옛 규칙(모든 영상이 이 키 하나였다)
      tabOrigin: 'https://www.youtube.com',
      pageUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
      pageTitle: 'ROS2 강의 1',
      createdAt: 1,
      updatedAt: 1,
      status: 'STOPPED',
      generalMemo: '지난 메모'
    });
    legacy.close();

    const upgraded = new StudyDb(name);
    await upgraded.open();
    const row = await upgraded.sessions.get('old-1');
    expect(row?.pageKey).toBe('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    expect(row?.generalMemo).toBe('지난 메모'); // 내용은 그대로
    upgraded.close();
  });
});
