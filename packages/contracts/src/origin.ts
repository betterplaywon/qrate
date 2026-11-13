// 허용 사이트 주소(오리진)의 문법. 서버(시드·콘솔 API·대화창 문서)와 콘솔(주소 미리보기)이 이 함수 하나를 쓴다.
// 허용 사이트는 대화창 응답의 CSP frame-ancestors에 글자 그대로 들어간다(apps/server/src/http/frame.ts).

// URL은 브라우저와 Node 양쪽의 전역(WHATWG URL)이지만 이 패키지의 lib(ES2022, DOM·Node 타입 없음)에는 없어 쓰는 모양만 적는다.
declare const URL: new (input: string) => { readonly protocol: string; readonly hostname: string; readonly port: string; readonly origin: string };

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
