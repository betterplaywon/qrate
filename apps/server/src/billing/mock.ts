import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PaymentResult } from '../repo/types.js';
import type { PaymentProvider, WebhookRequest, WebhookVerification } from './provider.js';

// 모의 결제 제공자. 서명된 웹훅을 만드는 쪽(signEvent, 제공자 역할)과 검증하는 쪽(verifyWebhook)을 함께 갖는다 — 둘이 같은 프로세스라
// 비밀을 밖으로 나눌 필요가 없다. 서명 모양은 Stripe와 같다: 헤더 t=<unix초>,v1=<hex>, 값은 HMAC-SHA256(비밀, "<t>." + 원문 바이트).

export const MOCK_SIGNATURE_HEADER = 'qrate-mock-signature';
/** 서명 시각이 지금에서 이만큼(초) 넘게 벗어나면 거부한다. 가로챈 웹훅을 나중에 다시 보내는 재전송의 창을 좁힌다. */
export const SIGNATURE_TOLERANCE_SEC = 300;

// v1을 64자 hex로 묶어 두면 두 HMAC 버퍼의 길이가 같다 — timingSafeEqual은 길이가 다르면 던진다.
const SIGNATURE = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

/** 서명이 맞은 뒤에만 읽는 본문. 여분 필드(tenantId 등)는 버린다 — 테넌트는 주문 행에서만 나온다. */
const mockWebhookEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(['payment.paid', 'payment.failed']).transform((t): PaymentResult => (t === 'payment.paid' ? 'paid' : 'failed')),
  data: z.object({ orderId: z.string().min(1).max(200), amount: z.number().int().nonnegative() }),
});

const SIGNATURE_REJECTED: WebhookVerification = { ok: false, reason: 'signature' };
const MALFORMED: WebhookVerification = { ok: false, reason: 'malformed' };

function hmac(secret: string, t: number, rawBody: Buffer): Buffer {
  return createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
}

function parseSignature(header: string | string[] | undefined): { t: number; v1: Buffer } | null {
  if (typeof header !== 'string') return null;
  const [, t, v1] = SIGNATURE.exec(header) ?? [];
  return t && v1 ? { t: Number(t), v1: Buffer.from(v1, 'hex') } : null;
}

function verify(secret: string, req: WebhookRequest, now: Date): WebhookVerification {
  const signature = parseSignature(req.headers[MOCK_SIGNATURE_HEADER]);
  if (!signature) return SIGNATURE_REJECTED;
  if (Math.abs(Math.floor(now.getTime() / 1000) - signature.t) > SIGNATURE_TOLERANCE_SEC) return SIGNATURE_REJECTED;
  if (!timingSafeEqual(hmac(secret, signature.t, req.rawBody), signature.v1)) return SIGNATURE_REJECTED;
  let json: unknown;
  try {
    json = JSON.parse(req.rawBody.toString('utf8'));
  } catch {
    return MALFORMED;
  }
  const parsed = mockWebhookEventSchema.safeParse(json);
  if (!parsed.success) return MALFORMED;
  const { id, type, data } = parsed.data;
  return { ok: true, event: { provider: 'mock', eventId: id, orderId: data.orderId, result: type, amount: data.amount } };
}

export function signMockPayload(secret: string, rawBody: Buffer, t: number): string {
  return `t=${t},v1=${hmac(secret, t, rawBody).toString('hex')}`;
}

export interface MockPaymentProvider extends PaymentProvider {
  readonly name: 'mock';
  /**
   * 제공자 쪽 역할: 서명된 웹훅 원문. 이벤트 id 기본값은 evt_<orderId>_<result>라 같은 결과를 다시 만들면 곧 재배달이다.
   * 결제 시뮬레이션(콘솔)과 테스트가 쓴다.
   */
  signEvent(e: { orderId: string; amount: number; result: PaymentResult; eventId?: string }, now: Date): WebhookRequest;
}

export function createMockProvider(secret: string): MockPaymentProvider {
  return {
    name: 'mock',
    async verifyWebhook(req, now) {
      return verify(secret, req, now);
    },
    signEvent({ orderId, amount, result, eventId = `evt_${orderId}_${result}` }, now) {
      const t = Math.floor(now.getTime() / 1000);
      const body = { id: eventId, type: `payment.${result}`, created: t, data: { orderId, amount } };
      const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
      return { rawBody, headers: { 'content-type': 'application/json', [MOCK_SIGNATURE_HEADER]: signMockPayload(secret, rawBody, t) } };
    },
  };
}
