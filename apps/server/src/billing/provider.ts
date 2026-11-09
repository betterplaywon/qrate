import type { MockPaymentProvider } from './mock.js';
import type { SettlementEvent } from './settlement.js';
import type { TossPaymentProvider } from './toss.js';

export interface WebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * 제공자에게서 얻은 결제 상태. 서비스가 판정하는 유일한 입력이다 — 제공자의 전송 모양은 어댑터 안에서 끝난다.
 * 어댑터는 던지지 않는다. 시간 초과·끊김·이상한 응답도 이 값 중 하나라서, 서비스는 넷 중 무엇이 왔는지만 본다.
 */
export type PaymentReading =
  /** 결과가 정해졌다(paid·failed). decideSettlement가 주문과 대조한다. */
  | { kind: 'event'; event: SettlementEvent }
  /**
   * 제공자의 결제가 우리가 반영하는 결과가 아니다. open = 아직(인증 전·승인 전·입금 전), out_of_scope = 취소(기록만).
   * detail은 확정 경로에서 승인이 결제 객체로 답하지 않은 이유다. 보고용이고 판정에 쓰지 않는다.
   */
  | { kind: 'unsettled'; scope: 'open' | 'out_of_scope'; status: string; detail: string | null }
  /** 제공자가 그런 결제는 없다고 답했다. 웹훅이면 위조로 본다. */
  | { kind: 'not_found'; detail: string }
  /** 제공자에게 묻지 못했다(시간 초과·연결·5xx·연속 요청 제한·인증 오류·읽을 수 없는 응답). */
  | { kind: 'unavailable'; detail: string };

/**
 * 웹훅 원문을 읽은 결과. 어느 주문의 소식인지(orderId)와 그 소식을 믿을 수 있는 결과로 바꾸는 방법(read)을 떼어 둔다.
 * 본문을 믿지 못해 제공자에게 다시 묻는 어댑터(토스 조회 API)가 모르는 주문의 웹훅으로는 바깥을 부르지 않게 하려는 것이다:
 * readWebhook은 동기라 바깥을 부를 수 없고, 서비스는 우리 장부의 그 제공자 주문일 때만(matchOrder) read를 부른다.
 * orderId는 거르기에만 쓴다. 판정은 read가 돌려준 사건의 주문 번호·금액으로 한다(decideSettlement).
 */
export type WebhookNotice =
  | { ok: false; reason: 'signature' | 'malformed' }
  | { ok: true; orderId: string; read: () => Promise<PaymentReading> };

/** 켜진 결제 제공자. 설정이 하나만 고르므로 합집합 하나다 — "둘 다 켜짐"과 그때의 우선순위 규칙이 생길 자리가 없다. */
export type PaymentProvider = MockPaymentProvider | TossPaymentProvider;
