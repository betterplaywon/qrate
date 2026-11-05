import { compareNewestFirst, decodeCursor, encodeCursor, isAfterCursor } from '../listing.js';
import type { Conversation, ConversationPage, ConversationRepository, NewTurn } from '../types.js';
import { appendCredit } from './credits.js';
import { newHandoff, toMessage, toSummary } from './records.js';
import { MemoryStore } from './store.js';

/** 최근 n개. n이 없으면 전부, 0이면 하나도. */
function lastMessages<T>(messages: T[], n: number | undefined): T[] {
  if (n === undefined) return messages;
  if (n <= 0) return [];
  return messages.slice(-n);
}

export class MemoryConversationRepository implements ConversationRepository {
  private readonly byId: Map<string, Conversation>;
  private readonly store: MemoryStore;

  constructor(store: MemoryStore = new MemoryStore()) {
    this.store = store;
    this.byId = store.conversations;
  }

  async find(id: string, tenantId: string, opts: { lastMessages?: number } = {}): Promise<Conversation | null> {
    const conversation = this.byId.get(id);
    if (!conversation || conversation.tenantId !== tenantId) return null;
    return {
      ...conversation,
      messages: lastMessages(conversation.messages, opts.lastMessages).map((m) => ({ ...m })),
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
    // 차감은 턴과 함께. 같은 키가 이미 있으면 건너뛴다(중복 차감 없음).
    if (turn.charge) appendCredit(this.store, tenantId, turn.charge);
  }
}
