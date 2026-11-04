import { randomUUID } from 'node:crypto';
import { sortKnowledgeById } from './knowledge-order.js';
import { compareNewestFirst, decodeCursor, encodeCursor, isAfterCursor, previewOf } from './listing.js';
import type {
  Conversation,
  ConversationMessage,
  ConversationPage,
  ConversationRepository,
  ConversationSummary,
  HandoffPage,
  HandoffQueueItem,
  HandoffRecord,
  HandoffRepository,
  HandoffStatus,
  KnowledgeItem,
  KnowledgeRepository,
  NewMessage,
  NewTurn,
  NewVisitorHandoff,
  Tenant,
  TenantRepository,
} from './types.js';

/** 대화와 핸드오프가 같은 객체를 본다 — 두 저장소 구현이 한 상태를 공유하게(DB에서는 같은 테이블들). */
export class MemoryStore {
  readonly conversations = new Map<string, Conversation>();
}

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
  private readonly byId: Map<string, Conversation>;

  constructor(store: MemoryStore = new MemoryStore()) {
    this.byId = store.conversations;
  }

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
    if (turn.handoff) {
      conversation.handoffs.push(newHandoff({ source: 'model', reason: turn.handoff.reason, summary: turn.handoff.summary, contact: null }, now));
    }
  }
}

export class MemoryHandoffRepository implements HandoffRepository {
  private readonly conversations: Map<string, Conversation>;

  constructor(store: MemoryStore) {
    this.conversations = store.conversations;
  }

  async list(
    tenantId: string,
    { status, limit, cursor = null }: { status?: HandoffStatus; limit: number; cursor?: string | null },
  ): Promise<HandoffPage> {
    if (limit < 1) throw new RangeError('limit must be >= 1');
    const after = cursor ? decodeCursor(cursor) : null;
    const all: HandoffQueueItem[] = [];
    for (const c of this.conversations.values()) {
      if (c.tenantId !== tenantId) continue;
      for (const h of c.handoffs) {
        if (status && h.status !== status) continue;
        all.push(toQueueItem(c, h));
      }
    }
    all.sort(compareNewestFirst);
    const rest = after ? all.filter((h) => isAfterCursor(h, after)) : all;
    const page = rest.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page, nextCursor: rest.length > limit && last ? encodeCursor(last) : null };
  }

  async updateStatus(id: string, tenantId: string, status: HandoffStatus): Promise<HandoffQueueItem | null> {
    for (const c of this.conversations.values()) {
      if (c.tenantId !== tenantId) continue;
      const h = c.handoffs.find((x) => x.id === id);
      if (h) {
        h.status = status;
        h.updatedAt = new Date();
        return toQueueItem(c, h);
      }
    }
    return null;
  }

  async requestByVisitor(conversationId: string, tenantId: string, input: NewVisitorHandoff): Promise<{ id: string }> {
    const now = new Date();
    let conversation = this.conversations.get(conversationId);
    if (conversation && conversation.tenantId !== tenantId) {
      throw new Error(`conversation belongs to another tenant: ${conversationId}`);
    }
    if (!conversation) {
      conversation = { id: conversationId, tenantId, createdAt: now, messages: [], handoffs: [] };
      this.conversations.set(conversationId, conversation);
    }
    const handoff = newHandoff({ source: 'visitor', reason: 'needs_human', summary: input.summary, contact: input.contact }, now);
    conversation.handoffs.push(handoff);
    return { id: handoff.id };
  }
}

function newHandoff(fields: Pick<HandoffRecord, 'source' | 'reason' | 'summary' | 'contact'>, now: Date): HandoffRecord {
  return { id: randomUUID(), ...fields, status: 'open', createdAt: now, updatedAt: now };
}

function toQueueItem(c: Conversation, h: HandoffRecord): HandoffQueueItem {
  return { ...h, tenantId: c.tenantId, conversationId: c.id, preview: previewOf(c.messages.find((m) => m.role === 'user')?.content) };
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
