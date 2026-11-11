import { paymentKeySchema } from '@qrate/contracts/schemas';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PaymentResult, TopUp } from '../repo/types.js';
import type { PaymentReading, WebhookNotice, WebhookRequest } from './provider.js';

/** 설정으로 바꾸지 않는다. 바꿀 수 있으면 잘못 넣은 값 하나로 시크릿 키(Basic 인증)가 다른 호스트로 간다. 시험은 fetch를 꽂는다. */
const TOSS_API_ORIGIN = 'https://api.tosspayments.com';

/**
 * 웹훅: 토스는 10초 안에 200을 기다린다. 조회를 8초에서 끊고 503으로 답해 토스가 다시 보내게 한다.
 * 승인 10초는 토스 문서에 권고가 없어 고른 값이다.
 */
export const DEFAULT_TIMEOUTS = { confirmMs: 10_000, lookupMs: 8_000 } as const;

declare const tossKeyKind: unique symbol;
export type TossClientKey = string & { readonly [tossKeyKind]: 'client' };
export type TossSecretKey = string & { readonly [tossKeyKind]: 'secret' };

const CLIENT_KEY_PATTERN = /^test_gck_[A-Za-z0-9_]+$/;
const SECRET_KEY_PATTERN = /^test_gsk_[A-Za-z0-9_]+$/;

/** 같은 세트인지는 여기서 알 수 없다. 섞이면 토스가 인증 오류로 답하고, 그 답은 unavailable로 보고된다. */
export function parseTossKeys(raw: { clientKey: string | undefined; secretKey: string | undefined }): {
  clientKey: TossClientKey;
  secretKey: TossSecretKey;
} {
  const { clientKey, secretKey } = raw;
  if (!clientKey || !secretKey) {
    const missing = [clientKey ? null : 'QRATE_TOSS_CLIENT_KEY', secretKey ? null : 'QRATE_TOSS_SECRET_KEY'].filter(Boolean).join('·');
    throw new Error(`QRATE_PAYMENT_PROVIDER=toss에는 두 키가 모두 필요함(없음: ${missing})`);
  }
  if (!CLIENT_KEY_PATTERN.test(clientKey)) {
    throw new Error('QRATE_TOSS_CLIENT_KEY는 결제창형 테스트 클라이언트 키(test_gck_)여야 함 — 라이브 키·API 개별 연동 키는 받지 않는다');
  }
  if (!SECRET_KEY_PATTERN.test(secretKey)) {
    throw new Error('QRATE_TOSS_SECRET_KEY는 결제창형 테스트 시크릿 키(test_gsk_)여야 함 — 라이브 키·API 개별 연동 키는 받지 않는다');
  }
  return { clientKey: clientKey as TossClientKey, secretKey: secretKey as TossSecretKey };
}

const TOSS_STATUSES = ['READY', 'IN_PROGRESS', 'WAITING_FOR_DEPOSIT', 'DONE', 'CANCELED', 'PARTIAL_CANCELED', 'ABORTED', 'EXPIRED'] as const;
type TossStatus = (typeof TOSS_STATUSES)[number];

const TOSS_STATUS_RESULT = {
  READY: 'open',
  IN_PROGRESS: 'open',
  WAITING_FOR_DEPOSIT: 'open',
  DONE: 'paid',
  ABORTED: 'failed',
  EXPIRED: 'failed',
  CANCELED: 'out_of_scope',
  PARTIAL_CANCELED: 'out_of_scope',
} as const satisfies Record<TossStatus, PaymentResult | 'open' | 'out_of_scope'>;

/** mId는 대조하지 않는다 — 우리 시크릿 키로 승인·조회한 결제는 우리 상점의 것이라고 본다(토스 문서에 명시는 없고 확인하지 못한 가정). */
const paymentSchema = z.object({
  paymentKey: z.string().min(1).max(200),
  orderId: z.string().min(6).max(64),
  status: z.enum(TOSS_STATUSES),
  totalAmount: z.number().int().nonnegative(),
});
type TossPayment = z.infer<typeof paymentSchema>;

const tossErrorSchema = z.object({ code: z.string().min(1).max(100) });

const webhookSchema = z.object({
  eventType: z.literal('PAYMENT_STATUS_CHANGED'),
  data: z.object({ paymentKey: paymentKeySchema, orderId: z.string().min(1).max(64) }),
});

const NOT_FOUND_CODES: ReadonlySet<string> = new Set(['NOT_FOUND_PAYMENT', 'NOT_FOUND']);

type TossAnswer =
  | { kind: 'payment'; payment: TossPayment }
  | { kind: 'error'; httpStatus: number; code: string }
  | { kind: 'no_answer'; why: 'timeout' | 'network' | 'unreadable'; httpStatus: number | null };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readAnswer(httpStatus: number, text: string): TossAnswer {
  const json = parseJson(text);
  if (httpStatus >= 200 && httpStatus < 300) {
    const payment = paymentSchema.safeParse(json);
    return payment.success ? { kind: 'payment', payment: payment.data } : { kind: 'no_answer', why: 'unreadable', httpStatus };
  }
  const error = tossErrorSchema.safeParse(json);
  return error.success ? { kind: 'error', httpStatus, code: error.data.code } : { kind: 'no_answer', why: 'unreadable', httpStatus };
}

function describeAnswer(answer: TossAnswer): string {
  switch (answer.kind) {
    case 'payment':
      return answer.payment.status;
    case 'error':
      return `${answer.httpStatus} ${answer.code}`;
    case 'no_answer':
      return answer.httpStatus === null ? answer.why : `${answer.httpStatus} ${answer.why}`;
  }
}

type ConfirmBody = { paymentKey: string; orderId: string; amount: number };

/**
 * 토스는 키·API 키·URL·메서드가 같은지만 보고 본문은 보지 않으므로, 키가 본문 전체의 함수여야 한다.
 * 결제 키만 쓰면, 다른 주문 id로 잘못 보낸 요청의 오류가 같은 키로 재생되어(실측) 그 결제의 올바른 승인을 막는다.
 * 해시라서 300자 상한과 헤더 문자 제약을 늘 만족한다.
 */
function confirmIdempotencyKey(body: ConfirmBody): string {
  return createHash('sha256').update('qrate-confirm\n').update(JSON.stringify(body)).digest('hex');
}

function judgePayment(payment: TossPayment): PaymentReading {
  const verdict = TOSS_STATUS_RESULT[payment.status];
  if (verdict === 'open' || verdict === 'out_of_scope') return { kind: 'unsettled', scope: verdict, status: payment.status, detail: null };
  return {
    kind: 'event',
    event: {
      provider: 'toss',
      eventId: `${payment.paymentKey}:${payment.status}`,
      orderId: payment.orderId,
      result: verdict,
      amount: payment.totalAmount,
    },
  };
}

function readLookup(answer: TossAnswer): PaymentReading {
  if (answer.kind === 'payment') return judgePayment(answer.payment);
  const detail = `lookup ${describeAnswer(answer)}`;
  if (answer.kind === 'error' && answer.httpStatus === 404 && NOT_FOUND_CODES.has(answer.code)) return { kind: 'not_found', detail };
  return { kind: 'unavailable', detail };
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

export interface TossProviderOptions {
  clientKey: TossClientKey;
  secretKey: TossSecretKey;
  fetch?: typeof globalThis.fetch;
  timeouts?: Partial<{ confirmMs: number; lookupMs: number }>;
}

export interface TossPaymentProvider {
  readonly name: 'toss';
  readonly clientKey: TossClientKey;
  /** 서명은 보지 않는다(결제창형 상점에는 검증할 보안 키가 없다). */
  readWebhook(req: WebhookRequest, now: Date): WebhookNotice;
  /** 같은 멱등 키는 첫 답을 계속 재생해서(실측) 첫 답이 오류나 입금 대기였으면 지금 상태는 조회만 안다. */
  confirm(order: Pick<TopUp, 'id' | 'amount'>, paymentKey: string): Promise<PaymentReading>;
}

export function createTossProvider(options: TossProviderOptions): TossPaymentProvider {
  const send = options.fetch ?? globalThis.fetch;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  // 시크릿 키 뒤의 콜론까지가 토스의 Basic 인증 규칙이다(비밀번호 칸이 비어 있다는 뜻).
  const authorization = `Basic ${Buffer.from(`${options.secretKey}:`).toString('base64')}`;

  async function call(
    method: 'GET' | 'POST',
    path: string,
    request: { body?: unknown; idempotencyKey?: string; timeoutMs: number },
  ): Promise<TossAnswer> {
    const headers: Record<string, string> = { authorization, accept: 'application/json' };
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    if (request.idempotencyKey) headers['idempotency-key'] = request.idempotencyKey;
    try {
      const res = await send(`${TOSS_API_ORIGIN}${path}`, {
        method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        // 본문 읽기(res.text)도 같은 신호 안이다.
        signal: AbortSignal.timeout(request.timeoutMs),
      });
      return readAnswer(res.status, await res.text());
    } catch (err) {
      return { kind: 'no_answer', why: isTimeout(err) ? 'timeout' : 'network', httpStatus: null };
    }
  }

  async function lookup(paymentKey: string): Promise<PaymentReading> {
    return readLookup(await call('GET', `/v1/payments/${encodeURIComponent(paymentKey)}`, { timeoutMs: timeouts.lookupMs }));
  }

  return {
    name: 'toss',
    clientKey: options.clientKey,

    readWebhook(req) {
      const parsed = webhookSchema.safeParse(parseJson(req.rawBody.toString('utf8')));
      if (!parsed.success) return { ok: false, reason: 'malformed' };
      const { orderId, paymentKey } = parsed.data.data;
      return { ok: true, orderId, read: () => lookup(paymentKey) };
    },

    async confirm(order, paymentKey) {
      const body: ConfirmBody = { paymentKey, orderId: order.id, amount: order.amount };
      const answer = await call('POST', '/v1/payments/confirm', {
        body,
        idempotencyKey: confirmIdempotencyKey(body),
        timeoutMs: timeouts.confirmMs,
      });
      if (answer.kind === 'payment') {
        const judged = judgePayment(answer.payment);
        if (judged.kind === 'event') return judged;
      }
      const reading = await lookup(paymentKey);
      if (reading.kind === 'event') return reading;
      const confirmDetail = `confirm ${describeAnswer(answer)}`;
      return { ...reading, detail: reading.detail ? `${confirmDetail}; ${reading.detail}` : confirmDetail };
    },
  };
}
