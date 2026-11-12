import { newestFirstAfter, parsePageRequest, toPage } from '../listing.js';
import type { Conversation, HandoffPage, HandoffQueueItem, HandoffRepository, HandoffStatus, NewVisitorHandoff } from '../types.js';
import { newHandoff, toQueueItem } from './records.js';
import type { MemoryStore } from './store.js';

export class MemoryHandoffRepository implements HandoffRepository {
  private readonly conversations: Map<string, Conversation>;

  constructor(store: MemoryStore) {
    this.conversations = store.conversations;
  }

  async list(
    tenantId: string,
    { status, limit, cursor = null }: { status?: HandoffStatus; limit: number; cursor?: string | null },
  ): Promise<HandoffPage> {
    const after = parsePageRequest(limit, cursor);
    const all: HandoffQueueItem[] = [];
    for (const c of this.conversations.values()) {
      if (c.tenantId !== tenantId) continue;
      for (const h of c.handoffs) {
        if (status && h.status !== status) continue;
        all.push(toQueueItem(c, h));
      }
    }
    const rows = newestFirstAfter(all, after);
    return toPage(rows, limit, (h) => h);
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
