// 결제 제공자 → 서버 웹훅 계약. 제공자마다 서명 방식이 달라 경로에 제공자 이름이 들어간다.
//
//   POST /api/payments/:provider/webhook   원문 그대로 받는다(JSON 파서 없음, 16kb). 세션·Origin 검사 없음(서버 간).
//     200 WebhookAckBody                    서명이 맞으면 모르는 주문·금액 불일치도 200 — 받았다고 답해야 제공자가 재시도를 멈춘다.
//                                           같은 이벤트의 재배달이면 같은 본문 + Idempotent-Replayed: true
//     401 invalid_signature                 서명 헤더 없음·형식·시각(±300초)·값 불일치. 어느 쪽인지 알리지 않는다
//     400 invalid_webhook                   서명은 맞는데 본문이 이벤트 모양이 아님
//     404 not_found                         설정되지 않은 제공자(운영 기본은 mock 없음)
//
// 모의 제공자(mock)의 서명: 헤더 Qrate-Mock-Signature: t=<unix초>,v1=<hex>, 값은 HMAC-SHA256(비밀, "<t>." + 원문 바이트).
// 본문: {"id":"evt_…","type":"payment.paid"|"payment.failed","created":<unix초>,"data":{"orderId":"<주문 id>","amount":<원>}}
//
// 토스(toss): 결제창형 상점에는 웹훅 서명을 검증할 보안 키가 없어 본문을 믿지 않는다. PAYMENT_STATUS_CHANGED 본문의 data.orderId가
// 우리 장부의 토스 주문일 때만 data.paymentKey로 결제 조회 API를 불러, 그 답(주문 번호·금액·상태)으로만 판정한다.
//     200 unknown_order·provider_mismatch   우리 토스 주문이 아니다. 토스를 부르지 않는다
//     200 unverified                       조회가 그런 결제는 없다고 답했다(위조로 본다). 사건을 기록하지 않는다
//     200 unsettled                        조회한 결제가 아직 끝나지 않았거나 범위 밖이다(취소, 기록만)
//     200 order_mismatch·amount_mismatch   조회한 결제가 본문이 말한 주문·금액이 아니다
//     503 provider_unavailable             조회가 8초 안에 답하지 않았거나 실패했다. 토스가 다시 보낸다(최대 7회)
//     400 invalid_webhook                  JSON이 아니거나 PAYMENT_STATUS_CHANGED 모양이 아니다

import type { SettleOutcome } from './console.js';

export const PAYMENT_WEBHOOK_ROUTE = '/api/payments/:provider/webhook';
export const paymentWebhookPath = (provider: string): string => `/api/payments/${encodeURIComponent(provider)}/webhook`;
/** 소문자로 둔다 — Node는 받은 헤더 이름을 소문자 키로 준다. HTTP 헤더 이름은 대소문자를 가리지 않는다. */
export const MOCK_SIGNATURE_HEADER = 'qrate-mock-signature';

/** applied·stale은 이벤트를 적용한 결과, 나머지는 반영하지 않은 이유. */
export type WebhookOutcome =
  | SettleOutcome
  /** 우리 장부의 그 제공자 주문이 아니다. */
  | 'unknown_order'
  | 'provider_mismatch'
  /** 제공자가 알려 준 결제가 그 주문의 것이 아니거나 금액이 다르다. */
  | 'order_mismatch'
  | 'amount_mismatch'
  /** 토스: 조회한 결제가 아직 끝나지 않았거나(READY·IN_PROGRESS·WAITING_FOR_DEPOSIT) 범위 밖이다(취소, 기록만). */
  | 'unsettled'
  /** 토스: 조회가 그런 결제는 없다고 답했다. 사건을 기록하지 않는다. */
  | 'unverified';

export interface WebhookAckBody {
  outcome: WebhookOutcome;
}
