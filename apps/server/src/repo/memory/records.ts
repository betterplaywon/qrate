import { previewOf } from '../listing.js';
import type { Conversation, ConversationMessage, ConversationSummary, HandoffQueueItem, HandoffRecord, NewMessage, TimeWindow } from '../types.js';

// 메모리 구현의 레코드 만들기·읽기. 돌려주는 객체는 복사본이다 — 호출자가 바꿔도 저장소가 바뀌지 않아야 DB 구현과 동작이 같다.

export function newHandoff(fields: Pick<HandoffRecord, 'id' | 'source' | 'reason' | 'summary' | 'contact'>, now: Date): HandoffRecord {
  return { ...fields, status: 'open', createdAt: now, updatedAt: now };
}

export function toMessage(message: NewMessage, now: Date): ConversationMessage {
  return { role: message.role, content: message.content, createdAt: message.createdAt ?? now };
}

export function toQueueItem(c: Conversation, h: HandoffRecord): HandoffQueueItem {
  return { ...h, tenantId: c.tenantId, conversationId: c.id, preview: previewOf(c.messages.find((m) => m.role === 'user')?.content) };
}

export function toSummary(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    tenantId: c.tenantId,
    createdAt: c.createdAt,
    messageCount: c.messages.length,
    handoffCount: c.handoffs.length,
    preview: previewOf(c.messages.find((m) => m.role === 'user')?.content),
  };
}

/** 반열린 구간 [from, to) 안인가. */
export function inWindow(at: Date, { from, to }: TimeWindow): boolean {
  return at.getTime() >= from.getTime() && at.getTime() < to.getTime();
}
