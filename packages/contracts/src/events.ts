// 위젯 사건 — 대화창(iframe)이 서버에 알리는 방문자 행동. 서버 쪽 사건(chat_request)은 서버가 직접 쓰고 여기 없다.

/**
 * 위젯이 보낼 수 있는 사건 종류 — 공개 화이트리스트의 유일한 목록.
 * zod 스키마(schemas.ts)와 서버의 WidgetEvent 타입이 여기서 파생된다. 여기 없는 종류는 밖에서 쓸 수 없다.
 */
export const WIDGET_EVENT_TYPES = ['widget_open'] as const;
export type WidgetEventType = (typeof WIDGET_EVENT_TYPES)[number];
