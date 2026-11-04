// 저장소 인터페이스 (개발 DB 결정, 2026-11-02. 턴 단위 계약은 2026-11-04 코드 리뷰 반영).
//
// 서버 로직은 이 계약에만 기대고, 구현은 W2 메모리 → W3 Prisma(Postgres)로 바꿔 끼운다.
// 메모리 구현은 W3 이후에도 단위 테스트용으로 남기고, 두 구현에 같은 계약 테스트를 돌린다.
// 메모리 구현은 UNIQUE 제약·트랜잭션·정렬 규칙에서 실제 DB와 다를 수 있다 — 계약 테스트가 그 차이를 잡는다.

import type { HandoffReason } from '@qrate/contracts';

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

/** 모델이 상담원 연결을 요청한 기록(engine/handoff.ts). W3 미응답 큐의 입력이다 — 큐의 상태(처리 중·완료)는 그때 붙인다. */
export interface HandoffRecord {
  reason: HandoffReason;
  summary: string | null;
  createdAt: Date;
}

export interface Conversation {
  id: string;
  tenantId: string;
  createdAt: Date;
  messages: ConversationMessage[];
  handoffs: HandoffRecord[];
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

/**
 * 저장 단위는 턴이다(chat/service.ts). 질문·답변·핸드오프 신호가 한 번에 들어가고, 구현은 이것을 한 트랜잭션으로 쓴다.
 * 답이 없는 턴(정책 거절)은 answer가 null이다 — 기록은 남지만 다음 턴의 문맥에는 들어가지 않는다(service.ts의 toHistory).
 */
export interface NewTurn {
  /** 질문은 받은 시각을 createdAt으로 넘긴다. 저장은 답이 끝난 뒤라 그때의 시각이 아니다. */
  question: NewMessage;
  answer: NewMessage | null;
  handoff: { reason: HandoffReason; summary: string | null } | null;
}

/** 콘솔 대화 로그 목록의 한 줄. 메시지 전문은 싣지 않는다 — 상세는 find. */
export interface ConversationSummary {
  id: string;
  tenantId: string;
  createdAt: Date;
  messageCount: number;
  handoffCount: number;
  /** 첫 질문의 앞부분(PREVIEW_CHARS자). 비어 있으면 질문 없이 끝난 대화 — 지금 구조에선 생기지 않는다. */
  preview: string;
}

export const PREVIEW_CHARS = 80;

export interface ConversationPage {
  items: ConversationSummary[];
  /** 다음 페이지를 받을 커서. null이면 끝. 값은 불투명하다 — 구현이 만들고 구현만 해석한다. */
  nextCursor: string | null;
}

export interface ConversationRepository {
  /**
   * 테넌트 경계: 다른 테넌트의 대화 id로는 찾을 수 없다.
   * lastMessages를 주면 최근 그 수만큼만 싣는다 — 프롬프트 문맥용. 대화가 길어져도 턴마다 전체를 읽지 않게.
   */
  find(id: string, tenantId: string, opts?: { lastMessages?: number }): Promise<Conversation | null>;
  /**
   * 테넌트의 대화를 최근 시작순(createdAt 내림차순, 같으면 id 내림차순)으로 limit개. 커서 페이지네이션 —
   * 오프셋이면 새 대화가 끼어들 때 줄이 밀려 같은 대화가 두 번 보인다. 커서가 깨진 값이면 던진다(InvalidCursorError).
   */
  listByTenant(tenantId: string, opts: { limit: number; cursor?: string | null }): Promise<ConversationPage>;
  /**
   * 턴을 끝에 붙인다. 대화가 없으면 이 턴과 함께 만든다 — 대화는 첫 턴이 저장될 때 생기므로,
   * 첫 이벤트 전에 실패하거나 끊긴 요청은 빈 대화를 남기지 않는다.
   * id가 다른 테넌트의 대화면 실패한다(테넌트 경계는 쓰기에서도 지킨다).
   */
  appendTurn(conversationId: string, tenantId: string, turn: NewTurn): Promise<void>;
}

export interface Repositories {
  tenants: TenantRepository;
  knowledge: KnowledgeRepository;
  conversations: ConversationRepository;
}

/** 목록 커서가 이 구현이 만든 값이 아닐 때. HTTP 계층은 400으로 옮긴다. */
export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'InvalidCursorError';
  }
}
