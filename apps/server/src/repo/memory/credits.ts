import { compareNewestFirst, decodeCursor, encodeCursor, isAfterCursor } from '../listing.js';
import type { CreditEntry, CreditPage, CreditRepository, NewCreditEntry } from '../types.js';
import type { MemoryStore } from './store.js';

/** 멱등 키가 이미 있으면 그 항목을, 없으면 새 항목을 넣고 돌려준다. 대화 저장(appendTurn)의 차감도 이 함수를 쓴다. */
export function appendCredit(store: MemoryStore, tenantId: string, entry: NewCreditEntry): { entry: CreditEntry; duplicate: boolean } {
  const ledger = store.credits.get(tenantId) ?? [];
  const existing = ledger.find((e) => e.idempotencyKey === entry.idempotencyKey);
  if (existing) return { entry: { ...existing }, duplicate: true };
  const created: CreditEntry = { id: store.nextCreditId(), tenantId, ...entry, createdAt: new Date() };
  ledger.push(created);
  store.credits.set(tenantId, ledger);
  return { entry: { ...created }, duplicate: false };
}

export class MemoryCreditRepository implements CreditRepository {
  constructor(private readonly store: MemoryStore) {}

  async balance(tenantId: string): Promise<number> {
    return (this.store.credits.get(tenantId) ?? []).reduce((sum, e) => sum + e.delta, 0);
  }

  async append(tenantId: string, entry: NewCreditEntry): Promise<{ entry: CreditEntry; duplicate: boolean }> {
    return appendCredit(this.store, tenantId, entry);
  }

  async list(tenantId: string, { limit, cursor = null }: { limit: number; cursor?: string | null }): Promise<CreditPage> {
    if (limit < 1) throw new RangeError('limit must be >= 1');
    const after = cursor ? decodeCursor(cursor) : null;
    const all = [...(this.store.credits.get(tenantId) ?? [])].sort(compareNewestFirst);
    const rest = after ? all.filter((e) => isAfterCursor(e, after)) : all;
    const page = rest.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map((e) => ({ ...e })), nextCursor: rest.length > limit && last ? encodeCursor(last) : null };
  }
}
