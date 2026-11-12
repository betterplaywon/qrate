import { newestFirstAfter, parsePageRequest, toPage } from '../listing.js';
import type { Conversation, ConversationOutcome, ConversationPage, ConversationRepository, NewTurn, TimeWindow } from '../types.js';
import { appendCredit } from './credits.js';
import { inWindow, newHandoff, toMessage, toSummary } from './records.js';
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
    const after = parsePageRequest(limit, cursor);
    const rows = newestFirstAfter([...this.byId.values()].filter((c) => c.tenantId === tenantId), after);
    return toPage(rows, limit, toSummary);
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
      const { reason, summary } = turn.handoff;
      conversation.handoffs.push(newHandoff({ id: this.store.nextHandoffId(), source: 'model', reason, summary, contact: null }, now));
    }
    // 차감은 턴과 함께. 같은 키가 이미 있으면 건너뛴다(중복 차감 없음).
    if (turn.charge) appendCredit(this.store, tenantId, turn.charge);
  }

  async outcomes(tenantId: string, window: TimeWindow): Promise<ConversationOutcome[]> {
    return [...this.byId.values()]
      .filter((c) => c.tenantId === tenantId && inWindow(c.createdAt, window))
      .map((c) => ({
        asked: c.messages.some((m) => m.role === 'user'),
        answered: c.messages.some((m) => m.role === 'assistant'),
        handedOff: c.handoffs.length > 0,
      }));
  }
}
