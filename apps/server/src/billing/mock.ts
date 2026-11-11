import { MOCK_SIGNATURE_HEADER } from '@qrate/contracts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PaymentResult } from '../repo/types.js';
import type { WebhookNotice, WebhookRequest } from './provider.js';
import type { SettlementEvent } from './settlement.js';

export const SIGNATURE_TOLERANCE_SEC = 300;

// v1을 64자 hex로 묶어 두면 두 HMAC 버퍼의 길이가 같다 — timingSafeEqual은 길이가 다르면 던진다.
const SIGNATURE = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

const mockWebhookEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(['payment.paid', 'payment.failed']).transform((t): PaymentResult => (t === 'payment.paid' ? 'paid' : 'failed')),
  data: z.object({ orderId: z.string().min(1).max(200), amount: z.number().int().nonnegative() }),
});

type Verification = { ok: true; event: SettlementEvent } | { ok: false; reason: 'signature' | 'malformed' };

const SIGNATURE_REJECTED: Verification = { ok: false, reason: 'signature' };
const MALFORMED: Verification = { ok: false, reason: 'malformed' };

function hmac(secret: string, t: number, rawBody: Buffer): Buffer {
  return createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
}

function parseSignature(header: string | string[] | undefined): { t: number; v1: Buffer } | null {
  if (typeof header !== 'string') return null;
  const [, t, v1] = SIGNATURE.exec(header) ?? [];
  return t && v1 ? { t: Number(t), v1: Buffer.from(v1, 'hex') } : null;
}

function verify(secret: string, req: WebhookRequest, now: Date): Verification {
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

export interface MockPaymentProvider {
  readonly name: 'mock';
  readWebhook(req: WebhookRequest, now: Date): WebhookNotice;
  signEvent(e: { orderId: string; amount: number; result: PaymentResult; eventId?: string }, now: Date): WebhookRequest;
}

export function createMockProvider(secret: string): MockPaymentProvider {
  return {
    name: 'mock',
    readWebhook(req, now) {
      const verified = verify(secret, req, now);
      if (!verified.ok) return verified;
      const { event } = verified;
      return { ok: true, orderId: event.orderId, read: async () => ({ kind: 'event', event }) };
    },
    signEvent({ orderId, amount, result, eventId = `evt_${orderId}_${result}` }, now) {
      const t = Math.floor(now.getTime() / 1000);
      const body = { id: eventId, type: `payment.${result}`, created: t, data: { orderId, amount } };
      const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
      return { rawBody, headers: { 'content-type': 'application/json', [MOCK_SIGNATURE_HEADER]: signMockPayload(secret, rawBody, t) } };
    },
  };
}
