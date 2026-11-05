import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { decodeCursor, encodeCursor } from '../listing.js';
import type { NewTopUp, Settlement, SettleResult, TopUp, TopUpPage, TopUpRepository } from '../types.js';
import { appendCredit } from './credits.js';
import { NEWEST_FIRST, afterCursor } from './cursor.js';

// 동시성은 제약 셋이 맡는다(READ COMMITTED):
//   주문 (tenantId, requestKey) UNIQUE — 같은 키 요청이 동시에 와도 INSERT 하나만 들어가고 나머지는 ON CONFLICT DO NOTHING.
//   이벤트 (provider, eventId) PK — 같은 이벤트는 먼저 INSERT한 쪽의 커밋을 기다린 뒤 0행이 되어 상태 전이에 닿지 않는다.
//   조건부 UPDATE(WHERE status IN from) — 행 잠금이자 CAS. 뒤에 온 쪽은 커밋된 새 상태로 WHERE를 다시 평가한다.

function toTopUp(t: Prisma.CreditTopUpGetPayload<object>): TopUp {
  return {
    id: t.id,
    tenantId: t.tenantId,
    requestKey: t.requestKey,
    packageId: t.packageId,
    credits: t.credits,
    amount: t.amount,
    provider: t.provider,
    status: t.status,
    settledAt: t.settledAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export class PrismaTopUpRepository implements TopUpRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(tenantId: string, input: NewTopUp): Promise<{ topUp: TopUp; created: boolean }> {
    const { count } = await this.prisma.creditTopUp.createMany({ data: { tenantId, ...input }, skipDuplicates: true });
    const row = await this.prisma.creditTopUp.findUniqueOrThrow({
      where: { tenantId_requestKey: { tenantId, requestKey: input.requestKey } },
    });
    return { topUp: toTopUp(row), created: count === 1 };
  }

  async findById(id: string): Promise<TopUp | null> {
    const row = await this.prisma.creditTopUp.findUnique({ where: { id } });
    return row ? toTopUp(row) : null;
  }

  async findForTenant(id: string, tenantId: string): Promise<TopUp | null> {
    const row = await this.prisma.creditTopUp.findFirst({ where: { id, tenantId } });
    return row ? toTopUp(row) : null;
  }

  async list(tenantId: string, { limit, cursor = null }: { limit: number; cursor?: string | null }): Promise<TopUpPage> {
    if (limit < 1) throw new RangeError('limit must be >= 1');
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await this.prisma.creditTopUp.findMany({
      where: { tenantId, ...afterCursor(after) },
      orderBy: [...NEWEST_FIRST],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(toTopUp), nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
  }

  async settle(s: Settlement): Promise<SettleResult> {
    const { provider, eventId, result } = s.event;
    const eventKey = { provider_eventId: { provider, eventId } };
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.paymentEvent.createMany({
        data: { provider, eventId, result, topUpId: s.topUpId, outcome: 'applied' },
        skipDuplicates: true,
      });
      if (claimed.count === 0) {
        const prior = await tx.paymentEvent.findUniqueOrThrow({ where: eventKey, include: { topUp: true } });
        return { outcome: prior.outcome, replayed: true, topUp: toTopUp(prior.topUp) };
      }
      const moved = await tx.creditTopUp.updateMany({
        where: { id: s.topUpId, tenantId: s.tenantId, status: { in: [...s.from] } },
        data: { status: s.to, settledAt: new Date() },
      });
      if (moved.count === 0) {
        await tx.paymentEvent.update({ where: eventKey, data: { outcome: 'stale' } });
      } else if (s.credit) {
        await appendCredit(tx, s.tenantId, s.credit);
      }
      const topUp = await tx.creditTopUp.findUniqueOrThrow({ where: { id: s.topUpId } });
      return { outcome: moved.count === 0 ? 'stale' : 'applied', replayed: false, topUp: toTopUp(topUp) };
    });
  }
}
