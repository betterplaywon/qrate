import { sortKnowledgeById } from './knowledge-order.js';
import { compareNewestFirst, decodeCursor, encodeCursor, isAfterCursor, previewOf } from './listing.js';
import type {
  Conversation,
  ConversationMessage,
  ConversationPage,
  ConversationRepository,
  ConversationSummary,
  KnowledgeItem,
  KnowledgeRepository,
  NewMessage,
  NewTurn,
  Tenant,
  TenantRepository,
} from './types.js';

// 메모리 구현. 프로세스가 재시작되면 비워진다 (dev의 tsx watch가 파일 변경마다 재시작한다).
// 돌려주는 객체는 복사본이다 — 호출자가 바꿔도 저장소가 바뀌지 않아야 DB 구현과 동작이 같다.

export class MemoryTenantRepository implements TenantRepository {
  private readonly byKey = new Map<string, Tenant>();

  constructor(tenants: Tenant[]) {
    for (const t of tenants) this.byKey.set(t.apiKey, t);
  }

  async findByKey(apiKey: string): Promise<Tenant | null> {
    const t = this.byKey.get(apiKey);
    return t ? { ...t, allowedOrigins: [...t.allowedOrigins] } : null;
  }
}

export class MemoryKnowledgeRepository implements KnowledgeRepository {
  private readonly items: KnowledgeItem[];

  constructor(items: KnowledgeItem[]) {
    this.items = sortKnowledgeById(items);
  }

  async listByTenant(tenantId: string): Promise<KnowledgeItem[]> {
    return this.items.filter((k) => k.tenantId === tenantId).map((k) => ({ ...k, blocks: [...k.blocks] }));
  }
}

export class MemoryConversationRepository implements ConversationRepository {
  private readonly byId = new Map<string, Conversation>();

  async find(id: string, tenantId: string, opts: { lastMessages?: number } = {}): Promise<Conversation | null> {
    const conversation = this.byId.get(id);
    if (!conversation || conversation.tenantId !== tenantId) return null;
    const n = opts.lastMessages;
    const messages = n === undefined ? conversation.messages : n > 0 ? conversation.messages.slice(-n) : [];
    return {
      ...conversation,
      messages: messages.map((m) => ({ ...m })),
      handoffs: conversation.handoffs.map((h) => ({ ...h })),
    };
  }

  async listByTenant(tenantId: string, { limit, cursor = null }: { limit: number; cursor?: string | null }): Promise<ConversationPage> {
    if (limit < 1) throw new RangeError('limit must be >= 1');
    const after = cursor ? decodeCursor(cursor) : null;
    const all = [...this.byId.values()].filter((c) => c.tenantId === tenantId).sort(compareNewestFirst);
    const rest = after ? all.filter((c) => isAfterCursor(c, after)) : all;
    const page = rest.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toSummary),
      nextCursor: rest.length > limit && last ? encodeCursor(last) : null,
    };
  }

  async appendTurn(conversationId: string, tenantId: string, turn: NewTurn): Promise<void> {
    const now = new Date();
    let conversation = this.byId.get(conversationId);
    if (conversation && conversation.tenantId !== tenantId) {
      throw new Error(`conversation belongs to another tenant: ${conversationId}`);
    }
    if (!conversation) {
      conversation = { id: conversationId, tenantId, createdAt: turn.question.createdAt ?? now, messages: [], handoffs: [] };
      this.byId.set(conversation.id, conversation);
    }
    conversation.messages.push(toMessage(turn.question, now));
    if (turn.answer) conversation.messages.push(toMessage(turn.answer, now));
    if (turn.handoff) conversation.handoffs.push({ reason: turn.handoff.reason, summary: turn.handoff.summary, createdAt: now });
  }
}

function toMessage(message: NewMessage, now: Date): ConversationMessage {
  return { role: message.role, content: message.content, createdAt: message.createdAt ?? now };
}

function toSummary(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    tenantId: c.tenantId,
    createdAt: c.createdAt,
    messageCount: c.messages.length,
    handoffCount: c.handoffs.length,
    preview: previewOf(c.messages.find((m) => m.role === 'user')?.content),
  };
}
