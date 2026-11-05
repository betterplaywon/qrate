import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { decodeCursor, encodeCursor } from '../listing.js';
import type { CreditEntry, CreditPage, CreditRepository, NewCreditEntry } from '../types.js';
import { NEWEST_FIRST, afterCursor } from './cursor.js';

// 크레딧 원장. 멱등은 (tenantId, idempotencyKey) UNIQUE 제약이 지킨다 — createMany({ skipDuplicates })는 ON CONFLICT DO NOTHING이라
// 두 요청이 동시에 와도 하나만 들어가고 예외도 없다. 넣은 뒤 그 키로 다시 읽어 "누가 먼저였든 같은 항목"을 돌려준다.

type Tx = Prisma.TransactionClient | PrismaClient;

function toEntry(e: Prisma.CreditLedgerGetPayload<object>): CreditEntry {
  return { id: e.id, tenantId: e.tenantId, delta: e.delta, reason: e.reason, idempotencyKey: e.idempotencyKey, createdAt: e.createdAt };
}

/** 트랜잭션 안에서도 쓸 수 있는 멱등 추가. 대화 저장(appendTurn)의 차감이 같은 트랜잭션에서 부른다. */
export async function appendCredit(tx: Tx, tenantId: string, entry: NewCreditEntry): Promise<{ entry: CreditEntry; duplicate: boolean }> {
  const { count } = await tx.creditLedger.createMany({ data: { tenantId, ...entry }, skipDuplicates: true });
  const row = await tx.creditLedger.findUniqueOrThrow({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: entry.idempotencyKey } },
  });
  return { entry: toEntry(row), duplicate: count === 0 };
}

export class PrismaCreditRepository implements CreditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async balance(tenantId: string): Promise<number> {
    const { _sum } = await this.prisma.creditLedger.aggregate({ where: { tenantId }, _sum: { delta: true } });
    return _sum.delta ?? 0;
  }

  async append(tenantId: string, entry: NewCreditEntry): Promise<{ entry: CreditEntry; duplicate: boolean }> {
    return appendCredit(this.prisma, tenantId, entry);
  }

  async list(tenantId: string, { limit, cursor = null }: { limit: number; cursor?: string | null }): Promise<CreditPage> {
    if (limit < 1) throw new RangeError('limit must be >= 1');
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await this.prisma.creditLedger.findMany({
      where: { tenantId, ...afterCursor(after) },
      orderBy: [...NEWEST_FIRST],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(toEntry), nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
  }
}
