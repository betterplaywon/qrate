import express, { type RequestHandler } from 'express';

// 콘솔 앱(React 빌드 산출물 index.html·assets/)의 정적 서빙. 서버가 같은 오리진의 /console/ 아래에서 내려준다(콘솔 결정 2026-11-04).
// 자산은 파일 이름에 해시가 있어 오래 캐시하고, index.html은 매번 재검증한다. 화면 상태는 해시 라우팅이라 SPA 폴백이 필요 없다.
// 로그인 전에도 문서는 내려간다 — 데이터는 전부 세션이 있어야 하는 API에서 온다.

/**
 * 콘솔 문서의 CSP. 대화창과 같은 default-src 'self'(번들은 /console/assets/의 파일, 인라인 없음) +
 * frame-ancestors 'none'(콘솔은 어디에도 iframe으로 들어가지 않는다 — 클릭재킹 방지) + base-uri 'none'.
 */
export const CONSOLE_CSP = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'";

export function consoleStatic(assetsDir: string): RequestHandler {
  return express.static(assetsDir, {
    index: 'index.html',
    maxAge: '1y',
    immutable: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Security-Policy', CONSOLE_CSP);
      }
    },
  });
}
