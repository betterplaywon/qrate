// 저장소 인터페이스 (개발 DB 결정, 2026-11-02. 턴 단위 계약은 2026-11-04 코드 리뷰 반영).
//
// 서버 로직은 이 계약에만 기대고, 구현은 W2 메모리 → W3 Prisma(Postgres)로 바꿔 끼운다.
// 메모리 구현은 W3 이후에도 단위 테스트용으로 남기고, 두 구현에 같은 계약 테스트를 돌린다.
// 메모리 구현은 UNIQUE 제약·트랜잭션·정렬 규칙에서 실제 DB와 다를 수 있다 — 계약 테스트가 그 차이를 잡는다.

import type {
  CreditReason,
  HandoffReason,
  HandoffSource,
  HandoffStatus,
  PaymentProviderName,
  PaymentResult,
  SettleOutcome,
  StopReason,
  TopUpStatus,
  WidgetEventType,
} from '@qrate/contracts';
import type { EngineErrorCode, Usage } from '../engine/types.js';
import type { GreetingVariantId } from '../greeting/experiment.js';

export type { CreditReason, HandoffSource, HandoffStatus, PaymentProviderName, PaymentResult, SettleOutcome, TopUpStatus };

export interface Tenant {
  id: string;
  /** 위젯 설치 스니펫의 data-tenant 값. 공개 식별자이며 비밀키가 아니다. */
  apiKey: string;
  name: string;
  /** 위젯을 넣을 수 있는 사이트. 테넌트 검증 단계에서 frame-ancestors로 강제한다. */
  allowedOrigins: string[];
  /** 운영 콘솔 로그인 키의 해시(console/key.ts). null이면 콘솔에 로그인할 수 없다. 원문은 어디에도 없다. */
  consoleKeyHash: string | null;
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

/** 상담원 연결 요청 = 미응답 큐의 항목(콘솔 결정 2026-11-04: 큐에는 이 행만 들어간다). */
export interface HandoffRecord {
  id: string;
  source: HandoffSource;
  reason: HandoffReason;
  /** 모델 신호면 질문 요약, 방문자 요청이면 방문자가 적은 메모. */
  summary: string | null;
  /** 방문자 요청의 연락처(이메일). 모델 신호에는 없다. */
  contact: string | null;
  status: HandoffStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Conversation {
  id: string;
  tenantId: string;
  createdAt: Date;
  messages: ConversationMessage[];
  handoffs: HandoffRecord[];
}

export interface TenantRepository {
  /** 위젯·로그인이 쓰는 공개 키로 찾기. */
  findByKey(apiKey: string): Promise<Tenant | null>;
  /** 세션에 든 id로 찾기(콘솔). */
  findById(id: string): Promise<Tenant | null>;
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
  /**
   * 이 턴의 크레딧 차감(답이 있는 턴만, 턴당 -1). 턴 저장과 같은 트랜잭션에 들어간다 — 턴은 남았는데 차감이 안 되거나 그 반대가 없다.
   * 같은 멱등 키가 이미 있으면 건너뛴다(중복 차감 없음). 없거나 null이면 차감하지 않는다(거절·실패 턴).
   */
  charge?: NewCreditEntry | null;
}

/** 크레딧 원장 항목. 잔액은 delta의 합이다. */
export interface CreditEntry {
  id: string;
  tenantId: string;
  delta: number;
  reason: CreditReason;
  idempotencyKey: string;
  createdAt: Date;
}

export interface NewCreditEntry {
  delta: number;
  reason: CreditReason;
  /** 출처별 접두사: seed: · turn:<턴 id> · topup:<주문 id> · adj:<키>. 테넌트 안에서 유일하다. */
  idempotencyKey: string;
}

export interface CreditPage {
  items: CreditEntry[];
  nextCursor: string | null;
}

export interface CreditRepository {
  /** 원장 합계. 항목이 없으면 0. */
  balance(tenantId: string): Promise<number>;
  /** 멱등 추가: 같은 (tenantId, idempotencyKey)면 기존 항목을 돌려주고(duplicate=true) 잔액은 움직이지 않는다. */
  append(tenantId: string, entry: NewCreditEntry): Promise<{ entry: CreditEntry; duplicate: boolean }>;
  /** 최근순 목록(콘솔 원장). 커서는 listByTenant와 같은 규칙. */
  list(tenantId: string, opts: { limit: number; cursor?: string | null }): Promise<CreditPage>;
}

export interface TopUp {
  id: string;
  tenantId: string;
  requestKey: string;
  packageId: string;
  credits: number;
  amount: number;
  provider: PaymentProviderName;
  status: TopUpStatus;
  settledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTopUp {
  requestKey: string;
  packageId: string;
  credits: number;
  amount: number;
  provider: PaymentProviderName;
}

export interface Settlement {
  topUpId: string;
  tenantId: string;
  event: { provider: PaymentProviderName; eventId: string; result: PaymentResult };
  to: Exclude<TopUpStatus, 'pending'>;
  from: readonly TopUpStatus[];
  credit: NewCreditEntry | null;
}

export interface SettleResult {
  outcome: SettleOutcome;
  replayed: boolean;
  topUp: TopUp;
}

export interface TopUpPage {
  items: TopUp[];
  nextCursor: string | null;
}

export interface TopUpRepository {
  /** 같은 (tenantId, requestKey)면 새로 만들지 않고 기존 주문과 created=false. 동시에 와도 주문은 하나다. */
  create(tenantId: string, input: NewTopUp): Promise<{ topUp: TopUp; created: boolean }>;
  /** 웹훅 전용 — 테넌트 조건이 없다. 콘솔은 findForTenant를 쓴다. */
  findById(id: string): Promise<TopUp | null>;
  /** 다른 테넌트의 주문은 null. */
  findForTenant(id: string, tenantId: string): Promise<TopUp | null>;
  list(tenantId: string, opts: { limit: number; cursor?: string | null }): Promise<TopUpPage>;
  /** 한 트랜잭션: 이벤트 기록을 먼저 차지하고(이미 있으면 처음 outcome을 replayed로), from에 있을 때만 to로 옮기고, 옮겼을 때만 credit을 넣는다. */
  settle(settlement: Settlement): Promise<SettleResult>;
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

/** 큐의 한 줄: 핸드오프 + 어느 대화의 것인지 + 그 대화의 첫 질문 미리보기. */
export interface HandoffQueueItem extends HandoffRecord {
  tenantId: string;
  conversationId: string;
  preview: string;
}

export interface HandoffPage {
  items: HandoffQueueItem[];
  nextCursor: string | null;
}

/** 방문자의 "상담원 연결" 요청. 대화가 아직 없으면(질문 전에 눌렀으면) 빈 대화와 함께 생긴다. */
export interface NewVisitorHandoff {
  contact: string;
  summary: string | null;
}

export interface HandoffRepository {
  /** 테넌트의 요청을 최근순(createdAt·id 내림차순)으로. status를 주면 그 상태만. 커서는 listByTenant와 같은 규칙. */
  list(tenantId: string, opts: { status?: HandoffStatus; limit: number; cursor?: string | null }): Promise<HandoffPage>;
  /** 상태 전이. 테넌트 경계 — 다른 테넌트의 id면 못 찾은 것과 같다(null). */
  updateStatus(id: string, tenantId: string, status: HandoffStatus): Promise<HandoffQueueItem | null>;
  /** 방문자 요청 접수(source=visitor, reason=needs_human). 대화가 없으면 만들고, 다른 테넌트의 대화면 실패한다. */
  requestByVisitor(conversationId: string, tenantId: string, input: NewVisitorHandoff): Promise<{ id: string }>;
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
  /** createdAt이 창 안인 테넌트의 대화마다 하나. 순서 없음. 해결 판정은 여기서 하지 않는다(events/metrics.ts). */
  outcomes(tenantId: string, window: TimeWindow): Promise<ConversationOutcome[]>;
}

/** 자동 해결률 계산에 필요한 대화 한 건의 사실. */
export interface ConversationOutcome {
  /** user 메시지가 1개 이상. 방문자 연결 요청만으로 생긴 대화는 false다. */
  asked: boolean;
  /** assistant 메시지가 1개 이상. */
  answered: boolean;
  /** Handoff 행이 1개 이상(출처·상태 무관). */
  handedOff: boolean;
}

// 이벤트 로그(W4 ③). 사건 등록표는 아래 판별 유니온 하나다 — 종류를 더하면 여기 한 변형이 늘고, 쓰는 곳·DB 쓰기·위젯 화이트리스트가 따라온다.
// payload와 그 안의 타입은 interface가 아니라 type 별칭이다 — Prisma의 Json 입력(인덱스 시그니처)에 그대로 대입되게.
// 자유 문자열 필드를 두지 않는다: 문자열은 엔진·모델 이름, 규칙 id, 열거값뿐이라 질문·답 원문이 들어갈 자리가 없다.

export type EngineRunFacts = {
  engine: string;
  model: string;
  /** 요청 수신 → 끝(턴 저장 포함, ms). */
  durationMs: number;
  knowledgeItems: number;
  citations: number;
  /** 이 요청에서 엔진이 낸 핸드오프 신호. 지표는 이 값을 읽지 않는다 — 자동 해결률은 Handoff 표(두 출처)에서 센다(events/metrics.ts). */
  handoff: HandoffReason | null;
  /** warn 레벨 규칙 id. ok면 빈 배열. */
  moderation: string[];
};

export type ChatRequestPayload =
  | (EngineRunFacts & {
      outcome: 'done';
      stopReason: StopReason | null;
      /** 실제로 답한 모델. 서버 측 폴백이면 model과 다르다. */
      servedBy: string | null;
      fallbackUsed: boolean;
      usage: Usage | null;
    })
  | (EngineRunFacts & { outcome: 'error'; errorCode: EngineErrorCode })
  | (EngineRunFacts & { outcome: 'aborted' });

type EventBase = {
  /** 테넌트 id(키가 아니다). DB에서는 FK. */
  tenantId: string;
  /** 사건이 일어난 시각. chat_request는 요청을 받은 시각, 위젯 사건은 서버가 받은 시각. 저장 시각이 아니다. */
  createdAt: Date;
};

/**
 * 엔진을 부른 POST /api/chat 요청(테넌트를 찾고 모더레이션·크레딧을 통과한 요청)당 정확히 한 건. 쓰는 곳은 http/chat.ts 하나이고,
 * 거절(422·402)을 남기지 않는 이유도 거기 있다. conversationId는 DB에 없을 수 있다(실패·중단 턴은 저장 안 됨).
 */
export type ChatRequestEvent = EventBase & {
  type: 'chat_request';
  conversationId: string;
  /** 요청 수신 → 공백이 아닌 첫 delta 전송(ms). 그런 조각 없이 끝났으면 null(공백뿐인 답은 답이 없는 턴이다 — chat/service.ts). */
  ttftMs: number | null;
  payload: ChatRequestPayload;
};

/**
 * 대화창이 POST /api/events로 보낸 사건. payload는 서버가 만드는 빈 객체 — 요청 본문에서 아무것도 옮기지 않는다.
 * variant는 서버가 지금 인사말 실험에서 찾은 변형 id이거나 null이다. 요청 본문의 문자열은 브랜드가 없어 그대로 들어올 수 없다.
 */
export type WidgetEvent = EventBase & {
  type: WidgetEventType;
  conversationId: null;
  variant: GreetingVariantId | null;
  payload: Record<string, never>;
};

export type AppEvent = ChatRequestEvent | WidgetEvent;

/** 반열린 시간 구간 [from, to). */
export interface TimeWindow {
  from: Date;
  to: Date;
}

export interface EventCount {
  /** 저장된 종류 문자열. 다른 버전의 코드가 쓴 종류도 그대로 온다(type은 enum이 아니다 — schema.prisma). */
  type: string;
  variant: string | null;
  count: number;
}

/**
 * 사건 로그. 집계 정의(백분위·비율)는 여기 없다 — 저장소는 사실만 돌려주고 events/metrics.ts가 계산한다. 두 구현이 같은 정의를 쓰게.
 */
export interface EventRepository {
  /** 한 건 추가. 호출자는 기다리지 않는다(events/sink.ts가 감싼다). 테넌트가 없으면 Postgres는 FK로 던진다. */
  record(event: AppEvent): Promise<void>;
  /** 창 안 chat_request 중 ttftMs가 있는 것의 값. 순서 없음. */
  ttftSamples(tenantId: string, window: TimeWindow): Promise<number[]>;
  /** 창 안 사건을 (type, variant)로 묶은 개수. type 오름차순, 같으면 variant 오름차순(null 먼저), 코드 단위 비교. */
  counts(tenantId: string, window: TimeWindow): Promise<EventCount[]>;
}

export interface Repositories {
  tenants: TenantRepository;
  knowledge: KnowledgeRepository;
  conversations: ConversationRepository;
  handoffs: HandoffRepository;
  credits: CreditRepository;
  topUps: TopUpRepository;
  events: EventRepository;
}

/** 목록 커서가 이 구현이 만든 값이 아닐 때. HTTP 계층은 400으로 옮긴다. */
export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'InvalidCursorError';
  }
}
