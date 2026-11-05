// 위젯 사건 — 대화창(iframe)이 서버에 알리는 방문자 행동. 서버 쪽 사건(chat_request)은 서버가 직접 쓰고 여기 없다.
//
//   POST /api/events   WidgetEventBody → 202(본문 없음). 대화 API와 같은 Origin 검사(같은 오리진의 대화창만), IP당 요율 제한.
//                      400 invalid_event · tenant is required · invalid_json, 403 origin_not_allowed, 404 unknown_tenant,
//                      413 payload_too_large, 429 too_many_requests
//
// 서버는 저장을 기다리지 않는다 — 202가 그 뜻이다. 본문의 다른 값은 저장하지 않는다(모르는 키는 무시 — 새 위젯 → 옛 서버).

export const EVENTS_PATH = '/api/events';

/**
 * 위젯이 보낼 수 있는 사건 종류 — 공개 화이트리스트의 유일한 목록.
 * zod 스키마(schemas.ts)와 서버의 WidgetEvent 타입이 여기서 파생된다. 여기 없는 종류는 밖에서 쓸 수 없다.
 */
export const WIDGET_EVENT_TYPES = ['widget_open'] as const;
export type WidgetEventType = (typeof WIDGET_EVENT_TYPES)[number];

export interface WidgetEventBody {
  /** 위젯 설치 스니펫의 data-tenant 값. */
  tenant: string;
  type: WidgetEventType;
}
