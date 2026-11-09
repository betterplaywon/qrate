import type { PaymentProviderName, PaymentResult, Settlement, TopUp, TopUpStatus } from '../repo/types.js';

/**
 * 상태는 앞으로만 간다(pending < failed < paid). 끝 상태가 받은 결과의 최댓값이라 배달 순서와 무관하게 수렴한다.
 * 실패 뒤의 결제 완료도 받는다 — 제공자가 결제됐다고 알린 주문을 실패로 남기면 돈은 나갔는데 크레딧이 없다.
 */
export const ALLOWED_FROM = {
  paid: ['pending', 'failed'],
  failed: ['pending'],
} as const satisfies Record<PaymentResult, readonly TopUpStatus[]>;

export interface SettlementEvent {
  provider: PaymentProviderName;
  eventId: string;
  orderId: string;
  result: PaymentResult;
  amount: number;
}

export type IgnoreReason = 'unknown_order' | 'provider_mismatch' | 'order_mismatch' | 'amount_mismatch';

export type Decision = { kind: 'ignore'; reason: IgnoreReason } | { kind: 'settle'; settlement: Settlement };

export type OrderMatch = { ok: true; order: TopUp } | { ok: false; reason: 'unknown_order' | 'provider_mismatch' };

/**
 * 이 제공자의 소식을 받을 주문인가 — 있고, 그 제공자로 만든 주문이어야 한다.
 * 웹훅은 이것이 통과해야 제공자에게 결과를 묻고, 확정은 이것이 통과해야 제공자에게 승인을 청한다(billing/service.ts).
 * decideSettlement도 먼저 이것을 본다.
 */
export function matchOrder(order: TopUp | null, provider: PaymentProviderName): OrderMatch {
  if (!order) return { ok: false, reason: 'unknown_order' };
  if (order.provider !== provider) return { ok: false, reason: 'provider_mismatch' };
  return { ok: true, order };
}

export function decideSettlement(order: TopUp | null, event: SettlementEvent): Decision {
  const matched = matchOrder(order, event.provider);
  if (!matched.ok) return { kind: 'ignore', reason: matched.reason };
  const target = matched.order;
  // 주문은 요청이 말한 id(확정의 경로, 본문을 믿지 못하는 웹훅의 본문)로 찾고 사건은 제공자의 답에서 만든다. 같은 금액의
  // 다른 주문 결제가 오면, 이 검사가 없을 때 한 결제로 두 주문이 충전된다(이 주문 한 번, 그 결제의 주문 한 번).
  if (event.orderId !== target.id) return { kind: 'ignore', reason: 'order_mismatch' };
  if (target.amount !== event.amount) return { kind: 'ignore', reason: 'amount_mismatch' };
  const to = event.result;
  return {
    kind: 'settle',
    settlement: {
      topUpId: target.id,
      tenantId: target.tenantId,
      event: { provider: event.provider, eventId: event.eventId, result: event.result },
      to,
      from: ALLOWED_FROM[to],
      // 키가 이벤트 id가 아니라 주문 id다 — 다른 이벤트 id로 온 같은 결과가 두 줄이 되지 않게.
      credit: to === 'paid' ? { delta: target.credits, reason: 'topup', idempotencyKey: `topup:${target.id}` } : null,
    },
  };
}
