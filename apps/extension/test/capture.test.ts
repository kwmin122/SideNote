import { describe, expect, it } from 'vitest';
import { captureTypeFor, computeCropRect, pickVideoFromFrames } from '../src/shared/capture';
import { pageKeyOf } from '../src/shared/url';

describe('캡처 crop 계산', () => {
  it('devicePixelRatio 를 반영해 물리 픽셀 좌표로 변환한다', () => {
    const crop = computeCropRect({ x: 100, y: 50, width: 640, height: 360, dpr: 2 }, 2880, 1800);
    expect(crop).toEqual({ sx: 200, sy: 100, sw: 1280, sh: 720 });
  });

  it('영상 영역이 이미지 밖으로 나가면 이미지 경계까지만 자른다', () => {
    const crop = computeCropRect({ x: 0, y: 0, width: 2000, height: 2000, dpr: 1 }, 1280, 720);
    expect(crop).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
  });

  it('영상 정보가 없으면 null → 뷰포트 전체로 폴백한다', () => {
    expect(computeCropRect(null, 1280, 720)).toBeNull();
    expect(computeCropRect(undefined, 1280, 720)).toBeNull();
    expect(computeCropRect({ x: 0, y: 0, width: 0, height: 0, dpr: 1 }, 1280, 720)).toBeNull();
  });

  it('스크롤로 영상이 화면 밖에 있으면 crop 하지 않는다', () => {
    expect(computeCropRect({ x: 1270, y: 715, width: 640, height: 360, dpr: 1 }, 1280, 720)).toBeNull();
  });

  it('crop 성공 여부가 captureType 을 결정한다', () => {
    expect(captureTypeFor(true)).toBe('VIDEO_REGION');
    expect(captureTypeFor(false)).toBe('VIEWPORT');
  });
});

describe('프레임별 영상 탐색 결과 선택', () => {
  const top = { x: 10, y: 20, width: 640, height: 360, dpr: 2, videoTimeSec: 30 };
  const inner = { x: 0, y: 0, width: 800, height: 450, dpr: 2, videoTimeSec: 763.5 };

  it('최상위 프레임에 영상이 있으면 그 좌표로 자른다', () => {
    expect(pickVideoFromFrames([{ frameId: 0, result: top }, { frameId: 7, result: inner }])).toEqual({ topRect: top, anyVideo: top });
  });

  it('iframe 플레이어만 있으면 좌표는 버리고 재생 위치만 쓴다', () => {
    const picked = pickVideoFromFrames([{ frameId: 0, result: null }, { frameId: 7, result: inner }]);
    expect(picked.topRect).toBeNull();
    expect(picked.anyVideo?.videoTimeSec).toBe(763.5);
  });

  it('어느 프레임에도 영상이 없으면 둘 다 null 이다', () => {
    expect(pickVideoFromFrames([{ frameId: 0, result: null }])).toEqual({ topRect: null, anyVideo: null });
    expect(pickVideoFromFrames([])).toEqual({ topRect: null, anyVideo: null });
  });
});

describe('세션 복원 키', () => {
  it('쿼리스트링과 해시가 달라도 같은 강의 페이지로 본다', () => {
    expect(pageKeyOf('https://www.youtube.com/watch?v=abc&t=10')).toBe(pageKeyOf('https://www.youtube.com/watch?v=abc'));
  });

  it('경로가 다르면 다른 세션이다', () => {
    expect(pageKeyOf('https://lms.ac.kr/course/1')).not.toBe(pageKeyOf('https://lms.ac.kr/course/2'));
  });

  it('잘못된 URL 도 예외 없이 처리한다', () => {
    expect(pageKeyOf('not a url')).toBe('not a url');
    expect(pageKeyOf(undefined)).toBe('about:blank');
  });
});
