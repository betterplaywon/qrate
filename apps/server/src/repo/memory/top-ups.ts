import { newestFirstAfter, parsePageRequest, toPage } from '../listing.js';
import type { NewTopUp, Settlement, SettleResult, TopUp, TopUpPage, TopUpRepository } from '../types.js';
import { appendCredit } from './credits.js';
import type { MemoryStore } from './store.js';

// 쓰기 메서드는 await 없이 한 동기 구간에서 끝난다 — 그 사이에 다른 요청이 끼지 못해 Postgres의 트랜잭션·유니크 인덱스와 같은 결과가 난다.
// await을 넣으면 이 원자성이 깨진다.
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
    const after = parsePageRequest(limit, cursor);
    const rows = newestFirstAfter([...this.store.topUps.values()].filter((t) => t.tenantId === tenantId), after);
    return toPage(rows, limit, (t) => ({ ...t }));
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
