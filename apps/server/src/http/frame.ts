import type { ApiErrorBody } from '@qrate/contracts';
import type { RequestHandler } from 'express';
import { isOriginString } from '../origin.js';
import type { Repositories } from '../repo/types.js';

// GET /frame?t=<테넌트 키>&o=<고객 사이트 오리진> — 고객 사이트의 런처가 iframe으로 여는 대화창 문서.
// "이 테넌트의 위젯을 어느 사이트에 넣을 수 있는가"는 이 응답의 CSP 헤더가 결정하고, 브라우저가 강제한다.
// 허용되지 않은 사이트가 iframe으로 넣으면 브라우저가 문서를 그리지 않는다(요청은 가지만 렌더링이 거부된다).
//
// o(부모 오리진)는 런처가 자기 location.origin을 적어 보낸다. 테넌트의 allowedOrigins에 있을 때만 대화창을 내려주고,
// 대화창 앱은 그 값으로만 postMessage를 보내고 받는다(packages/widget/src/frame/main.ts). 꾸민 값은 CSP가 아니라
// 이 검사가 거른다 — 허용 목록 밖의 값이면 빈 iframe 대신 안내 문서(403)를 보인다.
//
// 대화창의 스크립트·스타일은 /frame/app.js·/frame/app.css 정적 파일이다(위젯 패키지 빌드 산출물, app.ts의 express.static).
// CSP default-src 'self'가 인라인 스크립트를 막기 때문이고, 문서에는 데이터를 심지 않는다(심으려면 이스케이프가 필요하다).

/**
 * 대화창 문서의 CSP.
 * - frame-ancestors: 이 문서를 iframe으로 넣을 수 있는 부모 페이지의 오리진. 테넌트의 allowedOrigins가 그대로 들어간다.
 *   비어 있으면 'none' — 어느 사이트에도 넣을 수 없다. 열어 두는 쪽이 아니라 닫아 두는 쪽이 기본값이다.
 * - default-src 'self': 문서 자신의 스크립트·스타일·fetch는 이 서버 오리진에서만. 인라인 스크립트는 못 쓴다.
 * X-Frame-Options는 두지 않는다. 허용 목록을 표현할 수 없고, frame-ancestors가 있으면 브라우저가 무시한다.
 */
export function frameCsp(allowedOrigins: readonly string[]): string {
  const ancestors = allowedOrigins.length > 0 ? allowedOrigins.join(' ') : "'none'";
  return `default-src 'self'; frame-ancestors ${ancestors}`;
}

const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="stylesheet" href="/frame/app.css">`;

const FRAME_HTML = `<!doctype html>
<html lang="ko">
<head>
${HEAD}
<title>Qrate 상담</title>
<script src="/frame/app.js" defer></script>
</head>
<body>
<div id="app"></div>
<noscript><p class="notice-page">상담 창을 쓰려면 JavaScript가 필요해요.</p></noscript>
</body>
</html>
`;

// 허용되지 않은 사이트(또는 o 없이 직접 연 경우)에 보이는 안내. 스크립트가 없고 데이터도 없다.
const NOT_ALLOWED_HTML = `<!doctype html>
<html lang="ko">
<head>
${HEAD}
<title>Qrate</title>
</head>
<body>
<p class="notice-page">이 사이트에서는 상담 창을 열 수 없어요. 사이트 운영자에게 알려 주세요.</p>
</body>
</html>
`;

export function createFrameHandler({ repos }: { repos: Repositories }): RequestHandler {
  return async (req, res) => {
    const key = typeof req.query.t === 'string' && req.query.t ? req.query.t : null;
    if (!key) {
      res.status(400).json({ error: 'tenant is required' } satisfies ApiErrorBody);
      return;
    }
    const tenant = await repos.tenants.findByKey(key);
    if (!tenant) {
      res.status(404).json({ error: 'unknown_tenant' } satisfies ApiErrorBody);
      return;
    }
    res.setHeader('Content-Security-Policy', frameCsp(tenant.allowedOrigins));
    // 허용 사이트 목록은 바뀔 수 있고(W3 콘솔) 이 응답의 CSP가 곧 그 목록이므로, 중간 캐시에 남지 않게 한다.
    res.setHeader('Cache-Control', 'no-store');

    const parentOrigin = typeof req.query.o === 'string' ? req.query.o : '';
    if (!isOriginString(parentOrigin) || !tenant.allowedOrigins.includes(parentOrigin)) {
      res.status(403).type('html').send(NOT_ALLOWED_HTML);
      return;
    }
    res.type('html').send(FRAME_HTML);
  };
}
