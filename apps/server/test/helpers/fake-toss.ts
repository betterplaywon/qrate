import { randomUUID } from 'node:crypto';

// 가짜 토스페이먼츠 API. createTossProvider의 fetch 자리에 꽂아 승인·조회 두 경로를 흉내 낸다. 시험 전용이고 운영 코드에 스위치가 없다.
// 실측한 토스(2026-11-09, 테스트 모드)처럼 답한다:
//   같은 멱등 키의 승인은 첫 응답을 그대로 재생한다 — 오류 응답도.
//   같은 키의 첫 요청이 처리 중이면 409 IDEMPOTENT_REQUEST_PROCESSING이고, 이 답은 저장하지 않는다.
//   모르는 결제 키는 조회 404 NOT_FOUND_PAYMENT, 승인 404 NOT_FOUND_PAYMENT_SESSION.
// 문서에서 온 것: 이미 처리된 결제의 승인은 400 ALREADY_PROCESSED_PAYMENT, 인증 뒤 승인하지 않은 결제의 만료는 404 NOT_FOUND_PAYMENT_SESSION.
// 문서에 없어 고른 것: 인증 때와 다른 주문 번호·금액의 승인은 403 FORBIDDEN_REQUEST(서버는 오류 코드를 보지 않고 조회한다).

const TOSS_ORIGIN = 'https://api.tosspayments.com';

export type FakeTossStatus =
  | 'READY'
  | 'IN_PROGRESS'
  | 'WAITING_FOR_DEPOSIT'
  | 'DONE'
  | 'CANCELED'
  | 'PARTIAL_CANCELED'
  | 'ABORTED'
  | 'EXPIRED';

export type FakeAnswer =
  /** 처리하고 정상 응답(승인이면 DONE이 된다). */
  | 'pass'
  /** 처리하지 않고 답하지 않는다. 호출 쪽 시간 제한이 끊는다. */
  | 'hang'
  /** 처리하지 않고 연결이 끊긴다(fetch가 바로 던진다). */
  | 'reset'
  /** 처리하지 않고 오류 객체로 답한다. 승인이면 그 키로 저장되어 재생된다. */
  | { httpStatus: number; code: string }
  /** 토스 앞단이 JSON이 아닌 본문으로 답한다(프록시의 오류 페이지). 토스에 닿지 않았으니 저장하지 않는다. */
  | { httpStatus: number; raw: string }
  /** 승인은 처리했는데(DONE) 응답이 끊기거나 오류로 온다. 같은 키로 다시 보내면 그 응답이 재생된다. */
  | { committed: 'hang' | { httpStatus: number; code: string } }
  /** 승인을 받고 결제를 그 상태에 둔 채 결제 객체로 답한다(가상계좌의 입금 대기처럼 아직 끝나지 않은 결제). 같은 키로 다시 보내면 이 답이 재생된다. */
  | { processedAs: FakeTossStatus };

export interface FakeTossCall {
  api: 'confirm' | 'lookup' | 'other';
  path: string;
  idempotencyKey: string | null;
  authorization: string | null;
  body: unknown;
}

export interface FakeToss {
  readonly fetch: typeof globalThis.fetch;
  /** 결제창 인증까지 끝난 결제(IN_PROGRESS)를 만들고 결제 키를 준다. 성공 주소로 돌아온 순간과 같다. */
  authenticate(order: { id: string; amount: number }): string;
  /** 다음 호출들의 답을 차례로 정한다(다 쓰면 'pass'). committed는 승인에만 뜻이 있다. */
  script(api: 'confirm' | 'lookup', ...answers: FakeAnswer[]): void;
  /** 토스 쪽 상태를 바꾼다(다른 길의 승인, 대시보드 취소, 만료). */
  setStatus(paymentKey: string, status: FakeTossStatus): void;
  /** 받은 요청 전부. "토스 호출 0", 같은 멱등 키, Basic 인증 헤더 모양을 여기서 본다. */
  readonly calls: readonly FakeTossCall[];
  /** PAYMENT_STATUS_CHANGED 원문. 서버는 본문을 믿지 않으므로 아무 값이나 넣어 위조를 만들 수 있다. */
  webhookBody(p: { paymentKey: string; orderId: string; status: string }): Buffer;
}

interface FakePayment {
  paymentKey: string;
  orderId: string;
  totalAmount: number;
  status: FakeTossStatus;
}

interface Reply {
  httpStatus: number;
  text: string;
  contentType: string;
}

const jsonReply = (httpStatus: number, body: unknown): Reply => ({ httpStatus, text: JSON.stringify(body), contentType: 'application/json' });
const errorReply = (httpStatus: number, code: string): Reply => jsonReply(httpStatus, { code, message: `fake ${code}` });
const toResponse = (reply: Reply): Response =>
  new Response(reply.text, { status: reply.httpStatus, headers: { 'content-type': reply.contentType } });

function waitForAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function paymentObject(p: FakePayment): unknown {
  return {
    mId: 'tfakemerchant',
    version: '2024-06-01',
    paymentKey: p.paymentKey,
    orderId: p.orderId,
    orderName: 'Qrate 크레딧',
    status: p.status,
    totalAmount: p.totalAmount,
    method: '카드',
    requestedAt: '2026-11-09T13:00:00+09:00',
    approvedAt: p.status === 'DONE' ? '2026-11-09T13:00:05+09:00' : null,
  };
}

export function createFakeToss(): FakeToss {
  const payments = new Map<string, FakePayment>();
  const replies = new Map<string, Reply>();
  const inFlight = new Set<string>();
  const scripts: Record<'confirm' | 'lookup', FakeAnswer[]> = { confirm: [], lookup: [] };
  const calls: FakeTossCall[] = [];

  function processConfirm(body: { paymentKey?: unknown; orderId?: unknown; amount?: unknown }): Reply {
    const payment = typeof body.paymentKey === 'string' ? payments.get(body.paymentKey) : undefined;
    if (!payment || payment.status === 'READY' || payment.status === 'EXPIRED') return errorReply(404, 'NOT_FOUND_PAYMENT_SESSION');
    if (payment.status !== 'IN_PROGRESS') return errorReply(400, 'ALREADY_PROCESSED_PAYMENT');
    if (body.orderId !== payment.orderId || body.amount !== payment.totalAmount) return errorReply(403, 'FORBIDDEN_REQUEST');
    payment.status = 'DONE';
    return jsonReply(200, paymentObject(payment));
  }

  async function confirm(body: Record<string, unknown>, key: string | null, signal: AbortSignal | null | undefined): Promise<Response> {
    if (key) {
      const stored = replies.get(key);
      if (stored) return toResponse(stored);
      if (inFlight.has(key)) return toResponse(errorReply(409, 'IDEMPOTENT_REQUEST_PROCESSING'));
      inFlight.add(key);
    }
    const remember = (reply: Reply): Reply => {
      if (key) replies.set(key, reply);
      return reply;
    };
    try {
      // 처리 중인 순간을 둔다 — 같은 키의 동시 요청이 409를 보는 자리다.
      await new Promise((resolve) => setImmediate(resolve));
      const answer = scripts.confirm.shift() ?? 'pass';
      if (answer === 'pass') return toResponse(remember(processConfirm(body)));
      if (answer === 'hang') return await waitForAbort(signal);
      if (answer === 'reset') throw new TypeError('fetch failed');
      if ('committed' in answer) {
        const processed = processConfirm(body);
        if (answer.committed === 'hang') {
          remember(processed);
          return await waitForAbort(signal);
        }
        // 같은 키로 다시 물어도 이 오류가 재생되는 더 나쁜 쪽을 둔다 — 그러면 조회만 진실을 안다.
        return toResponse(remember(errorReply(answer.committed.httpStatus, answer.committed.code)));
      }
      if ('processedAs' in answer) {
        const processed = processConfirm(body);
        const payment = typeof body.paymentKey === 'string' ? payments.get(body.paymentKey) : undefined;
        if (processed.httpStatus !== 200 || !payment) return toResponse(remember(processed));
        payment.status = answer.processedAs;
        return toResponse(remember(jsonReply(200, paymentObject(payment))));
      }
      if ('raw' in answer) return toResponse({ httpStatus: answer.httpStatus, text: answer.raw, contentType: 'text/html' });
      return toResponse(remember(errorReply(answer.httpStatus, answer.code)));
    } finally {
      if (key) inFlight.delete(key);
    }
  }

  async function lookup(paymentKey: string, signal: AbortSignal | null | undefined): Promise<Response> {
    const answer = scripts.lookup.shift() ?? 'pass';
    if (answer === 'hang') return waitForAbort(signal);
    if (answer === 'reset') throw new TypeError('fetch failed');
    if (typeof answer === 'object' && ('committed' in answer || 'processedAs' in answer)) throw new Error('fake toss: committed·processedAs는 승인에만 쓴다');
    if (typeof answer === 'object' && 'raw' in answer) return toResponse({ httpStatus: answer.httpStatus, text: answer.raw, contentType: 'text/html' });
    if (typeof answer === 'object') return toResponse(errorReply(answer.httpStatus, answer.code));
    const payment = payments.get(paymentKey);
    return toResponse(payment ? jsonReply(200, paymentObject(payment)) : errorReply(404, 'NOT_FOUND_PAYMENT'));
  }

  const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== TOSS_ORIGIN) throw new TypeError(`fake toss: 토스가 아닌 곳으로 갔다 ${url.origin}`);
    const headers = new Headers(init.headers);
    const method = (init.method ?? 'GET').toUpperCase();
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const isConfirm = method === 'POST' && url.pathname === '/v1/payments/confirm';
    const lookupKey = method === 'GET' ? /^\/v1\/payments\/([^/]+)$/.exec(url.pathname)?.[1] : undefined;
    calls.push({
      api: isConfirm ? 'confirm' : lookupKey ? 'lookup' : 'other',
      path: url.pathname,
      idempotencyKey: headers.get('idempotency-key'),
      authorization: headers.get('authorization'),
      body,
    });
    if (isConfirm) return confirm((body ?? {}) as Record<string, unknown>, headers.get('idempotency-key'), init.signal);
    if (lookupKey) return lookup(decodeURIComponent(lookupKey), init.signal);
    return toResponse(errorReply(404, 'NOT_FOUND'));
  };

  return {
    fetch: fakeFetch,
    authenticate(order) {
      const paymentKey = `tgen_fake_${randomUUID().replaceAll('-', '')}`;
      payments.set(paymentKey, { paymentKey, orderId: order.id, totalAmount: order.amount, status: 'IN_PROGRESS' });
      return paymentKey;
    },
    script(api, ...answers) {
      scripts[api].push(...answers);
    },
    setStatus(paymentKey, status) {
      const payment = payments.get(paymentKey);
      if (!payment) throw new Error(`fake toss: 모르는 결제 키 ${paymentKey}`);
      payment.status = status;
    },
    calls,
    webhookBody({ paymentKey, orderId, status }) {
      const body = { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-11-09T13:00:06.000000', data: { mId: 'tfakemerchant', paymentKey, orderId, status } };
      return Buffer.from(JSON.stringify(body), 'utf8');
    },
  };
}
