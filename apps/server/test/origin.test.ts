import { describe, expect, it } from 'vitest';
import { frameCsp } from '../src/http/frame.js';
import { isAllowedOrigin, isOriginString, parseOrigin } from '../src/origin.js';

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

describe('QRATE_PUBLIC_ORIGIN 해석', () => {
  it('오리진으로 정규화한다 — 경로·쿼리·대문자 제거', () => {
    expect(parseOrigin('http://localhost:8787')).toBe('http://localhost:8787');
    expect(parseOrigin('https://Widget.Example.com/anything?x=1')).toBe('https://widget.example.com');
  });

  it('URL이 아니거나 http(s)가 아니면 시작 시점에 실패한다', () => {
    expect(() => parseOrigin('')).toThrow(/URL이 아님/);
    expect(() => parseOrigin('localhost:8787')).toThrow(/http\(s\)/);
    expect(() => parseOrigin('file:///tmp/x')).toThrow(/http\(s\)/);
  });
});

describe('Origin 헤더 검사 (POST /api/chat 앞)', () => {
  const own = 'http://localhost:8787';

  it('헤더가 없으면(브라우저 밖 호출) 통과', () => {
    expect(isAllowedOrigin(undefined, own)).toBe(true);
  });

  it('서버 자신의 오리진(iframe 문서)은 통과', () => {
    expect(isAllowedOrigin('http://localhost:8787', own)).toBe(true);
  });

  it('다른 오리진, null, 변형은 거부', () => {
    expect(isAllowedOrigin('http://localhost:5173', own)).toBe(false);
    expect(isAllowedOrigin('null', own)).toBe(false);
    expect(isAllowedOrigin('http://localhost:8787/', own)).toBe(false);
    expect(isAllowedOrigin('http://localhost:8787.evil.example', own)).toBe(false);
    expect(isAllowedOrigin('https://localhost:8787', own)).toBe(false);
  });
});

describe('대화창 문서 CSP', () => {
  it('허용 사이트를 frame-ancestors로 나열하고, 자원은 서버 자신에게서만', () => {
    expect(frameCsp(['http://localhost:5173', 'https://shop.example.com'])).toBe(
      "default-src 'self'; frame-ancestors http://localhost:5173 https://shop.example.com; base-uri 'none'; form-action 'none'; object-src 'none'",
    );
  });

  it("허용 사이트가 없으면 'none' — 어디에도 넣을 수 없다", () => {
    expect(frameCsp([])).toBe("default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'");
  });
});
