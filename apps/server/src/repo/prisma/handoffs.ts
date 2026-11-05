import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { decodeCursor, encodeCursor, previewOf } from '../listing.js';
import type { HandoffPage, HandoffQueueItem, HandoffRecord, HandoffRepository, HandoffStatus, NewVisitorHandoff } from '../types.js';
import { NEWEST_FIRST, afterCursor } from './cursor.js';

// 상담원 연결 요청 = 미응답 큐의 항목. 모델 신호는 conversations.ts(appendTurn)가, 방문자 요청은 여기(requestByVisitor)가 만든다.

/** 큐 한 줄에 필요한 열 + 대화의 첫 질문(미리보기). */
const QUEUE_SELECT = {
  id: true,
  tenantId: true,
  conversationId: true,
  source: true,
  reason: true,
  summary: true,
  contact: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  conversation: { select: { messages: { where: { role: 'user' }, orderBy: { seq: 'asc' }, take: 1, select: { content: true } } } },
} satisfies Prisma.HandoffSelect;

type QueueRow = Prisma.HandoffGetPayload<{ select: typeof QUEUE_SELECT }>;
type HandoffRow = Omit<QueueRow, 'conversation' | 'tenantId' | 'conversationId'>;

export function toHandoffRecord(h: HandoffRow): HandoffRecord {
  return {
    id: h.id,
    source: h.source,
    reason: h.reason,
    summary: h.summary,
    contact: h.contact,
    status: h.status,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

function toQueueItem(r: QueueRow): HandoffQueueItem {
  return {
    ...toHandoffRecord(r),
    tenantId: r.tenantId,
    conversationId: r.conversationId,
    preview: previewOf(r.conversation.messages[0]?.content),
  };
}

export class PrismaHandoffRepository implements HandoffRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(
    tenantId: string,
    { status, limit, cursor = null }: { status?: HandoffStatus; limit: number; cursor?: string | null },
  ): Promise<HandoffPage> {
    if (limit < 1) throw new RangeError('limit must be >= 1');
    const after = cursor ? decodeCursor(cursor) : null;
    // (tenantId, status, createdAt) 인덱스. 한 줄 더 가져와 다음 페이지가 있는지 본다.
    const rows = await this.prisma.handoff.findMany({
      where: { tenantId, ...(status ? { status } : {}), ...afterCursor(after) },
      orderBy: [...NEWEST_FIRST],
      take: limit + 1,
      select: QUEUE_SELECT,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(toQueueItem), nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
  }

  async updateStatus(id: string, tenantId: string, status: HandoffStatus): Promise<HandoffQueueItem | null> {
    // 테넌트 경계는 WHERE로 — updateMany는 조건에 맞는 행만 바꾸고 개수를 돌려준다.
    const { count } = await this.prisma.handoff.updateMany({ where: { id, tenantId }, data: { status } });
    if (count === 0) return null;
    const row = await this.prisma.handoff.findFirst({ where: { id, tenantId }, select: QUEUE_SELECT });
    return row ? toQueueItem(row) : null;
  }

  async requestByVisitor(conversationId: string, tenantId: string, input: NewVisitorHandoff): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      // 대화가 없으면 빈 대화와 함께 만든다. 다른 테넌트의 대화면 던져 되돌린다 — 아무것도 쓰이지 않는다.
      const conversation = await tx.conversation.upsert({
        where: { id: conversationId },
        create: { id: conversationId, tenantId },
        update: {},
        select: { tenantId: true },
      });
      if (conversation.tenantId !== tenantId) {
        throw new Error(`conversation belongs to another tenant: ${conversationId}`);
      }
      const created = await tx.handoff.create({
        data: { tenantId, conversationId, source: 'visitor', reason: 'needs_human', summary: input.summary, contact: input.contact },
        select: { id: true },
      });
      return { id: created.id };
    });
  }
}
