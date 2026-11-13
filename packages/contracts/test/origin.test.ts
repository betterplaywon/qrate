import { describe, expect, it } from 'vitest';
import { isOriginString } from '../src/index.js';

describe('오리진 문자열 검증 (테넌트 allowedOrigins → CSP 헤더에 그대로 들어간다)', () => {
  it('정규형만 통과: 소문자, 기본 포트 생략, 경로·슬래시·와일드카드 없음', () => {
    expect(isOriginString('http://localhost:5173')).toBe(true);
    expect(isOriginString('https://shop.example.com')).toBe(true);
    expect(isOriginString('https://shop.example.com:8443')).toBe(true);

    expect(isOriginString('https://shop.example.com/')).toBe(false);
    expect(isOriginString('https://shop.example.com/path')).toBe(false);
    expect(isOriginString('HTTPS://shop.example.com')).toBe(false);
    expect(isOriginString('https://shop.example.com:443')).toBe(false);
    expect(isOriginString('https://*.example.com')).toBe(false);
    expect(isOriginString('ftp://example.com')).toBe(false);
    expect(isOriginString('shop.example.com')).toBe(false);
    expect(isOriginString('')).toBe(false);
  });

  it('CSP 지시어를 끼워 넣으려는 값은 거부한다', () => {
    expect(isOriginString("https://a.example.com; script-src 'unsafe-inline'")).toBe(false);
    expect(isOriginString('https://a.example.com https://b.example.com')).toBe(false);
  });

  it('URL 파서가 그대로 두는 호스트 글자(; , 따옴표 _ 끝 점 IPv6)와 포트 0은 CSP 호스트 문법 밖이라 거부한다', () => {
    // 모두 new URL(v).origin === v가 성립해 예전 검사를 지나갔다. frame-ancestors에 들어가면 지시어가 끼어든다.
    for (const v of [
      'https://example.com;',
      'https://example.com;sandbox',
      'https://a.com,b.com',
      "https://'self'",
      'https://x"onerror=alert(1)',
      'https://example.com.',
      'https://[::1]:8443',
      'https://a_b.example',
      'https://example.com:0',
    ]) {
      expect(isOriginString(v), v).toBe(false);
    }
    expect(isOriginString('https://xn--bcher-kva.example')).toBe(true); // 한글·유니코드 도메인은 퓨니코드로 받는다
    expect(isOriginString('http://127.0.0.1:5173')).toBe(true);
  });
});
