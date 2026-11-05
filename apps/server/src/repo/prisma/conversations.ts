import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { decodeCursor, encodeCursor, previewOf } from '../listing.js';
import type { Conversation, ConversationOutcome, ConversationPage, ConversationRepository, NewTurn, TimeWindow } from '../types.js';
import { appendCredit } from './credits.js';
import { NEWEST_FIRST, afterCursor } from './cursor.js';
import { toHandoffRecord } from './handoffs.js';

export class PrismaConversationRepository implements ConversationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async find(id: string, tenantId: string, opts: { lastMessages?: number } = {}): Promise<Conversation | null> {
    const n = opts.lastMessages;
    // 테넌트 경계는 WHERE에 넣는다 — 다른 테넌트의 id로는 행이 보이지 않는다.
    // 최근 n개는 seq 역순으로 끊어 가져온 뒤 되돌린다. (conversationId, seq) 인덱스를 그대로 탄다.
    const row = await this.prisma.conversation.findFirst({
      where: { id, tenantId },
      include: {
        messages: n === undefined ? { orderBy: { seq: 'asc' } } : { orderBy: { seq: 'desc' }, take: Math.max(n, 0) },
        handoffs: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!row) return null;
    const messages = n === undefined ? row.messages : row.messages.reverse();
    return {
      id: row.id,
      tenantId: row.tenantId,
      createdAt: row.createdAt,
      messages: messages.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
      handoffs: row.handoffs.map(toHandoffRecord),
    };
  }

  async listByTenant(tenantId: string, { limit, cursor = null }: { limit: number; cursor?: string | null }): Promise<ConversationPage> {
    if (limit < 1) throw new RangeError('limit must be >= 1');
    const after = cursor ? decodeCursor(cursor) : null;
    // 키셋 페이지네이션(cursor.ts). (tenantId, createdAt) 인덱스를 탄다. 한 줄 더 가져와 다음 페이지가 있는지 본다.
    const rows = await this.prisma.conversation.findMany({
      where: { tenantId, ...afterCursor(after) },
      orderBy: [...NEWEST_FIRST],
      take: limit + 1,
      select: {
        id: true,
        tenantId: true,
        createdAt: true,
        _count: { select: { messages: true, handoffs: true } },
        messages: { where: { role: 'user' }, orderBy: { seq: 'asc' }, take: 1, select: { content: true } },
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        createdAt: r.createdAt,
        messageCount: r._count.messages,
        handoffCount: r._count.handoffs,
        preview: previewOf(r.messages[0]?.content),
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  async appendTurn(conversationId: string, tenantId: string, turn: NewTurn): Promise<void> {
    // 한 턴 = 한 트랜잭션. 대화 생성·질문·답변·핸드오프가 모두 들어가거나 하나도 남지 않는다.
    await this.prisma.$transaction(async (tx) => {
      // 대화가 없으면 이 턴과 함께 만든다(createdAt은 질문을 받은 시각). 있으면 테넌트가 같은지 본다 —
      // 다른 테넌트의 대화면 여기서 던져 트랜잭션이 되돌아가고 아무것도 쓰이지 않는다.
      const conversation = await tx.conversation.upsert({
        where: { id: conversationId },
        create: { id: conversationId, tenantId, createdAt: turn.question.createdAt },
        update: {},
        select: { tenantId: true },
      });
      if (conversation.tenantId !== tenantId) {
        throw new Error(`conversation belongs to another tenant: ${conversationId}`);
      }
      // 질문 → 답변 순서로 한 문장에 넣는다. seq(SERIAL)가 VALUES 순서대로 매겨져 조회 순서가 저장 순서와 같다.
      const messages: Prisma.MessageCreateManyInput[] = [
        { conversationId, role: turn.question.role, content: turn.question.content, createdAt: turn.question.createdAt },
      ];
      if (turn.answer) {
        messages.push({ conversationId, role: turn.answer.role, content: turn.answer.content, createdAt: turn.answer.createdAt });
      }
      await tx.message.createMany({ data: messages });
      if (turn.handoff) {
        await tx.handoff.create({
          data: { tenantId, conversationId, source: 'model', reason: turn.handoff.reason, summary: turn.handoff.summary },
        });
      }
      // 차감은 같은 트랜잭션에서. 같은 키가 이미 있으면 들어가지 않는다(ON CONFLICT DO NOTHING) — 턴은 그대로 저장된다.
      if (turn.charge) await appendCredit(tx, tenantId, turn.charge);
    });
  }

  async outcomes(tenantId: string, { from, to }: TimeWindow): Promise<ConversationOutcome[]> {
    // (tenantId, createdAt) 인덱스. _count는 관계 하나에 조건 하나만 걸 수 있어서, 질문이 있었는지는 user 메시지 한 행(id만)으로 본다.
    const rows = await this.prisma.conversation.findMany({
      where: { tenantId, createdAt: { gte: from, lt: to } },
      select: {
        messages: { where: { role: 'user' }, select: { id: true }, take: 1 },
        _count: { select: { messages: { where: { role: 'assistant' } }, handoffs: true } },
      },
    });
    return rows.map((r) => ({ asked: r.messages.length > 0, answered: r._count.messages > 0, handedOff: r._count.handoffs > 0 }));
  }
}
