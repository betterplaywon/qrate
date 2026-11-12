import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  MOCK_SIGNATURE_HEADER,
  paymentWebhookPath,
  type CreditsResponse,
  type SimulatePaymentResponse,
  type TopUpDto,
  type TopUpListResponse,
} from '@qrate/contracts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockProvider, signMockPayload } from '../src/billing/mock.js';
import type { PaymentProvider } from '../src/billing/provider.js';
import { hashConsoleKey } from '../src/console/key.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from '../src/repo/seed.js';
import { startApp, type RunningApp } from './helpers/app.js';

const OWN_ORIGIN = 'http://console.test';
const CONSOLE_KEY = 'demo-console-key';
const SECRET = 'test-secret-0123456789abcdef';
const MOCK_SECRET = 'mock-webhook-secret-0123456789';
const seed = loadSeedFile(DEFAULT_SEED_PATH);
const TENANT = seed.tenant.id;
const mock = createMockProvider(MOCK_SECRET);

interface Running extends RunningApp {
  cookie: string;
  reports: { err: unknown; context?: Record<string, unknown> }[];
}

async function start(payments: PaymentProvider | null): Promise<Running> {
  const reports: Running['reports'] = [];
  const app = await startApp({
    repos: createRepositoriesFromSeed(seed, { consoleKeyHash: hashConsoleKey(CONSOLE_KEY) }),
    publicOrigin: OWN_ORIGIN,
    reportError: (err, context) => void reports.push({ err, context }),
    console: { secret: SECRET },
    payments,
  });
  const res = await fetch(`${app.url}/api/console/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
    body: JSON.stringify({ tenant: 'demo', key: CONSOLE_KEY }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { ...app, cookie, reports };
}

let withMock: Running;
let withoutPayments: Running;

beforeAll(async () => {
  [withMock, withoutPayments] = await Promise.all([start(mock), start(null)]);
});

afterAll(() => Promise.all([withMock.close(), withoutPayments.close()]));

function consolePost(run: Running, p: string, cookie: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${run.url}/api/console${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: OWN_ORIGIN, cookie, ...headers },
    body: JSON.stringify(body),
  });
}

const requestTopUp = (run: Running, cookie: string, packageId: string, key: string | null, headers: Record<string, string> = {}) =>
  consolePost(run, '/top-ups', cookie, { packageId }, { ...(key === null ? {} : { [IDEMPOTENCY_KEY_HEADER]: key }), ...headers });

const simulate = (run: Running, cookie: string, id: string, result: string, headers: Record<string, string> = {}) =>
  consolePost(run, `/top-ups/${encodeURIComponent(id)}/simulate`, cookie, { result }, headers);

async function balance(run: Running, cookie: string): Promise<number> {
  const res = await fetch(`${run.url}/api/console/credits`, { headers: { cookie } });
  return ((await res.json()) as CreditsResponse).balance;
}

function postWebhook(run: Running, rawBody: Buffer, headers: Record<string, string>, provider = 'mock') {
  return fetch(`${run.url}${paymentWebhookPath(provider)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  });
}

async function newTopUp(run: Running, cookie: string, packageId = 'credits_100'): Promise<TopUpDto> {
  const res = await requestTopUp(run, cookie, packageId, randomUUID());
  expect(res.status).toBe(201);
  return (await res.json()) as TopUpDto;
}

describe('충전 요청 — 콘솔의 재시도는 같은 주문이 된다', () => {
  it('201 → 같은 키 재요청은 201 + Idempotent-Replayed + 같은 본문 → 같은 키·다른 상품 422 — 주문은 하나', async () => {
    const { cookie } = withMock;
    const key = randomUUID();
    const first = await requestTopUp(withMock, cookie, 'credits_500', key);
    expect(first.status).toBe(201);
    expect(first.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    const created = (await first.json()) as TopUpDto;
    expect(created).toMatchObject({ packageId: 'credits_500', credits: 500, amount: 50_000, provider: 'mock', status: 'pending', settledAt: null });

    const retry = await requestTopUp(withMock, cookie, 'credits_500', key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(await retry.json()).toEqual(created);

    const reused = await requestTopUp(withMock, cookie, 'credits_100', key);
    expect(reused.status).toBe(422);
    expect(await reused.json()).toEqual({ error: 'idempotency_key_reused' });

    const list = (await (await fetch(`${withMock.url}/api/console/top-ups`, { headers: { cookie } })).json()) as TopUpListResponse;
    expect(list.provider).toBe('mock');
    expect(list.items.filter((t) => t.id === created.id)).toHaveLength(1);
    expect(list.items[0]?.id).toBe(created.id);
  });

  it('그 사이 결제가 끝나도 같은 키 재요청의 본문은 처음 201 본문과 같다 — 지금 상태는 목록이 보여 준다', async () => {
    const { cookie } = withMock;
    const key = randomUUID();
    const first = await requestTopUp(withMock, cookie, 'credits_100', key);
    const created = (await first.json()) as TopUpDto;
    expect((await simulate(withMock, cookie, created.id, 'paid')).status).toBe(200);

    const retry = await requestTopUp(withMock, cookie, 'credits_100', key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(await retry.json()).toEqual(created);

    const list = (await (await fetch(`${withMock.url}/api/console/top-ups`, { headers: { cookie } })).json()) as TopUpListResponse;
    expect(list.items.find((t) => t.id === created.id)?.status).toBe('paid');
  });

  it('키 없음·형식 틀림은 400 invalid_idempotency_key, 모르는 상품·금액을 보낸 본문은 400 invalid_package', async () => {
    const { cookie } = withMock;
    for (const key of [null, 'short', 'has space in key', 'x'.repeat(129), 'dotted.key.value'] as const) {
      const res = await requestTopUp(withMock, cookie, 'credits_100', key);
      expect(res.status, String(key)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_idempotency_key' });
    }
    const unknown = await requestTopUp(withMock, cookie, 'credits_7', randomUUID());
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: 'invalid_package' });
    const priced = await consolePost(withMock, '/top-ups', cookie, { amount: 1 }, { [IDEMPOTENCY_KEY_HEADER]: randomUUID() });
    expect(priced.status).toBe(400);
  });

  it('세션이 없으면 401, 다른 오리진에서 온 충전 요청·결제 시뮬레이션은 403', async () => {
    const { cookie } = withMock;
    expect((await requestTopUp(withMock, '', 'credits_100', randomUUID())).status).toBe(401);
    expect((await fetch(`${withMock.url}/api/console/top-ups`)).status).toBe(401);
    const evil = { origin: 'https://evil.example' };
    expect((await requestTopUp(withMock, cookie, 'credits_100', randomUUID(), evil)).status).toBe(403);
    const topUp = await newTopUp(withMock, cookie);
    expect((await simulate(withMock, cookie, topUp.id, 'paid', evil)).status).toBe(403);
  });
});

describe('결제 시뮬레이션 — 모의 제공자가 서명한 웹훅을 같은 처리에 넣는다', () => {
  it('성공 → 충전(applied) → 같은 버튼은 재배달(replayed, 잔액 그대로) → 늦게 온 실패는 stale, paid 유지', async () => {
    const { cookie } = withMock;
    const topUp = await newTopUp(withMock, cookie);
    const before = await balance(withMock, cookie);

    const paid = await simulate(withMock, cookie, topUp.id, 'paid');
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ outcome: 'applied', replayed: false, topUp: { id: topUp.id, status: 'paid' } });
    expect(await balance(withMock, cookie)).toBe(before + 100);

    const again = (await (await simulate(withMock, cookie, topUp.id, 'paid')).json()) as SimulatePaymentResponse;
    expect(again).toMatchObject({ outcome: 'applied', replayed: true, topUp: { status: 'paid' } });
    const late = (await (await simulate(withMock, cookie, topUp.id, 'failed')).json()) as SimulatePaymentResponse;
    expect(late).toMatchObject({ outcome: 'stale', replayed: false, topUp: { status: 'paid' } });
    expect(await balance(withMock, cookie)).toBe(before + 100);
  });

  it('다른 테넌트의 주문·없는 주문은 404, 결과 값이 틀리면 400 invalid_result', async () => {
    const { cookie } = withMock;
    const { topUp: foreign } = await withMock.repos.topUps.create('other-tenant', {
      requestKey: randomUUID(),
      packageId: 'credits_100',
      credits: 100,
      amount: 10_000,
      provider: 'mock',
    });
    expect((await simulate(withMock, cookie, foreign.id, 'paid')).status).toBe(404);
    expect((await withMock.repos.topUps.findById(foreign.id))?.status).toBe('pending');
    expect((await simulate(withMock, cookie, 'missing', 'paid')).status).toBe(404);
    const mine = await newTopUp(withMock, cookie);
    const bad = await simulate(withMock, cookie, mine.id, 'refunded');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_result' });
  });

  it('모의 제공자 서버에는 토스 확정 경로가 없다(404)', async () => {
    const { cookie } = withMock;
    const topUp = await newTopUp(withMock, cookie);
    const res = await consolePost(withMock, `/top-ups/${topUp.id}/confirm`, cookie, { paymentKey: 'tgen_x', amount: topUp.amount });
    expect(res.status).toBe(404);
    expect((await withMock.repos.topUps.findById(topUp.id))?.status).toBe('pending');
  });
});

describe('결제 웹훅 — 재배달·순서 뒤바뀜·위조', () => {
  it('200 applied → 같은 바이트 재전송은 200 + Idempotent-Replayed, 같은 본문 → 잔액은 한 번만', async () => {
    const { cookie } = withMock;
    const topUp = await newTopUp(withMock, cookie);
    const before = await balance(withMock, cookie);
    const { rawBody, headers } = mock.signEvent({ orderId: topUp.id, amount: topUp.amount, result: 'paid', eventId: `evt-${randomUUID()}` }, new Date());
    const sig = { [MOCK_SIGNATURE_HEADER]: String(headers[MOCK_SIGNATURE_HEADER]) };

    const first = await postWebhook(withMock, rawBody, sig);
    expect(first.status).toBe(200);
    expect(first.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(await first.json()).toEqual({ outcome: 'applied' });
    for (let i = 0; i < 3; i += 1) {
      const again = await postWebhook(withMock, rawBody, sig);
      expect(again.status).toBe(200);
      expect(again.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
      expect(await again.json()).toEqual({ outcome: 'applied' });
    }
    expect(await balance(withMock, cookie)).toBe(before + 100);
  });

  it('위조: 금액 변조·다른 비밀·만료(301초 전)·서명 없음은 401 invalid_signature이고 원장은 그대로', async () => {
    const { cookie } = withMock;
    const topUp = await newTopUp(withMock, cookie);
    const before = await balance(withMock, cookie);
    const now = Math.floor(Date.now() / 1000);
    const body = (amount: number) =>
      Buffer.from(JSON.stringify({ id: `evt-${randomUUID()}`, type: 'payment.paid', created: now, data: { orderId: topUp.id, amount } }));

    const honest = body(topUp.amount);
    const tampered = Buffer.from(honest.toString('utf8').replace(String(topUp.amount), '1000000'));
    const cases: [string, Buffer, Record<string, string>][] = [
      ['금액 변조', tampered, { [MOCK_SIGNATURE_HEADER]: signMockPayload(MOCK_SECRET, honest, now) }],
      ['다른 비밀', honest, { [MOCK_SIGNATURE_HEADER]: signMockPayload('attacker-secret-0123456789', honest, now) }],
      ['만료', honest, { [MOCK_SIGNATURE_HEADER]: signMockPayload(MOCK_SECRET, honest, now - 301) }],
      ['서명 없음', honest, {}],
      ['빈 본문', Buffer.alloc(0), { [MOCK_SIGNATURE_HEADER]: signMockPayload(MOCK_SECRET, honest, now) }],
    ];
    for (const [name, raw, headers] of cases) {
      const res = await postWebhook(withMock, raw, headers);
      expect(res.status, name).toBe(401);
      expect(await res.json(), name).toEqual({ error: 'invalid_signature' });
    }
    expect(await balance(withMock, cookie)).toBe(before);
    expect((await withMock.repos.topUps.findById(topUp.id))?.status).toBe('pending');
  });

  it('서명은 맞는데 JSON이 깨졌으면 400 invalid_webhook, 모르는 제공자는 404, 16kb를 넘으면 413', async () => {
    const now = Math.floor(Date.now() / 1000);
    const broken = Buffer.from('{"id":');
    const res = await postWebhook(withMock, broken, { [MOCK_SIGNATURE_HEADER]: signMockPayload(MOCK_SECRET, broken, now) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_webhook' });

    const { rawBody, headers } = mock.signEvent({ orderId: 'x', amount: 1, result: 'paid' }, new Date());
    const sig = { [MOCK_SIGNATURE_HEADER]: String(headers[MOCK_SIGNATURE_HEADER]) };
    for (const provider of ['toss', '__proto__', 'constructor']) {
      const unknown = await postWebhook(withMock, rawBody, sig, provider);
      expect(unknown.status, provider).toBe(404);
      expect(await unknown.json()).toEqual({ error: 'not_found' });
    }
    const huge = Buffer.alloc(17 * 1024, 'a');
    expect((await postWebhook(withMock, huge, { [MOCK_SIGNATURE_HEADER]: signMockPayload(MOCK_SECRET, huge, now) })).status).toBe(413);
  });

  it('순서 뒤바뀜: 실패 웹훅 뒤 결제 완료 웹훅은 충전, 그 뒤의 실패는 stale', async () => {
    const { cookie } = withMock;
    const topUp = await newTopUp(withMock, cookie);
    const before = await balance(withMock, cookie);
    const deliver = async (result: 'paid' | 'failed') => {
      const { rawBody, headers } = mock.signEvent({ orderId: topUp.id, amount: topUp.amount, result, eventId: `evt-${randomUUID()}` }, new Date());
      const res = await postWebhook(withMock, rawBody, { [MOCK_SIGNATURE_HEADER]: String(headers[MOCK_SIGNATURE_HEADER]) });
      expect(res.status).toBe(200);
      return ((await res.json()) as { outcome: string }).outcome;
    };
    expect(await deliver('failed')).toBe('applied');
    expect(await balance(withMock, cookie)).toBe(before);
    expect(await deliver('paid')).toBe('applied');
    expect(await deliver('failed')).toBe('stale');
    expect(await deliver('paid')).toBe('stale');
    expect(await balance(withMock, cookie)).toBe(before + 100);
    expect((await withMock.repos.topUps.findById(topUp.id))?.status).toBe('paid');
  });

  it('서명은 맞는데 금액이 다르거나 모르는 주문이면 200(받음) + 이유, 보고 통로로 알리고 원장은 그대로', async () => {
    const { cookie } = withMock;
    const topUp = await newTopUp(withMock, cookie);
    const before = await balance(withMock, cookie);
    withMock.reports.length = 0;
    for (const [orderId, amount, outcome] of [
      [topUp.id, topUp.amount - 1, 'amount_mismatch'],
      ['no-such-order', 10_000, 'unknown_order'],
    ] as const) {
      const { rawBody, headers } = mock.signEvent({ orderId, amount, result: 'paid' }, new Date());
      const res = await postWebhook(withMock, rawBody, { [MOCK_SIGNATURE_HEADER]: String(headers[MOCK_SIGNATURE_HEADER]) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome });
    }
    expect(withMock.reports.map((r) => r.context?.orderId)).toEqual([topUp.id, 'no-such-order']);
    expect(await balance(withMock, cookie)).toBe(before);
  });
});

describe('결제 제공자가 없는 서버(운영 기본)', () => {
  it('목록의 provider는 null, 충전 요청은 503, 결제 시뮬레이션·확정 경로와 모의 웹훅은 404', async () => {
    const run = withoutPayments;
    const { cookie } = run;
    const list = (await (await fetch(`${run.url}/api/console/top-ups`, { headers: { cookie } })).json()) as TopUpListResponse;
    expect(list).toEqual({ provider: null, items: [], nextCursor: null });

    const res = await requestTopUp(run, cookie, 'credits_100', randomUUID());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'payments_unavailable' });

    const { topUp } = await run.repos.topUps.create(TENANT, { requestKey: randomUUID(), packageId: 'credits_100', credits: 100, amount: 10_000, provider: 'mock' });
    expect((await simulate(run, cookie, topUp.id, 'paid')).status).toBe(404);
    expect((await consolePost(run, `/top-ups/${topUp.id}/confirm`, cookie, { paymentKey: 'tgen_x', amount: topUp.amount })).status).toBe(404);

    const { rawBody, headers } = mock.signEvent({ orderId: topUp.id, amount: topUp.amount, result: 'paid' }, new Date());
    const webhook = await postWebhook(run, rawBody, { [MOCK_SIGNATURE_HEADER]: String(headers[MOCK_SIGNATURE_HEADER]) });
    expect(webhook.status).toBe(404);
    expect((await run.repos.topUps.findById(topUp.id))?.status).toBe('pending');
  });
});
