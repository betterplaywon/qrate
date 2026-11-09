import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { PaymentReading } from '../src/billing/provider.js';
import { createBillingService } from '../src/billing/service.js';
import { createTossProvider, parseTossKeys, type TossPaymentProvider } from '../src/billing/toss.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from '../src/repo/seed.js';
import { createFakeToss, type FakeAnswer, type FakeTossStatus } from './helpers/fake-toss.js';

const seed = loadSeedFile(DEFAULT_SEED_PATH);
const TENANT = seed.tenant.id;
const CLIENT_KEY = 'test_gck_fake0001';
const SECRET_KEY = 'test_gsk_fake0001';
const KEYS = parseTossKeys({ clientKey: CLIENT_KEY, secretKey: SECRET_KEY });
const TOSS_API = 'https://api.tosspayments.com';
const BASIC = `Basic ${Buffer.from(`${SECRET_KEY}:`).toString('base64')}`;

function setup() {
  const toss = createFakeToss();
  const payments = createTossProvider({ ...KEYS, fetch: toss.fetch, timeouts: { confirmMs: 200, lookupMs: 100 } });
  const repos = createRepositoriesFromSeed(seed);
  const reports: { err: unknown; context?: Record<string, unknown> }[] = [];
  const settle = vi.spyOn(repos.topUps, 'settle');
  const billing = createBillingService({ repos, payments, reportError: (err, context) => void reports.push({ err, context }) });
  async function newOrder() {
    const created = await billing.requestTopUp(TENANT, { requestKey: randomUUID(), packageId: 'credits_100' });
    if (created.status !== 'created') throw new Error(created.status);
    return created.topUp;
  }
  return {
    toss,
    payments,
    reports,
    settle,
    billing,
    newOrder,
    status: async (id: string) => (await repos.topUps.findById(id))?.status,
    balance: () => repos.credits.balance(TENANT),
  };
}

async function readThroughWebhook(payments: TossPaymentProvider, rawBody: Buffer): Promise<PaymentReading> {
  const notice = payments.readWebhook({ rawBody, headers: {} }, new Date());
  if (!notice.ok) throw new Error(`웹훅을 읽지 못함: ${notice.reason}`);
  return notice.read();
}

const confirmRequest = (fetch: typeof globalThis.fetch, idempotencyKey: string, body: unknown) =>
  fetch(`${TOSS_API}/v1/payments/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });

describe('가짜 토스 — 실측한 토스처럼 답한다', () => {
  it('같은 멱등 키는 첫 응답을 재생한다 — 오류도. 다른 키는 새로 처리한다', async () => {
    const toss = createFakeToss();
    const order = { id: 'order-fake-0001', amount: 10_000 };
    const paymentKey = toss.authenticate(order);
    const body = { paymentKey, orderId: order.id, amount: order.amount };
    toss.script('confirm', { httpStatus: 400, code: 'PROVIDER_ERROR' });
    expect((await confirmRequest(toss.fetch, 'K1', body)).status).toBe(400);
    const replayed = await confirmRequest(toss.fetch, 'K1', body);
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toMatchObject({ code: 'PROVIDER_ERROR' });
    const fresh = await confirmRequest(toss.fetch, 'K2', body);
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({ paymentKey, orderId: order.id, status: 'DONE', totalAmount: 10_000 });
  });

  it('같은 키의 첫 요청이 처리 중이면 409이고, 그 409는 저장하지 않는다', async () => {
    const toss = createFakeToss();
    const order = { id: 'order-fake-0002', amount: 10_000 };
    const body = { paymentKey: toss.authenticate(order), orderId: order.id, amount: order.amount };
    const both = await Promise.all([confirmRequest(toss.fetch, 'K', body), confirmRequest(toss.fetch, 'K', body)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await confirmRequest(toss.fetch, 'K', body)).status).toBe(200);
  });

  it('모르는 결제 키: 조회는 404 NOT_FOUND_PAYMENT, 승인은 404 NOT_FOUND_PAYMENT_SESSION', async () => {
    const toss = createFakeToss();
    const lookup = await toss.fetch(`${TOSS_API}/v1/payments/tgen_unknown_0001`);
    expect(lookup.status).toBe(404);
    expect(await lookup.json()).toMatchObject({ code: 'NOT_FOUND_PAYMENT' });
    const confirm = await confirmRequest(toss.fetch, 'K', { paymentKey: 'tgen_unknown_0001', orderId: 'order-fake-0003', amount: 1 });
    expect(confirm.status).toBe(404);
    expect(await confirm.json()).toMatchObject({ code: 'NOT_FOUND_PAYMENT_SESSION' });
  });
});

describe('토스 상태 표 — 판정은 조회한 상태로 한다(웹훅 본문은 DONE이라고 해도)', () => {
  const order = { id: 'order-table-0001', amount: 10_000 };
  const event = (paymentKey: string, status: string, result: 'paid' | 'failed'): PaymentReading => ({
    kind: 'event',
    event: { provider: 'toss', eventId: `${paymentKey}:${status}`, orderId: order.id, result, amount: 10_000 },
  });
  const unsettled = (status: string, scope: 'open' | 'out_of_scope'): PaymentReading => ({ kind: 'unsettled', scope, status, detail: null });
  const cases: [FakeTossStatus, (paymentKey: string) => PaymentReading][] = [
    ['DONE', (k) => event(k, 'DONE', 'paid')],
    ['ABORTED', (k) => event(k, 'ABORTED', 'failed')],
    ['EXPIRED', (k) => event(k, 'EXPIRED', 'failed')],
    ['READY', () => unsettled('READY', 'open')],
    ['IN_PROGRESS', () => unsettled('IN_PROGRESS', 'open')],
    ['WAITING_FOR_DEPOSIT', () => unsettled('WAITING_FOR_DEPOSIT', 'open')],
    ['CANCELED', () => unsettled('CANCELED', 'out_of_scope')],
    ['PARTIAL_CANCELED', () => unsettled('PARTIAL_CANCELED', 'out_of_scope')],
  ];

  it.each(cases)('%s', async (status, expected) => {
    const toss = createFakeToss();
    const payments = createTossProvider({ ...KEYS, fetch: toss.fetch });
    const paymentKey = toss.authenticate(order);
    toss.setStatus(paymentKey, status);
    const reading = await readThroughWebhook(payments, toss.webhookBody({ paymentKey, orderId: order.id, status: 'DONE' }));
    expect(reading).toEqual(expected(paymentKey));
  });
});

describe('조회 실패의 분류 — 404 NOT_FOUND_PAYMENT·NOT_FOUND만 "없음"이고 나머지는 "묻지 못함"', () => {
  const cases: [string, FakeAnswer, PaymentReading['kind']][] = [
    ['404 NOT_FOUND_PAYMENT → 없음', { httpStatus: 404, code: 'NOT_FOUND_PAYMENT' }, 'not_found'],
    ['404 NOT_FOUND → 없음', { httpStatus: 404, code: 'NOT_FOUND' }, 'not_found'],
    ['404 NOT_FOUND_MERCHANT(키·상점 문제) → 묻지 못함', { httpStatus: 404, code: 'NOT_FOUND_MERCHANT' }, 'unavailable'],
    ['401 UNAUTHORIZED_KEY → 묻지 못함', { httpStatus: 401, code: 'UNAUTHORIZED_KEY' }, 'unavailable'],
    ['403 FORBIDDEN_CONSECUTIVE_REQUEST → 묻지 못함', { httpStatus: 403, code: 'FORBIDDEN_CONSECUTIVE_REQUEST' }, 'unavailable'],
    ['500 FAILED_INTERNAL_SYSTEM_PROCESSING → 묻지 못함', { httpStatus: 500, code: 'FAILED_INTERNAL_SYSTEM_PROCESSING' }, 'unavailable'],
    ['502 HTML 오류 페이지 → 묻지 못함', { httpStatus: 502, raw: '<html>bad gateway</html>' }, 'unavailable'],
    ['200인데 결제 객체가 아님 → 묻지 못함', { httpStatus: 200, raw: 'ok' }, 'unavailable'],
    ['시간 초과 → 묻지 못함', 'hang', 'unavailable'],
    ['연결 끊김 → 묻지 못함', 'reset', 'unavailable'],
  ];

  it.each(cases)('%s', async (_name, answer, kind) => {
    const toss = createFakeToss();
    const payments = createTossProvider({ ...KEYS, fetch: toss.fetch, timeouts: { lookupMs: 50 } });
    toss.script('lookup', answer);
    const reading = await readThroughWebhook(payments, toss.webhookBody({ paymentKey: 'tgen_any_0001', orderId: 'order-any-0001', status: 'DONE' }));
    expect(reading.kind).toBe(kind);
  });
});

describe('승인 — 답이 결제 객체가 아니면 이유를 가리지 않고 같은 결제를 조회해 판정한다', () => {
  const committed: [string, FakeAnswer][] = [
    ['400 PROVIDER_ERROR', { committed: { httpStatus: 400, code: 'PROVIDER_ERROR' } }],
    ['409 IDEMPOTENT_REQUEST_PROCESSING', { committed: { httpStatus: 409, code: 'IDEMPOTENT_REQUEST_PROCESSING' } }],
    ['500 FAILED_INTERNAL_SYSTEM_PROCESSING', { committed: { httpStatus: 500, code: 'FAILED_INTERNAL_SYSTEM_PROCESSING' } }],
    ['응답 끊김', { committed: 'hang' }],
  ];

  it.each(committed)('승인은 처리됐는데 답이 %s → 조회가 DONE이라 충전', async (_name, answer) => {
    const { toss, billing, newOrder, balance } = setup();
    const topUp = await newOrder();
    const paymentKey = toss.authenticate(topUp);
    const before = await balance();
    toss.script('confirm', answer);
    expect(await billing.confirmTopUp(TENANT, { orderId: topUp.id, paymentKey, amount: topUp.amount })).toMatchObject({
      status: 'settled',
      result: { outcome: 'applied', replayed: false, topUp: { status: 'paid' } },
    });
    expect(await balance()).toBe(before + 100);
    expect(toss.calls.map((c) => c.api)).toEqual(['confirm', 'lookup']);
  });

  it('처리되지 않은 오류면 조회가 IN_PROGRESS라 unconfirmed — 주문 대기, 잔액 그대로, 이유는 보고에 남는다', async () => {
    const { toss, billing, newOrder, balance, status, reports } = setup();
    const topUp = await newOrder();
    const paymentKey = toss.authenticate(topUp);
    const before = await balance();
    toss.script('confirm', { httpStatus: 400, code: 'PROVIDER_ERROR' });
    expect(await billing.confirmTopUp(TENANT, { orderId: topUp.id, paymentKey, amount: topUp.amount })).toEqual({ status: 'unconfirmed' });
    expect(await status(topUp.id)).toBe('pending');
    expect(await balance()).toBe(before);
    expect(reports.map((r) => r.context)).toEqual([
      { where: 'billing.confirm', provider: 'toss', orderId: topUp.id, status: 'IN_PROGRESS', scope: 'open', detail: 'confirm 400 PROVIDER_ERROR' },
    ]);
  });

  it('같은 결제의 재확정은 같은 멱등 키다 — 토스가 첫 오류를 재생하면 결과도 같다(키를 바꿔 다시 승인하지 않는다)', async () => {
    const { toss, billing, newOrder } = setup();
    const topUp = await newOrder();
    const input = { orderId: topUp.id, paymentKey: toss.authenticate(topUp), amount: topUp.amount };
    toss.script('confirm', { httpStatus: 400, code: 'PROVIDER_ERROR' });
    expect(await billing.confirmTopUp(TENANT, input)).toEqual({ status: 'unconfirmed' });
    expect(await billing.confirmTopUp(TENANT, input)).toEqual({ status: 'unconfirmed' });
    const keys = toss.calls.filter((c) => c.api === 'confirm').map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('웹훅 — 본문을 믿지 않고 조회한 결제로만 판정한다', () => {
  it('위조(조회가 그런 결제는 없다고 답함) → unverified, 사건 행을 만들지 않고 주문은 그대로', async () => {
    const { toss, billing, newOrder, settle, status } = setup();
    const topUp = await newOrder();
    const forged = toss.webhookBody({ paymentKey: 'tgen_forged_0001', orderId: topUp.id, status: 'DONE' });
    expect(await billing.receiveWebhook('toss', { rawBody: forged, headers: {} })).toEqual({ status: 'unverified' });
    expect(settle).not.toHaveBeenCalled();
    expect(await status(topUp.id)).toBe('pending');
  });

  it('CANCELED는 반영하지 않고 기록만 한다 — unsettled, 보고에 상태, 사건 행 없음', async () => {
    const { toss, billing, newOrder, settle, status, reports } = setup();
    const topUp = await newOrder();
    const paymentKey = toss.authenticate(topUp);
    toss.setStatus(paymentKey, 'CANCELED');
    const body = toss.webhookBody({ paymentKey, orderId: topUp.id, status: 'CANCELED' });
    expect(await billing.receiveWebhook('toss', { rawBody: body, headers: {} })).toEqual({ status: 'unsettled' });
    expect(settle).not.toHaveBeenCalled();
    expect(await status(topUp.id)).toBe('pending');
    expect(reports.map((r) => r.context)).toEqual([
      { where: 'billing.webhook', provider: 'toss', orderId: topUp.id, status: 'CANCELED', scope: 'out_of_scope', detail: null },
    ]);
  });

  it('본문의 주문과 조회한 결제의 주문이 다르면 order_mismatch — 남의 결제로 이 주문을 충전하지 않는다', async () => {
    const { toss, billing, newOrder, status, balance } = setup();
    const mine = await newOrder();
    const other = await newOrder();
    const paymentKey = toss.authenticate(other);
    toss.setStatus(paymentKey, 'DONE');
    const before = await balance();
    const body = toss.webhookBody({ paymentKey, orderId: mine.id, status: 'DONE' });
    expect(await billing.receiveWebhook('toss', { rawBody: body, headers: {} })).toEqual({ status: 'ignored', reason: 'order_mismatch' });
    expect(await status(mine.id)).toBe('pending');
    expect(await balance()).toBe(before);
  });
});

describe('시크릿 키는 toss.ts의 클로저 밖으로 나가지 않는다', () => {
  it('제공자 객체를 찍어도, 실패를 보고해도 없다. 토스에는 Basic base64(시크릿 키 + ":")로만 간다', async () => {
    const { toss, payments, billing, newOrder, reports } = setup();
    expect(JSON.stringify(payments)).not.toContain(SECRET_KEY);
    expect(inspect(payments, { depth: 10, showHidden: true })).not.toContain(SECRET_KEY);

    const topUp = await newOrder();
    const paymentKey = toss.authenticate(topUp);
    toss.script('confirm', { httpStatus: 401, code: 'UNAUTHORIZED_KEY' });
    toss.script('lookup', { httpStatus: 401, code: 'UNAUTHORIZED_KEY' });
    expect(await billing.confirmTopUp(TENANT, { orderId: topUp.id, paymentKey, amount: topUp.amount })).toEqual({ status: 'unconfirmed' });
    const reported = reports.map((r) => `${String(r.err)} ${JSON.stringify(r.context)}`).join('\n');
    expect(reported).toContain('confirm 401 UNAUTHORIZED_KEY; lookup 401 UNAUTHORIZED_KEY');
    expect(reported).not.toContain(SECRET_KEY);
    expect(reported).not.toContain(BASIC);
    expect(toss.calls.map((c) => c.authorization)).toEqual([BASIC, BASIC]);
  });
});

describe('키 검증 — 시작 때 한 번', () => {
  it('두 키 모두 결제창형 테스트 키여야 한다. 오류 문장에는 키 값이 없다', () => {
    expect(parseTossKeys({ clientKey: 'test_gck_abc_0001', secretKey: 'test_gsk_def_0001' })).toEqual({
      clientKey: 'test_gck_abc_0001',
      secretKey: 'test_gsk_def_0001',
    });
    const rejected: [string, { clientKey?: string; secretKey?: string }, RegExp][] = [
      ['클라이언트 키 없음', { secretKey: 'test_gsk_only0001' }, /없음: QRATE_TOSS_CLIENT_KEY\)/],
      ['시크릿 키 없음', { clientKey: 'test_gck_only0001' }, /없음: QRATE_TOSS_SECRET_KEY\)/],
      ['둘 다 없음', {}, /없음: QRATE_TOSS_CLIENT_KEY·QRATE_TOSS_SECRET_KEY\)/],
      ['라이브 키', { clientKey: 'live_gck_real0001', secretKey: 'live_gsk_real0001' }, /QRATE_TOSS_CLIENT_KEY는 결제창형 테스트/],
      ['API 개별 연동 키', { clientKey: 'test_ck_api0001', secretKey: 'test_sk_api0001' }, /QRATE_TOSS_CLIENT_KEY는 결제창형 테스트/],
      ['라이브 시크릿 키만', { clientKey: 'test_gck_ok0001', secretKey: 'live_gsk_real0002' }, /QRATE_TOSS_SECRET_KEY는 결제창형 테스트/],
      ['시크릿 자리에 클라이언트 키', { clientKey: 'test_gck_ok0002', secretKey: 'test_gck_ok0002' }, /QRATE_TOSS_SECRET_KEY는 결제창형 테스트/],
    ];
    for (const [name, raw, message] of rejected) {
      let thrown: unknown = '던지지 않음';
      try {
        parseTossKeys({ clientKey: raw.clientKey, secretKey: raw.secretKey });
      } catch (err) {
        thrown = err;
      }
      expect(String(thrown), name).toMatch(message);
      for (const value of Object.values(raw)) expect(String(thrown), name).not.toContain(value);
    }
  });
});
