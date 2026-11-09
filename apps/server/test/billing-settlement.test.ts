import { describe, expect, it } from 'vitest';
import { decideSettlement, matchOrder, type SettlementEvent } from '../src/billing/settlement.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from '../src/repo/seed.js';
import type { PaymentResult, Repositories, TopUp, TopUpStatus } from '../src/repo/types.js';
import { deliver, order } from './repo-contract.js';

const seed = loadSeedFile(DEFAULT_SEED_PATH);
const TENANT = seed.tenant.id;

async function fresh(): Promise<{ repos: Repositories; topUp: TopUp; balance: () => Promise<number> }> {
  const repos = createRepositoriesFromSeed(seed);
  const { topUp } = await repos.topUps.create(TENANT, order());
  return { repos, topUp, balance: () => repos.credits.balance(TENANT) };
}

const EVENTS_TO_REACH: Record<TopUpStatus, PaymentResult[]> = { pending: [], failed: ['failed'], paid: ['paid'] };

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

describe('상태 전이 표 — 상태는 앞으로만 간다(pending < failed < paid)', () => {
  it.each([
    { now: 'pending', event: 'paid', status: 'paid', outcome: 'applied', charged: 100, ledger: '충전' },
    { now: 'pending', event: 'failed', status: 'failed', outcome: 'applied', charged: 0, ledger: '그대로' },
    { now: 'failed', event: 'paid', status: 'paid', outcome: 'applied', charged: 100, ledger: '충전' },
    { now: 'failed', event: 'failed', status: 'failed', outcome: 'stale', charged: 0, ledger: '그대로' },
    { now: 'paid', event: 'paid', status: 'paid', outcome: 'stale', charged: 0, ledger: '그대로' },
    { now: 'paid', event: 'failed', status: 'paid', outcome: 'stale', charged: 0, ledger: '그대로' },
  ] as const)('$now 주문에 $event 이벤트 → $status, $outcome, 원장 $ledger', async ({ now, event, status, outcome, charged }) => {
    const { repos, topUp, balance } = await fresh();
    for (const [i, r] of EVENTS_TO_REACH[now].entries()) await deliver(repos, topUp.id, `evt-setup-${i}`, r);
    const before = await balance();
    const result = await deliver(repos, topUp.id, 'evt-under-test', event);
    expect(result).toMatchObject({ outcome, replayed: false, topUp: { status } });
    expect(await balance()).toBe(before + charged);
  });
});

describe('배달 순서와 무관하게 같은 끝 상태로 수렴한다', () => {
  const cases: { name: string; events: [string, PaymentResult][]; status: TopUpStatus; charged: number }[] = [
    {
      name: '결제 완료 둘·실패 둘(다른 이벤트 id)',
      events: [['e1', 'paid'], ['e2', 'failed'], ['e3', 'paid'], ['e4', 'failed']],
      status: 'paid',
      charged: 100,
    },
    { name: '같은 결제 완료의 재배달 + 실패', events: [['e1', 'paid'], ['e1', 'paid'], ['e2', 'failed'], ['e2', 'failed']], status: 'paid', charged: 100 },
    { name: '실패만', events: [['e1', 'failed'], ['e2', 'failed'], ['e1', 'failed']], status: 'failed', charged: 0 },
  ];

  it.each(cases)('$name: 모든 순열에서 끝 상태가 $status, 원장은 최대 한 줄', async ({ events, status, charged }) => {
    const orders = permutations(events);
    expect(orders.length).toBeGreaterThan(1);
    for (const sequence of orders) {
      const { repos, topUp, balance } = await fresh();
      const before = await balance();
      for (const [eventId, result] of sequence) await deliver(repos, topUp.id, eventId, result);
      const label = sequence.map(([id, r]) => `${id}:${r}`).join(' → ');
      expect((await repos.topUps.findById(topUp.id))?.status, label).toBe(status);
      expect(await balance(), label).toBe(before + charged);
      const lines = (await repos.credits.list(TENANT, { limit: 100 })).items.filter((e) => e.reason === 'topup');
      expect(lines.map((e) => e.idempotencyKey), label).toEqual(charged ? [`topup:${topUp.id}`] : []);
    }
  });
});

describe('판정이 무시하는 이벤트', () => {
  const pending: TopUp = {
    id: 'order-1',
    tenantId: TENANT,
    ...order('k'),
    status: 'pending',
    settledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const event: SettlementEvent = { provider: 'mock', eventId: 'evt-1', orderId: 'order-1', result: 'paid', amount: 10_000 };

  it('matchOrder: 모르는 주문 · 다른 제공자의 주문은 이유와 함께 거르고, 그 제공자의 주문만 통과한다', () => {
    expect(matchOrder(null, 'mock')).toEqual({ ok: false, reason: 'unknown_order' });
    expect(matchOrder(pending, 'toss')).toEqual({ ok: false, reason: 'provider_mismatch' });
    expect(matchOrder(pending, 'mock')).toEqual({ ok: true, order: pending });
  });

  it('decideSettlement: 다른 주문의 결제 · 금액 불일치는 이유와 함께 무시, 맞는 이벤트만 적용 대상', () => {
    expect(decideSettlement(pending, { ...event, orderId: 'order-2' })).toEqual({ kind: 'ignore', reason: 'order_mismatch' });
    expect(decideSettlement(pending, { ...event, amount: 9_999 })).toEqual({ kind: 'ignore', reason: 'amount_mismatch' });
    expect(decideSettlement(pending, event).kind).toBe('settle');
  });
});
