import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  paymentWebhookPath,
  type ConfirmTopUpResponse,
  type CreditsResponse,
  type TopUpDto,
} from '@qrate/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTossProvider, parseTossKeys } from '../src/billing/toss.js';
import { hashConsoleKey } from '../src/console/key.js';
import { MockEngine } from '../src/engine/mock.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from '../src/repo/seed.js';
import type { Repositories } from '../src/repo/types.js';
import { createFakeToss, type FakeConfirmAnswer, type FakeLookupAnswer } from './helpers/fake-toss.js';

const OWN_ORIGIN = 'http://console.test';
const CONSOLE_KEY = 'demo-console-key';
const SESSION_SECRET = 'test-secret-0123456789abcdef';
const CLIENT_KEY = 'test_gck_fake0001';
const SECRET_KEY = 'test_gsk_fake0001';
const seed = loadSeedFile(DEFAULT_SEED_PATH);
const TENANT = seed.tenant.id;
const frameAssetsDir = mkdtempSync(path.join(tmpdir(), 'qrate-toss-'));
const toss = createFakeToss();

let url: string;
let cookie: string;
let repos: Repositories;
let server: Server;

beforeAll(async () => {
  repos = createRepositoriesFromSeed(seed, { consoleKeyHash: hashConsoleKey(CONSOLE_KEY) });
  const keys = parseTossKeys({ clientKey: CLIENT_KEY, secretKey: SECRET_KEY });
  const app = createApp({
    engine: new MockEngine(0),
    repos,
    publicOrigin: OWN_ORIGIN,
    frameAssetsDir,
    reportError: () => undefined,
    console: { secret: SESSION_SECRET },
    payments: createTossProvider({ ...keys, fetch: toss.fetch, timeouts: { confirmMs: 300, lookupMs: 150 } }),
  });
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${url}/api/console/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
    body: JSON.stringify({ tenant: 'demo', key: CONSOLE_KEY }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(frameAssetsDir, { recursive: true, force: true });
});

function consolePost(p: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/api/console${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: OWN_ORIGIN, cookie, ...headers },
    body: JSON.stringify(body),
  });
}

const confirm = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  consolePost(`/top-ups/${encodeURIComponent(id)}/confirm`, body, headers);

const postWebhook = (rawBody: Buffer | string) =>
  fetch(`${url}${paymentWebhookPath('toss')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rawBody });

async function newTopUp(): Promise<TopUpDto> {
  const res = await consolePost('/top-ups', { packageId: 'credits_100' }, { [IDEMPOTENCY_KEY_HEADER]: randomUUID() });
  expect(res.status).toBe(201);
  return (await res.json()) as TopUpDto;
}

async function balance(): Promise<number> {
  const res = await fetch(`${url}/api/console/credits`, { headers: { cookie } });
  return ((await res.json()) as CreditsResponse).balance;
}

const statusOf = async (id: string) => (await repos.topUps.findById(id))?.status;
const ledgerLines = async (topUpId: string) =>
  (await repos.credits.list(TENANT, { limit: 100 })).items.filter((e) => e.idempotencyKey === `topup:${topUpId}`).length;

describe('충전 목록 — 콘솔이 결제창을 여는 값', () => {
  it('provider toss와 clientKey를 준다. 시크릿 키는 응답에 없다', async () => {
    const res = await fetch(`${url}/api/console/top-ups`, { headers: { cookie } });
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ provider: 'toss', clientKey: CLIENT_KEY, nextCursor: null });
    expect(text).not.toContain(SECRET_KEY);
  });
});

describe('충전 확정 — 결제창에서 돌아온 결제를 서버가 토스 승인으로 확정한다', () => {
  it('승인 성공 → 200 applied·원장 한 줄, 같은 결제의 재확정 → replayed·원장 그대로, 토스에는 같은 멱등 키', async () => {
    const topUp = await newTopUp();
    const paymentKey = toss.authenticate(topUp);
    const before = await balance();
    const callsBefore = toss.calls.length;

    const first = await confirm(topUp.id, { paymentKey, amount: topUp.amount });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: 'applied', replayed: false, topUp: { id: topUp.id, provider: 'toss', status: 'paid' } });
    const again = await confirm(topUp.id, { paymentKey, amount: topUp.amount });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ outcome: 'applied', replayed: true, topUp: { status: 'paid' } });

    expect(await balance()).toBe(before + 100);
    expect(await ledgerLines(topUp.id)).toBe(1);
    const sent = toss.calls.slice(callsBefore);
    expect(sent.map((c) => c.api)).toEqual(['confirm', 'confirm']);
    expect(new Set(sent.map((c) => c.idempotencyKey)).size).toBe(1);
    expect(sent[0]?.body).toEqual({ paymentKey, orderId: topUp.id, amount: topUp.amount });
  });

  it('돌아온 금액이 주문 금액과 다르면 422 payment_mismatch이고 토스를 부르지 않는다', async () => {
    const topUp = await newTopUp();
    const paymentKey = toss.authenticate(topUp);
    const callsBefore = toss.calls.length;
    const res = await confirm(topUp.id, { paymentKey, amount: topUp.amount + 1 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'payment_mismatch' });
    expect(toss.calls.length).toBe(callsBefore);
    expect(await statusOf(topUp.id)).toBe('pending');
  });

  it('같은 금액의 다른 주문 결제 키로 확정하면 422 — 한 결제로 두 주문이 충전되지 않는다', async () => {
    const paid = await newTopUp();
    const victim = await newTopUp();
    const paymentKey = toss.authenticate(paid);
    expect((await confirm(paid.id, { paymentKey, amount: paid.amount })).status).toBe(200);
    const before = await balance();
    const callsBefore = toss.calls.length;

    const res = await confirm(victim.id, { paymentKey, amount: victim.amount });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'payment_mismatch' });
    expect(await balance()).toBe(before);
    expect(await statusOf(victim.id)).toBe('pending');
    const keyOf = (orderId: string) =>
      toss.calls.find((c) => c.api === 'confirm' && (c.body as { orderId?: unknown }).orderId === orderId)?.idempotencyKey;
    expect(toss.calls[callsBefore]?.idempotencyKey).toBe(keyOf(victim.id));
    expect(keyOf(victim.id)).not.toBe(keyOf(paid.id));
  });

  const outages: [string, FakeConfirmAnswer, FakeLookupAnswer][] = [
    ['승인 응답을 잃고(처리됨) 조회도 시간 초과', { committed: 'hang' }, 'hang'],
    ['승인이 닿지 않고 조회도 500', 'hang', { httpStatus: 500, code: 'FAILED_INTERNAL_SYSTEM_PROCESSING' }],
  ];
  it.each(outages)('%s → 200 unconfirmed(주문 대기) → 토스가 회복되면 같은 요청이 applied', async (_name, confirmAnswer, lookupAnswer) => {
    const topUp = await newTopUp();
    const body = { paymentKey: toss.authenticate(topUp), amount: topUp.amount };
    toss.script('confirm', confirmAnswer);
    toss.script('lookup', lookupAnswer);

    const first = await confirm(topUp.id, body);
    expect(first.status).toBe(200);
    expect((await first.json()) as ConfirmTopUpResponse).toEqual({ outcome: 'unconfirmed' });
    expect(await statusOf(topUp.id)).toBe('pending');

    const retry = await confirm(topUp.id, body);
    expect(await retry.json()).toMatchObject({ outcome: 'applied', replayed: false, topUp: { status: 'paid' } });
    expect(await ledgerLines(topUp.id)).toBe(1);
  });

  it('승인이 끝나지 않은 결제(입금 대기)로 답하면 대기이고, 토스가 끝낸 뒤의 재확정은 조회로 충전한다', async () => {
    const topUp = await newTopUp();
    const paymentKey = toss.authenticate(topUp);
    const body = { paymentKey, amount: topUp.amount };
    toss.script('confirm', { processedAs: 'WAITING_FOR_DEPOSIT' });
    const before = await balance();

    expect(await (await confirm(topUp.id, body)).json()).toEqual({ outcome: 'unconfirmed' });
    expect(await statusOf(topUp.id)).toBe('pending');
    toss.setStatus(paymentKey, 'DONE');
    expect(await (await confirm(topUp.id, body)).json()).toMatchObject({ outcome: 'applied', replayed: false, topUp: { status: 'paid' } });
    expect(await balance()).toBe(before + 100);
    expect(await ledgerLines(topUp.id)).toBe(1);
  });

  it('웹훅이 먼저 충전한 결제를 입금 대기 답이 재생되는 확정으로 다시 물어도 replayed — 원장 한 줄', async () => {
    const topUp = await newTopUp();
    const paymentKey = toss.authenticate(topUp);
    const body = { paymentKey, amount: topUp.amount };
    toss.script('confirm', { processedAs: 'WAITING_FOR_DEPOSIT' });
    expect(await (await confirm(topUp.id, body)).json()).toEqual({ outcome: 'unconfirmed' });

    toss.setStatus(paymentKey, 'DONE');
    expect(await (await postWebhook(toss.webhookBody({ paymentKey, orderId: topUp.id, status: 'DONE' }))).json()).toEqual({ outcome: 'applied' });
    expect(await (await confirm(topUp.id, body)).json()).toMatchObject({ outcome: 'applied', replayed: true, topUp: { status: 'paid' } });
    expect(await ledgerLines(topUp.id)).toBe(1);
  });

  it('틀린 본문은 400 invalid_payment, 없는·남의 주문은 404, 다른 오리진은 403, 결제 시뮬레이션 경로는 없다', async () => {
    const topUp = await newTopUp();
    const callsBefore = toss.calls.length;
    const dotKeys = [{ paymentKey: '..', amount: 10_000 }, { paymentKey: '.', amount: 10_000 }];
    for (const body of [{ paymentKey: 'has space', amount: 10_000 }, { paymentKey: 'tgen_x', amount: -1 }, { paymentKey: 'tgen_x', amount: '10000' }, {}, ...dotKeys]) {
      const res = await confirm(topUp.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_payment' });
    }
    const { topUp: foreign } = await repos.topUps.create('other-tenant', {
      requestKey: randomUUID(),
      packageId: 'credits_100',
      credits: 100,
      amount: 10_000,
      provider: 'toss',
    });
    for (const id of ['missing', foreign.id]) {
      const res = await confirm(id, { paymentKey: toss.authenticate({ id, amount: 10_000 }), amount: 10_000 });
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    expect((await confirm(topUp.id, { paymentKey: 'tgen_x', amount: 10_000 }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await consolePost(`/top-ups/${topUp.id}/simulate`, { result: 'paid' })).status).toBe(404);
    expect(await statusOf(foreign.id)).toBe('pending');
    expect(toss.calls.length).toBe(callsBefore);
  });
});

describe('토스 웹훅 — 본문을 믿지 않고 조회로 판정한다', () => {
  it('DONE → 200 applied, 뒤이은 확정은 replayed, 재전송은 Idempotent-Replayed — 원장 한 줄', async () => {
    const topUp = await newTopUp();
    const paymentKey = toss.authenticate(topUp);
    toss.setStatus(paymentKey, 'DONE');
    const before = await balance();
    const body = toss.webhookBody({ paymentKey, orderId: topUp.id, status: 'DONE' });

    const hook = await postWebhook(body);
    expect(hook.status).toBe(200);
    expect(await hook.json()).toEqual({ outcome: 'applied' });
    const confirmed = await confirm(topUp.id, { paymentKey, amount: topUp.amount });
    expect(await confirmed.json()).toMatchObject({ outcome: 'applied', replayed: true, topUp: { status: 'paid' } });
    const redelivered = await postWebhook(body);
    expect(redelivered.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(await redelivered.json()).toEqual({ outcome: 'applied' });

    expect(await balance()).toBe(before + 100);
    expect(await ledgerLines(topUp.id)).toBe(1);
  });

  it('확정과 웹훅이 같은 결제에 동시에 와도 새로 반영한 응답은 하나, 원장 한 줄', async () => {
    const topUp = await newTopUp();
    const paymentKey = toss.authenticate(topUp);
    toss.setStatus(paymentKey, 'DONE');
    const before = await balance();
    const body = toss.webhookBody({ paymentKey, orderId: topUp.id, status: 'DONE' });

    const [c1, w1, c2, w2] = await Promise.all([
      confirm(topUp.id, { paymentKey, amount: topUp.amount }),
      postWebhook(body),
      confirm(topUp.id, { paymentKey, amount: topUp.amount }),
      postWebhook(body),
    ]);
    const confirms = (await Promise.all([c1, c2].map((r) => r?.json()))) as { outcome: string; replayed: boolean }[];
    const hooks = [w1, w2].map((r) => ({ status: r?.status, replayed: r?.headers.get(IDEMPOTENT_REPLAYED_HEADER) === 'true' }));
    expect([c1?.status, c2?.status, ...hooks.map((h) => h.status)]).toEqual([200, 200, 200, 200]);
    expect(confirms.every((c) => c.outcome === 'applied')).toBe(true);
    expect([...confirms.map((c) => c.replayed), ...hooks.map((h) => h.replayed)].filter((replayed) => !replayed)).toHaveLength(1);
    expect(await ledgerLines(topUp.id)).toBe(1);
    expect(await balance()).toBe(before + 100);
  });

  it('모르는 주문·모의 제공자 주문의 웹훅은 200 + 이유이고, 토스를 부르지 않는다', async () => {
    const { topUp: mockOrder } = await repos.topUps.create(TENANT, {
      requestKey: randomUUID(),
      packageId: 'credits_100',
      credits: 100,
      amount: 10_000,
      provider: 'mock',
    });
    const callsBefore = toss.calls.length;
    for (const [orderId, outcome] of [
      ['no-such-order', 'unknown_order'],
      [mockOrder.id, 'provider_mismatch'],
    ] as const) {
      const res = await postWebhook(toss.webhookBody({ paymentKey: 'tgen_forged_0002', orderId, status: 'DONE' }));
      expect(res.status, orderId).toBe(200);
      expect(await res.json()).toEqual({ outcome });
    }
    expect(toss.calls.length).toBe(callsBefore);
  });

  it('조회가 시간 안에 답하지 않으면 503 provider_unavailable, 토스가 다시 보내면 그때 반영한다', async () => {
    const topUp = await newTopUp();
    const paymentKey = toss.authenticate(topUp);
    toss.setStatus(paymentKey, 'DONE');
    const body = toss.webhookBody({ paymentKey, orderId: topUp.id, status: 'DONE' });
    toss.script('lookup', 'hang');

    const slow = await postWebhook(body);
    expect(slow.status).toBe(503);
    expect(await slow.json()).toEqual({ error: 'provider_unavailable' });
    expect(await statusOf(topUp.id)).toBe('pending');
    const retried = await postWebhook(body);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ outcome: 'applied' });
  });

  it('조회한 결제가 아직 끝나지 않았으면(인증만 됨) 503 provider_unavailable, 토스가 결제를 끝낸 뒤 같은 웹훅은 200 applied', async () => {
    const topUp = await newTopUp();
    const paymentKey = toss.authenticate(topUp);
    const body = toss.webhookBody({ paymentKey, orderId: topUp.id, status: 'DONE' });

    const early = await postWebhook(body);
    expect(early.status).toBe(503);
    expect(await early.json()).toEqual({ error: 'provider_unavailable' });
    expect(await statusOf(topUp.id)).toBe('pending');

    toss.setStatus(paymentKey, 'DONE');
    const later = await postWebhook(body);
    expect(later.status).toBe(200);
    expect(await later.json()).toEqual({ outcome: 'applied' });
    expect(await ledgerLines(topUp.id)).toBe(1);
  });

  it('위조(조회 404)는 200 unverified, 취소는 200 unsettled — 둘 다 주문 그대로', async () => {
    const forgedFor = await newTopUp();
    const forged = await postWebhook(toss.webhookBody({ paymentKey: 'tgen_forged_0003', orderId: forgedFor.id, status: 'DONE' }));
    expect(forged.status).toBe(200);
    expect(await forged.json()).toEqual({ outcome: 'unverified' });

    const canceledFor = await newTopUp();
    const paymentKey = toss.authenticate(canceledFor);
    toss.setStatus(paymentKey, 'CANCELED');
    const canceled = await postWebhook(toss.webhookBody({ paymentKey, orderId: canceledFor.id, status: 'CANCELED' }));
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toEqual({ outcome: 'unsettled' });

    expect([await statusOf(forgedFor.id), await statusOf(canceledFor.id)]).toEqual(['pending', 'pending']);
  });

  it('PAYMENT_STATUS_CHANGED 모양이 아니면 400 invalid_webhook이고 토스를 부르지 않는다', async () => {
    const topUp = await newTopUp();
    const callsBefore = toss.calls.length;
    // 우리 토스 주문을 가리켜도 짝 없는 서로게이트는 URL 인코딩이 던진다 — 결제 키로 받지 않는다.
    const dotKeys = ['..', '.', '\ud800'].map((paymentKey) => JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey, orderId: topUp.id } }));
    for (const body of ['not json', JSON.stringify({ eventType: 'DEPOSIT_CALLBACK', data: {} }), JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED' }), ...dotKeys]) {
      const res = await postWebhook(body);
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_webhook' });
    }
    expect(toss.calls.length).toBe(callsBefore);
  });
});
