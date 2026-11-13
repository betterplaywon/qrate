import { describe, expect, it } from 'vitest';
import { frameCsp } from '../src/http/frame.js';
import { isAllowedOrigin, parseOrigin } from '../src/origin.js';

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
