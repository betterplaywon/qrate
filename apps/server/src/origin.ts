import type { ApiErrorBody } from '@qrate/contracts';
import type { RequestHandler } from 'express';

// 오리진(origin) = scheme://host[:port]. 브라우저가 "같은 오리진끼리만 자유롭게 통신"하게 두는 경계의 단위다.
//
// 테넌트 검증 단계(ADR-0003 하이브리드)에서 이 서버가 쓰는 오리진 규칙 세 가지:
//   1. 대화 API(POST /api/chat)를 부르는 브라우저 문서는 이 서버 오리진의 iframe 하나뿐이다.
//      → 다른 오리진의 Origin 헤더는 403. CORS 헤더는 아예 내지 않는다(W1의 전체 허용 제거).
//   2. 어느 고객 사이트가 그 iframe을 넣을 수 있는지는 GET /frame 응답의 CSP frame-ancestors로 브라우저가 강제한다. (src/frame.ts)
//   3. 테넌트의 allowedOrigins는 CSP 헤더에 글자 그대로 들어가므로 정규형 오리진 문자열만 받는다(헤더 인젝션·오타 방지).
//
// 이 검사로 막지 못하는 것: 브라우저 밖(curl, 스크립트)에서 공개 테넌트 키로 부르는 호출. Origin은 꾸밀 수 있는 헤더다.
// 그쪽은 요율 제한·테넌트별 할당량(W4 결제·W6 부하)의 몫이고, 여기서는 "브라우저 안의 다른 사이트"만 막는다.

/**
 * CSP 호스트 문법(host-char = 영문·숫자·하이픈, 점으로 잇는다). URL 파서는 호스트의 `;` `,` 따옴표 `_` `*`를 그대로 두어
 * `u.origin === v`만으로는 걸러지지 않는다. 그런 값이 frame-ancestors에 들어가면 지시어가 끼어들어 등록한 사이트까지 막힌다
 * (콘솔에 `a.com,b.com`을 한 칸에 넣은 경우, PR #52 검증에서 실측). 끝 점(`example.com.`)과 IPv6(`[::1]`)도 이 문법 밖이다.
 * 와일드카드(`*.example.com`)도 여기서 걸린다. 하위 도메인 일괄 허용은 필요가 생기면 명시적으로 열기로 한다.
 */
const CSP_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

/** 정규형 오리진인지. `new URL(v).origin`과 글자 그대로 같고(소문자, 기본 포트 생략, 경로·슬래시 없음) 호스트가 CSP 호스트 문법이어야 한다. */
export function isOriginString(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && CSP_HOST.test(u.hostname) && u.port !== '0' && u.origin === v;
  } catch {
    return false;
  }
}

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

/** POST /api/chat 앞에 두는 미들웨어. 본문을 읽기 전에 끊어서 다른 사이트의 요청에는 파싱 비용도 쓰지 않는다. */
export function requireOwnOrigin(ownOrigin: string): RequestHandler {
  return (req, res, next) => {
    if (!isAllowedOrigin(req.headers.origin, ownOrigin)) {
      res.status(403).json({ error: 'origin_not_allowed' } satisfies ApiErrorBody);
      return;
    }
    next();
  };
}
