import { randomUUID } from 'node:crypto';
import type {
  Conversation,
  ConversationRepository,
  KnowledgeItem,
  KnowledgeRepository,
  MessageRole,
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
    // 로캘에 기대지 않는 코드 단위 비교 — 어느 환경에서도 같은 순서여야 캐시가 맞는다.
    this.items = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async listByTenant(tenantId: string): Promise<KnowledgeItem[]> {
    return this.items.filter((k) => k.tenantId === tenantId).map((k) => ({ ...k, blocks: [...k.blocks] }));
  }
}

export class MemoryConversationRepository implements ConversationRepository {
  private readonly byId = new Map<string, Conversation>();

  async create(tenantId: string): Promise<Conversation> {
    const conversation: Conversation = { id: randomUUID(), tenantId, createdAt: new Date(), messages: [] };
    this.byId.set(conversation.id, conversation);
    return snapshot(conversation);
  }

  async find(id: string, tenantId: string): Promise<Conversation | null> {
    const conversation = this.byId.get(id);
    return conversation && conversation.tenantId === tenantId ? snapshot(conversation) : null;
  }

  async appendMessage(conversationId: string, message: { role: MessageRole; content: string }): Promise<void> {
    const conversation = this.byId.get(conversationId);
    if (!conversation) throw new Error(`conversation not found: ${conversationId}`);
    conversation.messages.push({ ...message, createdAt: new Date() });
  }
}

function snapshot(conversation: Conversation): Conversation {
  return { ...conversation, messages: conversation.messages.map((m) => ({ ...m })) };
}
