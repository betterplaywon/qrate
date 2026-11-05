import { describe, expect, it } from 'vitest';
import { decideSettlement, type SettlementEvent } from '../src/billing/settlement.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from '../src/repo/seed.js';
import type { PaymentProviderName, PaymentResult, Repositories, TopUp, TopUpStatus } from '../src/repo/types.js';
import { deliver, order } from './repo-contract.js';

// 결제 이벤트 판정과 상태 전이. 판정은 순수 함수지만, 전이의 결과(상태·원장)는 저장소에 실제로 적용해 본다 — 사용자가 보는 것이 그것이다.

const seed = loadSeedFile(DEFAULT_SEED_PATH);
const TENANT = seed.tenant.id;

async function fresh(): Promise<{ repos: Repositories; topUp: TopUp; balance: () => Promise<number> }> {
  const repos = createRepositoriesFromSeed(seed);
  const { topUp } = await repos.topUps.create(TENANT, order());
  return { repos, topUp, balance: () => repos.credits.balance(TENANT) };
}

/** 지금 상태를 만드는 이벤트들. */
const REACH: Record<TopUpStatus, PaymentResult[]> = { pending: [], failed: ['failed'], paid: ['paid'] };

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
    for (const [i, r] of REACH[now].entries()) await deliver(repos, topUp.id, `evt-setup-${i}`, r);
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
  it('모르는 주문 · 다른 제공자의 주문 · 금액 불일치는 이유와 함께 무시, 맞는 이벤트만 적용 대상', () => {
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
    expect(decideSettlement(null, event)).toEqual({ kind: 'ignore', reason: 'unknown_order' });
    expect(decideSettlement(pending, { ...event, provider: 'toss' as PaymentProviderName })).toEqual({ kind: 'ignore', reason: 'provider_mismatch' });
    expect(decideSettlement(pending, { ...event, amount: 9_999 })).toEqual({ kind: 'ignore', reason: 'amount_mismatch' });
    expect(decideSettlement(pending, event).kind).toBe('settle');
  });
});
