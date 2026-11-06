// 위젯 사건 — 대화창(iframe)이 서버에 알리는 방문자 행동.
//
//   POST /api/events   WidgetEventBody → 202(본문 없음). 대화 API와 같은 Origin 검사(같은 오리진의 대화창만), IP당 요율 제한.
//                      400 invalid_event · tenant is required · invalid_json, 403 origin_not_allowed, 404 unknown_tenant,
//                      413 payload_too_large, 429 too_many_requests
//
// 서버는 저장을 기다리지 않는다 — 202가 그 뜻이다. 본문에서 저장하는 것은 종류와 (지금 인사말 실험의) 변형뿐이다(모르는 키는 무시 — 새 위젯 → 옛 서버).

export const EVENTS_PATH = '/api/events';

/**
 * 위젯이 보낼 수 있는 사건 종류 — 공개 화이트리스트의 유일한 목록. 여기 없는 종류는 밖에서 쓸 수 없다.
 *   widget_open     페이지 로드당 첫 열림. 인사말 요청이 끝난 뒤(최대 3초) 보내고, 그때 인사말이 보이고 있었으면 그 변형을 싣는다(= 인사말 노출).
 *   first_question  페이지 로드당 첫 질문 전송(재시도 아님, 서버 결과와 무관). 그때 화면에 있던 인사말의 변형을 싣는다.
 */
export const WIDGET_EVENT_TYPES = ['widget_open', 'first_question'] as const;
export type WidgetEventType = (typeof WIDGET_EVENT_TYPES)[number];

export interface WidgetEventBody {
  /** 위젯 설치 스니펫의 data-tenant 값. */
  tenant: string;
  type: WidgetEventType;
  /** 화면에 보인 인사말의 변형 id(GreetingResponse.greeting.variant). 인사말이 없었으면 키를 뺀다. 서버는 지금 실험의 변형이 아니면 버린다. */
  variant?: string;
}
