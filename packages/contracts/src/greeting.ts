// 인사말 배정 — 대화창(iframe)이 처음 뜰 때 한 번 묻는다. 부수 효과가 없다(노출·첫 질문 사건은 /api/events가 남긴다).
//
//   GET /api/greeting?tenant=<키>&variant=<보존된 변형 id>   → 200 GreetingResponse, Cache-Control: no-store
//                     400 tenant is required, 403 origin_not_allowed, 404 unknown_tenant
//
// variant가 지금 실험의 변형이면 그 변형, 아니면(없음·옛 실험·조작) 서버가 새로 고른다.

export const GREETING_PATH = '/api/greeting';

/**
 * 변형 id의 형식. 런처는 고객 사이트 localStorage에서 읽은 값(호스트 스크립트가 바꿀 수 있다)을 이 형식일 때만 대화창 URL에 싣고,
 * 서버는 실험 정의가 이 형식을 지키는지 시작할 때 검사한다. 둘이 어긋나면 런처가 서버의 값을 버려 보존이 조용히 사라지기 때문이다.
 */
export const VARIANT_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export interface GreetingResponse {
  /** null이면 지금 인사말 실험이 없다. 대화창은 인사말을 그리지 않는다. */
  greeting: {
    /** 변형 id(예: 'greet-2026-11.b'). 런처가 보존하고 위젯 사건에 싣는 값. 같은 변형의 방문자는 모두 같은 문자열이다. */
    variant: string;
    /** 대화창이 textContent로 그리는 인사말. */
    text: string;
  } | null;
}
