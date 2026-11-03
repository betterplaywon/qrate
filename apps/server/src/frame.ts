import type { RequestHandler } from 'express';
import type { Repositories } from './repo/types.js';

// GET /frame?t=<테넌트 키> — 고객 사이트의 런처가 iframe으로 여는 대화창 문서.
// "이 테넌트의 위젯을 어느 사이트에 넣을 수 있는가"는 이 응답의 CSP 헤더가 결정하고, 브라우저가 강제한다.
// 허용되지 않은 사이트가 iframe으로 넣으면 브라우저가 문서를 그리지 않는다(요청은 가지만 렌더링이 거부된다).

/**
 * 대화창 문서의 CSP.
 * - frame-ancestors: 이 문서를 iframe으로 넣을 수 있는 부모 페이지의 오리진. 테넌트의 allowedOrigins가 그대로 들어간다.
 *   비어 있으면 'none' — 어느 사이트에도 넣을 수 없다. 열어 두는 쪽이 아니라 닫아 두는 쪽이 기본값이다.
 * - default-src 'self': 문서 자신의 스크립트·스타일·fetch는 이 서버 오리진에서만. 인라인 스크립트는 못 쓴다 —
 *   5단계(위젯 분리)의 대화창 앱이 지켜야 할 제약을 지금 고정한다.
 * X-Frame-Options는 두지 않는다. 허용 목록을 표현할 수 없고, frame-ancestors가 있으면 브라우저가 무시한다.
 */
export function frameCsp(allowedOrigins: readonly string[]): string {
  const ancestors = allowedOrigins.length > 0 ? allowedOrigins.join(' ') : "'none'";
  return `default-src 'self'; frame-ancestors ${ancestors}`;
}

// 5단계에서 빌드된 대화창 앱으로 바뀐다. 지금은 헤더 계약(400·404·CSP·캐시)만 고정한다.
// 테넌트 이름 등 데이터는 넣지 않는다 — 넣을 때는 이스케이프가 필요하고, 그 작업은 대화창 앱의 몫이다.
const FRAME_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Qrate</title>
</head>
<body>
<p>대화창은 위젯 분리 단계에서 이 문서에 들어갑니다.</p>
</body>
</html>
`;

export function createFrameHandler({ repos }: { repos: Repositories }): RequestHandler {
  return async (req, res) => {
    const key = typeof req.query.t === 'string' && req.query.t ? req.query.t : null;
    if (!key) {
      res.status(400).json({ error: 'tenant is required' });
      return;
    }
    const tenant = await repos.tenants.findByKey(key);
    if (!tenant) {
      res.status(404).json({ error: 'unknown_tenant' });
      return;
    }
    res.setHeader('Content-Security-Policy', frameCsp(tenant.allowedOrigins));
    // 허용 사이트 목록은 바뀔 수 있고(W3 콘솔) 이 응답의 CSP가 곧 그 목록이므로, 중간 캐시에 남지 않게 한다.
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(FRAME_HTML);
  };
}
