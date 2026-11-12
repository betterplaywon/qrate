import type { PrismaClient } from '../../generated/prisma/client.js';
import { sortEventCounts, toEventRow } from '../event-log.js';
import type { AppEvent, EventCount, EventRepository, TimeWindow } from '../types.js';

export class PrismaEventRepository implements EventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(event: AppEvent): Promise<void> {
    await this.prisma.event.create({ data: toEventRow(event) });
  }

  async ttftSamples(tenantId: string, { from, to }: TimeWindow): Promise<number[]> {
    // (tenantId, type, createdAt) 인덱스. 열 하나만 읽는다.
    const rows = await this.prisma.event.findMany({
      where: { tenantId, type: 'chat_request', createdAt: { gte: from, lt: to }, ttftMs: { not: null } },
      select: { ttftMs: true },
    });
    return rows.flatMap((r) => (r.ttftMs === null ? [] : [r.ttftMs]));
  }

  async counts(tenantId: string, { from, to }: TimeWindow): Promise<EventCount[]> {
    const groups = await this.prisma.event.groupBy({
      by: ['type', 'variant'],
      where: { tenantId, createdAt: { gte: from, lt: to } },
      _count: { _all: true },
    });
    return sortEventCounts(groups.map((g) => ({ type: g.type, variant: g.variant, count: g._count._all })));
  }

  async lastAt(tenantId: string, type: AppEvent['type']): Promise<Date | null> {
    // (tenantId, type, createdAt) 인덱스의 끝 한 줄.
    const row = await this.prisma.event.findFirst({ where: { tenantId, type }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    return row?.createdAt ?? null;
  }
}
