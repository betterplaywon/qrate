import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';
import { sortKnowledgeById } from './knowledge-order.js';
import { decodeCursor, encodeCursor, previewOf } from './listing.js';
import type { SeedFile } from './seed.js';
import type {
  Conversation,
  ConversationPage,
  ConversationRepository,
  KnowledgeItem,
  KnowledgeRepository,
  NewTurn,
  Repositories,
  Tenant,
  TenantRepository,
} from './types.js';

// Prisma(Postgres) 구현 — 저장소 계약(types.ts)의 두 번째 구현. 메모리 구현과 같은 계약 테스트(test/repo-contract.ts)를 돈다.
// 클라이언트는 Prisma 7의 드라이버 어댑터(@prisma/adapter-pg → node-postgres 커넥션 풀)로 만든다.
// 생성 코드는 src/generated/prisma(prisma generate, git 제외). 스키마와 마이그레이션은 prisma/.

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export function createPrismaRepositories(prisma: PrismaClient): Repositories {
  return {
    tenants: new PrismaTenantRepository(prisma),
    knowledge: new PrismaKnowledgeRepository(prisma),
    conversations: new PrismaConversationRepository(prisma),
  };
}

export class PrismaTenantRepository implements TenantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByKey(apiKey: string): Promise<Tenant | null> {
    const t = await this.prisma.tenant.findUnique({ where: { apiKey } });
    return t ? { id: t.id, apiKey: t.apiKey, name: t.name, allowedOrigins: t.allowedOrigins } : null;
  }
}

export class PrismaKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByTenant(tenantId: string): Promise<KnowledgeItem[]> {
    const rows = await this.prisma.knowledgeItem.findMany({
      where: { tenantId },
      select: { id: true, tenantId: true, title: true, category: true, blocks: true },
    });
    // 정렬은 DB가 아니라 여기서(knowledge-order.ts) — 콜레이션과 무관하게 메모리 구현과 같은 순서.
    return sortKnowledgeById(rows);
  }
}

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
      handoffs: row.handoffs.map((h) => ({ reason: h.reason, summary: h.summary, createdAt: h.createdAt })),
    };
  }

  async listByTenant(tenantId: string, { limit, cursor = null }: { limit: number; cursor?: string | null }): Promise<ConversationPage> {
    if (limit < 1) throw new RangeError('limit must be >= 1');
    const after = cursor ? decodeCursor(cursor) : null;
    // 키셋 페이지네이션: (createdAt, id) 내림차순에서 커서 뒤의 행만. (tenantId, createdAt) 인덱스를 탄다.
    // id 비교는 DB 콜레이션을 따르지만 대화 id는 소문자 UUID라 하이픈 위치가 같아 코드 단위 비교(메모리 구현)와 순서가 같다.
    // 한 줄 더 가져와 다음 페이지가 있는지 본다.
    const rows = await this.prisma.conversation.findMany({
      where: {
        tenantId,
        ...(after
          ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
          data: { conversationId, reason: turn.handoff.reason, summary: turn.handoff.summary },
        });
      }
    });
  }
}

/**
 * 시드 파일을 DB에 반영한다 — `prisma db seed`(prisma/seed.ts)와 Postgres 계약 테스트가 쓴다.
 * 몇 번을 돌려도 결과가 같다: 테넌트·지식은 upsert, 시드에서 빠진 지식은 지운다. 대화는 건드리지 않는다.
 */
export async function applySeed(prisma: PrismaClient, seed: SeedFile): Promise<void> {
  const { tenant, knowledge } = seed;
  await prisma.$transaction(
    async (tx) => {
      await tx.tenant.upsert({
        where: { id: tenant.id },
        create: { id: tenant.id, apiKey: tenant.apiKey, name: tenant.name, allowedOrigins: tenant.allowedOrigins },
        update: { apiKey: tenant.apiKey, name: tenant.name, allowedOrigins: tenant.allowedOrigins },
      });
      await tx.knowledgeItem.deleteMany({ where: { tenantId: tenant.id, id: { notIn: knowledge.map((k) => k.id) } } });
      for (const k of knowledge) {
        await tx.knowledgeItem.upsert({
          where: { tenantId_id: { tenantId: tenant.id, id: k.id } },
          create: { tenantId: tenant.id, id: k.id, title: k.title, category: k.category, blocks: k.blocks },
          update: { title: k.title, category: k.category, blocks: k.blocks },
        });
      }
    },
    // 항목 수만큼 문장이 나간다(26개면 28문장). 기본 5초는 느린 CI에서 빠듯할 수 있다.
    { timeout: 30_000 },
  );
}
