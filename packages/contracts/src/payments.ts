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

import type { SettleOutcome } from './console.js';

export const PAYMENT_WEBHOOK_ROUTE = '/api/payments/:provider/webhook';
export const paymentWebhookPath = (provider: string): string => `/api/payments/${encodeURIComponent(provider)}/webhook`;
/** 소문자로 둔다 — Node는 받은 헤더 이름을 소문자 키로 준다. HTTP 헤더 이름은 대소문자를 가리지 않는다. */
export const MOCK_SIGNATURE_HEADER = 'qrate-mock-signature';

/** applied·stale은 이벤트를 적용한 결과, 나머지는 서명은 맞았지만 주문과 맞지 않아 무시한 이유. */
export type WebhookOutcome = SettleOutcome | 'unknown_order' | 'provider_mismatch' | 'amount_mismatch';

export interface WebhookAckBody {
  outcome: WebhookOutcome;
}
