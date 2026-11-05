import type {
  ConversationDetailResponse,
  ConversationSummaryDto,
  CreditEntryDto,
  HandoffDto,
  HandoffQueueItemDto,
  MessageDto,
  TopUpDto,
} from '@qrate/contracts';
import type { Conversation, ConversationSummary, CreditEntry, HandoffQueueItem, HandoffRecord, TopUp } from '../../repo/types.js';

// 저장소 타입 → 콘솔 API 응답(DTO). 날짜는 ISO 8601 문자열로.

export function toHandoffDto(h: HandoffRecord): HandoffDto {
  return {
    id: h.id,
    source: h.source,
    reason: h.reason,
    summary: h.summary,
    contact: h.contact,
    status: h.status,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  };
}

export function toQueueDto(h: HandoffQueueItem): HandoffQueueItemDto {
  return { ...toHandoffDto(h), conversationId: h.conversationId, preview: h.preview };
}

export function toSummaryDto(c: ConversationSummary): ConversationSummaryDto {
  return {
    id: c.id,
    createdAt: c.createdAt.toISOString(),
    messageCount: c.messageCount,
    handoffCount: c.handoffCount,
    preview: c.preview,
  };
}

export function toDetailDto(c: Conversation): ConversationDetailResponse {
  return {
    id: c.id,
    createdAt: c.createdAt.toISOString(),
    messages: c.messages.map((m): MessageDto => ({ role: m.role, content: m.content, createdAt: m.createdAt.toISOString() })),
    handoffs: c.handoffs.map(toHandoffDto),
  };
}

export function toCreditDto(e: CreditEntry): CreditEntryDto {
  return { id: e.id, delta: e.delta, reason: e.reason, idempotencyKey: e.idempotencyKey, createdAt: e.createdAt.toISOString() };
}

export function toTopUpDto(t: TopUp): TopUpDto {
  return {
    id: t.id,
    packageId: t.packageId,
    credits: t.credits,
    amount: t.amount,
    provider: t.provider,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    settledAt: t.settledAt ? t.settledAt.toISOString() : null,
  };
}
