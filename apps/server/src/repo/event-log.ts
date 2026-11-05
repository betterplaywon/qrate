import type { AppEvent, EventCount } from './types.js';

// 사건 로그의 공용 조각 — 사건 → 행(열로 꺼내는 값), 개수의 순서. 메모리·Prisma 두 구현이 같은 것을 쓴다.

/** DB 행 모양(schema.prisma의 Event). 열로 꺼내는 값은 여기서만 정한다. */
export interface EventRow {
  tenantId: string;
  type: AppEvent['type'];
  conversationId: string | null;
  variant: string | null;
  ttftMs: number | null;
  createdAt: Date;
  payload: AppEvent['payload'];
}

export function toEventRow(event: AppEvent): EventRow {
  return {
    tenantId: event.tenantId,
    type: event.type,
    conversationId: event.conversationId,
    variant: null,
    ttftMs: event.type === 'chat_request' ? event.ttftMs : null,
    createdAt: event.createdAt,
    payload: event.payload,
  };
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * type 오름차순, 같으면 variant 오름차순(null 먼저). 코드 단위 비교 — Postgres ORDER BY는 DB 콜레이션을 따라
 * 구두점·대소문자를 다르게 다룰 수 있어 두 구현 모두 여기서 정렬한다(knowledge-order.ts와 같은 이유).
 */
export function sortEventCounts(counts: readonly EventCount[]): EventCount[] {
  return [...counts].sort((a, b) => {
    if (a.type !== b.type) return compareText(a.type, b.type);
    if (a.variant === b.variant) return 0;
    if (a.variant === null) return -1;
    if (b.variant === null) return 1;
    return compareText(a.variant, b.variant);
  });
}
