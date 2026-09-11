/**
 * 설치 화면에 뜨는 경고 문구와 웹스토어 심사 시간이 이 파일 하나로 갈린다.
 * 넓은 host_permissions 가 다시 들어오면 "방문하는 모든 웹사이트의 데이터 읽기/변경" 경고가 살아나고,
 * 대시보드가 "광범위한 호스트 권한 - 자세한 검토가 필요할 수 있습니다" 로 게시를 늦춘다.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// happy-dom 환경에서는 import.meta.url 이 file: 이 아니다. vitest 는 apps/extension 에서 돈다.
const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'public/manifest.json'), 'utf-8')) as {
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
};

describe('manifest 권한', () => {
  it('넓은 호스트 권한을 선언하지 않는다', () => {
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.optional_host_permissions ?? []).toEqual([]);
  });

  it('페이지 접근은 activeTab 으로만 받는다', () => {
    expect(manifest.permissions).toContain('activeTab');
  });

  it('스토어에 사유를 적어 둔 7개 권한만 있다', () => {
    expect([...(manifest.permissions ?? [])].sort()).toEqual(
      ['activeTab', 'offscreen', 'scripting', 'sidePanel', 'storage', 'tabCapture', 'tabs'].sort()
    );
  });
});
