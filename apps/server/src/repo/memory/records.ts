import { previewOf } from '../listing.js';
import type { Conversation, ConversationMessage, ConversationSummary, HandoffQueueItem, HandoffRecord, NewMessage } from '../types.js';

// 메모리 구현의 레코드 만들기·읽기. 돌려주는 객체는 복사본이다 — 호출자가 바꿔도 저장소가 바뀌지 않아야 DB 구현과 동작이 같다.

/**
 * 핸드오프 id — 같은 밀리초에 두 건이 생겨도 뒤의 것이 더 큰 문자열이 되게(시각 base36 + 프로세스 카운터).
 * 큐 정렬의 tie-break가 id 내림차순이라, Postgres의 cuid(시각 + 카운터)처럼 저장 순서를 그대로 보존해야 두 구현의 결과가 같다.
 */
const nextHandoffId = (() => {
  let counter = 0;
  return (): string => `m${Date.now().toString(36).padStart(9, '0')}${(counter++).toString(36).padStart(6, '0')}`;
})();

export function newHandoff(fields: Pick<HandoffRecord, 'source' | 'reason' | 'summary' | 'contact'>, now: Date): HandoffRecord {
  return { id: nextHandoffId(), ...fields, status: 'open', createdAt: now, updatedAt: now };
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
