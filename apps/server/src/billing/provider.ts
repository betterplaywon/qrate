import type { MockPaymentProvider } from './mock.js';
import type { SettlementEvent } from './settlement.js';
import type { TossPaymentProvider } from './toss.js';

export interface WebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * 입구에서 paymentKeySchema로 검사한 결제 키를 받는 한 어댑터는 던지지 않는다. 시간 초과·끊김·이상한 응답도 이 값 중 하나라서,
 * 서비스는 넷 중 무엇이 왔는지만 본다.
 */
export type PaymentReading =
  | { kind: 'event'; event: SettlementEvent }
  | { kind: 'unsettled'; scope: 'open' | 'out_of_scope'; status: string; detail: string | null }
  | { kind: 'not_found'; detail: string }
  | { kind: 'unavailable'; detail: string };

/** 모르는 주문의 웹훅이 토스를 부르지 못하게 read를 따로 둔다 — 서비스는 matchOrder를 통과한 주문에만 read를 부른다. */
export type WebhookNotice =
  | { ok: false; reason: 'signature' | 'malformed' }
  | { ok: true; orderId: string; read: () => Promise<PaymentReading> };

export type PaymentProvider = MockPaymentProvider | TossPaymentProvider;
