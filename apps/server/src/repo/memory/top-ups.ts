import { compareNewestFirst, decodeCursor, encodeCursor, isAfterCursor } from '../listing.js';
import type { NewTopUp, Settlement, SettleResult, TopUp, TopUpPage, TopUpRepository } from '../types.js';
import { appendCredit } from './credits.js';
import type { MemoryStore } from './store.js';

// 충전 주문과 제공자 이벤트. 쓰기 메서드는 await 없이 한 동기 구간에서 끝난다 — JS 스레드 하나라 그 사이에 다른 요청이 끼지 못해
// Postgres 구현의 트랜잭션·유니크 인덱스와 같은 결과가 난다. 잠금 흉내는 두지 않는다.

export class MemoryTopUpRepository implements TopUpRepository {
  constructor(private readonly store: MemoryStore) {}

  async create(tenantId: string, input: NewTopUp): Promise<{ topUp: TopUp; created: boolean }> {
    for (const t of this.store.topUps.values()) {
      if (t.tenantId === tenantId && t.requestKey === input.requestKey) return { topUp: { ...t }, created: false };
    }
    const now = new Date();
    const topUp: TopUp = { id: this.store.nextTopUpId(), tenantId, ...input, status: 'pending', settledAt: null, createdAt: now, updatedAt: now };
    this.store.topUps.set(topUp.id, topUp);
    return { topUp: { ...topUp }, created: true };
  }

  async findById(id: string): Promise<TopUp | null> {
    const t = this.store.topUps.get(id);
    return t ? { ...t } : null;
  }

  async findForTenant(id: string, tenantId: string): Promise<TopUp | null> {
    const t = this.store.topUps.get(id);
    return t && t.tenantId === tenantId ? { ...t } : null;
  }

  async list(tenantId: string, { limit, cursor = null }: { limit: number; cursor?: string | null }): Promise<TopUpPage> {
    if (limit < 1) throw new RangeError('limit must be >= 1');
    const after = cursor ? decodeCursor(cursor) : null;
    const all = [...this.store.topUps.values()].filter((t) => t.tenantId === tenantId).sort(compareNewestFirst);
    const rest = after ? all.filter((t) => isAfterCursor(t, after)) : all;
    const page = rest.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map((t) => ({ ...t })), nextCursor: rest.length > limit && last ? encodeCursor(last) : null };
  }

  async settle(s: Settlement): Promise<SettleResult> {
    const eventKey = `${s.event.provider}:${s.event.eventId}`;
    const prior = this.store.paymentEvents.get(eventKey);
    if (prior) {
      const topUp = this.store.topUps.get(prior.topUpId);
      if (!topUp) throw new Error(`payment event without top-up: ${eventKey}`);
      return { outcome: prior.outcome, replayed: true, topUp: { ...topUp } };
    }
    const topUp = this.store.topUps.get(s.topUpId);
    // Postgres에서는 PaymentEvent의 FK가 같은 일을 한다.
    if (!topUp) throw new Error(`unknown top-up: ${s.topUpId}`);
    const moves = topUp.tenantId === s.tenantId && s.from.includes(topUp.status);
    if (moves) {
      const now = new Date();
      topUp.status = s.to;
      topUp.settledAt = now;
      topUp.updatedAt = now;
      if (s.credit) appendCredit(this.store, s.tenantId, s.credit);
    }
    const outcome = moves ? 'applied' : 'stale';
    this.store.paymentEvents.set(eventKey, { topUpId: topUp.id, outcome });
    return { outcome, replayed: false, topUp: { ...topUp } };
  }
}
