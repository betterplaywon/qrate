// 저장소 인터페이스 (개발 DB 결정, 2026-11-02).
//
// 서버 로직은 이 계약에만 기대고, 구현은 W2 메모리 → W3 Prisma(Postgres)로 바꿔 끼운다.
// 메모리 구현은 W3 이후에도 단위 테스트용으로 남기고, 두 구현에 같은 계약 테스트를 돌린다.
// 메모리 구현은 UNIQUE 제약·트랜잭션·정렬 규칙에서 실제 DB와 다를 수 있다 — 계약 테스트가 그 차이를 잡는다.

export interface Tenant {
  id: string;
  /** 위젯 설치 스니펫의 data-tenant 값. 공개 식별자이며 비밀키가 아니다. */
  apiKey: string;
  name: string;
  /** 위젯을 넣을 수 있는 사이트. 테넌트 검증 단계에서 frame-ancestors로 강제한다. */
  allowedOrigins: string[];
}

export interface KnowledgeItem {
  id: string;
  tenantId: string;
  title: string;
  category: string;
  /** 문단 하나가 인용의 최소 단위다. */
  blocks: string[];
}

export type MessageRole = 'user' | 'assistant';

export interface ConversationMessage {
  role: MessageRole;
  content: string;
  createdAt: Date;
}

export interface Conversation {
  id: string;
  tenantId: string;
  createdAt: Date;
  messages: ConversationMessage[];
}

export interface TenantRepository {
  findByKey(apiKey: string): Promise<Tenant | null>;
}

export interface KnowledgeRepository {
  /** id 오름차순으로 고정. 순서가 요청마다 같아야 프롬프트 캐시 접두사가 유지된다. */
  listByTenant(tenantId: string): Promise<KnowledgeItem[]>;
}

/** 저장할 메시지. createdAt이 없으면 저장 시각으로 기록한다. */
export interface NewMessage {
  role: MessageRole;
  content: string;
  createdAt?: Date;
}

export interface ConversationRepository {
  create(tenantId: string): Promise<Conversation>;
  /** 다른 테넌트의 대화 id로는 찾을 수 없다 (테넌트 경계). */
  find(id: string, tenantId: string): Promise<Conversation | null>;
  /**
   * 메시지를 끝에 붙인다. 턴은 답변이 끝난 뒤에 질문·답변을 한꺼번에 저장하므로(chat/service.ts),
   * 질문은 받은 시각을 createdAt으로 넘겨야 기록된 시각이 실제와 같다.
   */
  appendMessage(conversationId: string, message: NewMessage): Promise<void>;
}

export interface Repositories {
  tenants: TenantRepository;
  knowledge: KnowledgeRepository;
  conversations: ConversationRepository;
}
