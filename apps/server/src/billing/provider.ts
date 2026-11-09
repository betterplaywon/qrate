import type { MockPaymentProvider } from './mock.js';
import type { SettlementEvent } from './settlement.js';

export interface WebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

/** 제공자에게서 얻은 결제 상태. 서비스가 판정하는 유일한 입력이다 — 제공자의 전송 모양은 어댑터 안에서 끝난다. */
export type PaymentReading = { kind: 'event'; event: SettlementEvent };

/**
 * 웹훅 원문을 읽은 결과. 어느 주문의 소식인지(orderId)와 그 소식을 믿을 수 있는 결과로 바꾸는 방법(read)을 떼어 둔다.
 * 본문을 믿지 못해 제공자에게 다시 묻는 어댑터도 모르는 주문의 웹훅으로는 바깥을 부르지 않게 하려는 것이다:
 * readWebhook은 동기라 바깥을 부를 수 없고, 서비스는 우리 장부의 그 제공자 주문일 때만(matchOrder) read를 부른다.
 * orderId는 거르기에만 쓴다. 판정은 read가 돌려준 사건의 주문 번호·금액으로 한다(decideSettlement).
 */
export type WebhookNotice =
  | { ok: false; reason: 'signature' | 'malformed' }
  | { ok: true; orderId: string; read: () => Promise<PaymentReading> };

/** 켜진 결제 제공자. 설정이 하나만 고르므로 합집합 하나다 — "둘 다 켜짐"과 그때의 우선순위 규칙이 생길 자리가 없다. */
export type PaymentProvider = MockPaymentProvider;
