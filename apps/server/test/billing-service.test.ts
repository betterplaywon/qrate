import { MOCK_SIGNATURE_HEADER } from '@qrate/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createMockProvider } from '../src/billing/mock.js';
import type { PaymentProvider } from '../src/billing/provider.js';
import { createBillingService } from '../src/billing/service.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from '../src/repo/seed.js';

const seed = loadSeedFile(DEFAULT_SEED_PATH);
const TENANT = seed.tenant.id;
const NOW = new Date('2026-11-05T03:00:00Z');
const mock = createMockProvider('mock-secret-0123456789abcdef');

function setup(payments: PaymentProvider | null = mock) {
  const repos = createRepositoriesFromSeed(seed);
  const reports: { err: unknown; context?: Record<string, unknown> }[] = [];
  const lookups = vi.spyOn(repos.topUps, 'findById');
  const billing = createBillingService({
    repos,
    payments,
    reportError: (err, context) => void reports.push({ err, context }),
    now: () => NOW,
  });
  return { repos, billing, reports, lookups, balance: () => repos.credits.balance(TENANT) };
}

describe('충전 요청', () => {
  it('상품표의 크레딧·금액으로 주문을 만들고, 같은 키로 다시 오면 같은 주문(replayed)', async () => {
    const { billing } = setup();
    const first = await billing.requestTopUp(TENANT, { requestKey: 'key-0001', packageId: 'credits_500' });
    if (first.status !== 'created') throw new Error(first.status);
    expect(first.topUp).toMatchObject({ packageId: 'credits_500', credits: 500, amount: 50_000, provider: 'mock', status: 'pending' });
    expect(await billing.requestTopUp(TENANT, { requestKey: 'key-0001', packageId: 'credits_500' })).toEqual({
      status: 'replayed',
      topUp: first.topUp,
    });
  });

  it('같은 키에 다른 상품은 key_reused, 모르는 상품은 unknown_package — 둘 다 주문을 만들지 않는다', async () => {
    const { billing, repos } = setup();
    await billing.requestTopUp(TENANT, { requestKey: 'key-0001', packageId: 'credits_100' });
    expect(await billing.requestTopUp(TENANT, { requestKey: 'key-0001', packageId: 'credits_1000' })).toEqual({ status: 'key_reused' });
    expect(await billing.requestTopUp(TENANT, { requestKey: 'key-0002', packageId: 'credits_7' })).toEqual({ status: 'unknown_package' });
    expect((await repos.topUps.list(TENANT, { limit: 10 })).items).toHaveLength(1);
  });

  it('결제 제공자가 없으면 충전 요청은 unavailable이고 주문을 만들지 않는다', async () => {
    const { billing, repos } = setup(null);
    expect(await billing.requestTopUp(TENANT, { requestKey: 'key-0001', packageId: 'credits_100' })).toEqual({ status: 'unavailable' });
    expect((await repos.topUps.list(TENANT, { limit: 10 })).items).toEqual([]);
  });
});

describe('웹훅 수신', () => {
  it('결제 완료 → 충전, 같은 원문을 다시 받으면 처음 판정 그대로(replayed)이고 잔액은 한 번만 오른다', async () => {
    const { billing, balance } = setup();
    const created = await billing.requestTopUp(TENANT, { requestKey: 'key-0001', packageId: 'credits_100' });
    if (created.status !== 'created') throw new Error(created.status);
    const before = await balance();
    const webhook = mock.signEvent({ orderId: created.topUp.id, amount: created.topUp.amount, result: 'paid' }, NOW);

    expect(await billing.receiveWebhook('mock', webhook)).toMatchObject({
      status: 'settled',
      result: { outcome: 'applied', replayed: false, topUp: { status: 'paid' } },
    });
    expect(await billing.receiveWebhook('mock', webhook)).toMatchObject({ status: 'settled', result: { outcome: 'applied', replayed: true } });
    expect(await balance()).toBe(before + 100);
  });

  it('설정되지 않았거나 모르는 제공자 이름은 unknown_provider — 객체 프로토타입 이름도', async () => {
    const webhook = mock.signEvent({ orderId: 'x', amount: 1, result: 'paid' }, NOW);
    const { billing } = setup();
    for (const name of ['toss', '__proto__', 'constructor', 'toString', 'MOCK']) {
      expect(await billing.receiveWebhook(name, webhook), name).toEqual({ status: 'unknown_provider' });
    }
    expect(await setup(null).billing.receiveWebhook('mock', webhook)).toEqual({ status: 'unknown_provider' });
  });

  it('서명이 틀리면 rejected이고 주문을 읽지도 않는다', async () => {
    const { billing, lookups } = setup();
    const webhook = mock.signEvent({ orderId: 'x', amount: 1, result: 'paid' }, NOW);
    const forged = { ...webhook, headers: { [MOCK_SIGNATURE_HEADER]: 't=1,v1=00' } };
    expect(await billing.receiveWebhook('mock', forged)).toEqual({ status: 'rejected', reason: 'signature' });
    expect(lookups).not.toHaveBeenCalled();
    await billing.receiveWebhook('mock', webhook);
    expect(lookups).toHaveBeenCalledTimes(1);
  });

  it('서명은 맞는데 모르는 주문 · 금액 불일치는 ignored로 받고 보고 통로로 알린다. 주문·잔액은 그대로', async () => {
    const { billing, reports, repos, balance } = setup();
    const created = await billing.requestTopUp(TENANT, { requestKey: 'key-0001', packageId: 'credits_100' });
    if (created.status !== 'created') throw new Error(created.status);
    const before = await balance();

    const unknown = mock.signEvent({ orderId: 'no-such-order', amount: 10_000, result: 'paid' }, NOW);
    expect(await billing.receiveWebhook('mock', unknown)).toEqual({ status: 'ignored', reason: 'unknown_order' });
    const short = mock.signEvent({ orderId: created.topUp.id, amount: 1, result: 'paid' }, NOW);
    expect(await billing.receiveWebhook('mock', short)).toEqual({ status: 'ignored', reason: 'amount_mismatch' });

    // 모르는 주문은 결과를 읽기 전에 거른다 — 사건이 아직 없어 보고에 eventId가 없다.
    expect(reports.map((r) => r.context)).toEqual([
      { where: 'billing.webhook', provider: 'mock', orderId: 'no-such-order' },
      { where: 'billing.webhook', provider: 'mock', eventId: `evt_${created.topUp.id}_paid`, orderId: created.topUp.id },
    ]);
    expect((await repos.topUps.findById(created.topUp.id))?.status).toBe('pending');
    expect(await balance()).toBe(before);
  });
});
