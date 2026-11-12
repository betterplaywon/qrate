import type { ApiErrorBody } from '@qrate/contracts';
import type { RequestHandler } from 'express';

// 오리진(origin) = scheme://host[:port]. 브라우저가 "같은 오리진끼리만 자유롭게 통신"하게 두는 경계의 단위다.
//
// 테넌트 검증 단계(ADR-0003 하이브리드)에서 이 서버가 쓰는 오리진 규칙 세 가지:
//   1. 대화 API(POST /api/chat)를 부르는 브라우저 문서는 이 서버 오리진의 iframe 하나뿐이다.
//      → 다른 오리진의 Origin 헤더는 403. CORS 헤더는 아예 내지 않는다(W1의 전체 허용 제거).
//   2. 어느 고객 사이트가 그 iframe을 넣을 수 있는지는 GET /frame 응답의 CSP frame-ancestors로 브라우저가 강제한다. (http/frame.ts)
//   3. 테넌트의 allowedOrigins는 CSP 헤더에 글자 그대로 들어가므로 정규형 오리진 문자열만 받는다(헤더 인젝션·오타 방지).
//      그 문법은 콘솔 미리보기와 함께 쓰려고 계약에 있다(@qrate/contracts의 isOriginString).
//
// 이 검사로 막지 못하는 것: 브라우저 밖(curl, 스크립트)에서 공개 테넌트 키로 부르는 호출. Origin은 꾸밀 수 있는 헤더다.
// 그쪽은 요율 제한·테넌트별 할당량(W4 결제·W6 부하)의 몫이고, 여기서는 "브라우저 안의 다른 사이트"만 막는다.
// 대화창 문서를 iframe이 아니라 최상위 창으로 여는 것도 막지 않는다. frame-ancestors는 넣는 부모가 있을 때만 적용되고 허용 목록은 /frame 응답의
// CSP 헤더에 보인다(http/frame.ts). 그렇게 연 대화창은 이 서버 오리진이라 1의 검사도 지나므로, 그 비용도 curl처럼 요율 제한(app.ts)이 누른다.

/** 설정값(QRATE_PUBLIC_ORIGIN)을 정규형 오리진으로 만든다. 경로·쿼리는 버리고, http(s)가 아니면 시작 시점에 실패시킨다. */
export function parseOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`QRATE_PUBLIC_ORIGIN이 URL이 아님: "${raw}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`QRATE_PUBLIC_ORIGIN은 http(s) 오리진이어야 함: "${raw}"`);
  }
  return u.origin;
}

/**
 * Origin 헤더 검사.
 * - 헤더가 없으면 브라우저가 아닌 호출(curl, 서버 간)로 보고 통과시킨다. 브라우저는 POST에 항상 Origin을 붙이므로
 *   "없음"은 브라우저 밖이고, 그 호출은 어떤 값이든 꾸밀 수 있어 이 검사의 대상이 아니다(위 주석 참고).
 * - `Origin: null`(file:// 문서, sandbox iframe, 일부 리다이렉트)은 "있지만 다른 오리진"이라 거부된다.
 * - 비교는 글자 그대로다. 브라우저가 보내는 Origin은 이미 정규형이고, ownOrigin은 parseOrigin으로 정규화돼 있다.
 */
export function isAllowedOrigin(originHeader: string | undefined, ownOrigin: string): boolean {
  if (originHeader === undefined) return true;
  return originHeader === ownOrigin;
}

/**
 * 대화창이 부르는 API 넷(app.ts의 인사말 GET·대화·상담원 연결·위젯 사건)과 콘솔 API의 상태를 바꾸는 요청(http/console/router.ts) 앞에 두는
 * 미들웨어. 본문을 읽기 전에 끊어서 다른 사이트의 요청에는 파싱 비용도 쓰지 않는다.
 */
export function requireOwnOrigin(ownOrigin: string): RequestHandler {
  return (req, res, next) => {
    if (!isAllowedOrigin(req.headers.origin, ownOrigin)) {
      res.status(403).json({ error: 'origin_not_allowed' } satisfies ApiErrorBody);
      return;
    }
    next();
  };
}
