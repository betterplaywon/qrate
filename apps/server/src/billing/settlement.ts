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

export type IgnoreReason = 'unknown_order' | 'provider_mismatch' | 'amount_mismatch';

export type Decision = { kind: 'ignore'; reason: IgnoreReason } | { kind: 'settle'; settlement: Settlement };

export function decideSettlement(order: TopUp | null, event: SettlementEvent): Decision {
  if (!order) return { kind: 'ignore', reason: 'unknown_order' };
  if (order.provider !== event.provider) return { kind: 'ignore', reason: 'provider_mismatch' };
  if (order.amount !== event.amount) return { kind: 'ignore', reason: 'amount_mismatch' };
  const to = event.result;
  return {
    kind: 'settle',
    settlement: {
      topUpId: order.id,
      tenantId: order.tenantId,
      event: { provider: event.provider, eventId: event.eventId, result: event.result },
      to,
      from: ALLOWED_FROM[to],
      // 키가 이벤트 id가 아니라 주문 id다 — 다른 이벤트 id로 온 같은 결과가 두 줄이 되지 않게.
      credit: to === 'paid' ? { delta: order.credits, reason: 'topup', idempotencyKey: `topup:${order.id}` } : null,
    },
  };
}
