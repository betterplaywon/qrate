// 운영 콘솔 API 계약 — 서버(apps/server/src/http/console.ts)와 콘솔 앱(apps/console)이 함께 쓴다.
//
// 콘솔 결정(2026-11-04): 콘솔 페이지와 API는 같은 오리진(서버가 /console/ 정적 파일과 /api/console/* 를 함께 서빙).
// 인증 단위는 테넌트 — 로그인은 테넌트 키(data-tenant 값) + 콘솔 비밀키, 세션은 서명된 HttpOnly 쿠키.
//
//   POST  /api/console/login            ConsoleLoginBody → ConsoleSessionResponse + Set-Cookie. 틀리면 401 invalid_credentials
//   POST  /api/console/logout           204, 쿠키 삭제
//   GET   /api/console/me               ConsoleSessionResponse. 세션 없음·만료 → 401 unauthorized
//   GET   /api/console/conversations    ?limit=&cursor= → ConversationListResponse
//   GET   /api/console/conversations/:id → ConversationDetailResponse. 다른 테넌트의 대화는 404
//   GET   /api/console/handoffs         ?status=&limit=&cursor= → HandoffListResponse (미응답 큐)
//   PATCH /api/console/handoffs/:id     UpdateHandoffBody → HandoffQueueItemDto. 다른 테넌트의 것은 404
//   GET   /api/console/credits          ?limit=&cursor= → CreditsResponse (잔액 + 원장 최근순)
//   GET   /api/console/top-ups          ?limit=&cursor= → TopUpListResponse (충전 주문 최근순 + 충전을 받는 제공자)
//   POST  /api/console/top-ups          헤더 Idempotency-Key(8~128자 [A-Za-z0-9_-]) + CreateTopUpBody → 201 TopUpDto.
//                                       같은 키 재요청도 201 + 같은 본문 + Idempotent-Replayed: true. 같은 키·다른 상품 422 idempotency_key_reused,
//                                       키 없음·형식 400 invalid_idempotency_key, 모르는 상품 400 invalid_package, 제공자 없음 503 payments_unavailable
//   POST  /api/console/top-ups/:id/simulate  SimulatePaymentBody → SimulatePaymentResponse. 모의 제공자일 때만 있다(아니면 404).
//                                       모의 제공자가 서명한 웹훅을 웹훅 경로와 같은 처리에 넣는다. 이벤트 id가 주문·결과로 정해져 같은 버튼은 곧 재배달
// 상태를 바꾸는 요청(login·logout·PATCH·POST)은 대화 API와 같은 Origin 검사를 받는다. 날짜는 ISO 8601 문자열이다.

import type { HandoffReason } from './chat.js';
import type { WebhookOutcome } from './payments.js';

export const CONSOLE_API_PATH = '/api/console';
/** 콘솔 앱(정적 파일)이 서빙되는 경로. */
export const CONSOLE_PATH = '/console';

export const CONSOLE_LIST_LIMIT = { default: 20, max: 100 } as const;

/** 요청의 입구. model = 엔진의 request_handoff 도구, visitor = 대화창의 "상담원 연결" 버튼. */
export type HandoffSource = 'model' | 'visitor';
/** 미응답 큐의 상태. 운영자가 옮긴다. 전이 제한은 없다(되돌리기 포함). */
export type HandoffStatus = 'open' | 'in_progress' | 'done';
export const HANDOFF_STATUSES: readonly HandoffStatus[] = ['open', 'in_progress', 'done'];

export function isHandoffStatus(v: unknown): v is HandoffStatus {
  return typeof v === 'string' && (HANDOFF_STATUSES as readonly string[]).includes(v);
}

export interface ConsoleLoginBody {
  /** 위젯 설치 스니펫의 data-tenant 값(공개 식별자). */
  tenant: string;
  /** 테넌트의 콘솔 비밀키. */
  key: string;
}

export interface ConsoleTenant {
  id: string;
  name: string;
}

export interface ConsoleSessionResponse {
  tenant: ConsoleTenant;
}

export interface ConversationSummaryDto {
  id: string;
  createdAt: string;
  messageCount: number;
  handoffCount: number;
  /** 첫 질문의 앞부분. 질문 없이 연결 요청만 있는 대화면 빈 문자열. */
  preview: string;
}

export interface ConversationListResponse {
  items: ConversationSummaryDto[];
  nextCursor: string | null;
}

export interface MessageDto {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface HandoffDto {
  id: string;
  source: HandoffSource;
  reason: HandoffReason;
  /** 모델 신호면 질문 요약, 방문자 요청이면 방문자가 적은 메모. */
  summary: string | null;
  /** 방문자 요청의 연락처. 모델 신호에는 없다. */
  contact: string | null;
  status: HandoffStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetailResponse {
  id: string;
  createdAt: string;
  messages: MessageDto[];
  handoffs: HandoffDto[];
}

export interface HandoffQueueItemDto extends HandoffDto {
  conversationId: string;
  preview: string;
}

export interface HandoffListResponse {
  items: HandoffQueueItemDto[];
  nextCursor: string | null;
}

export interface UpdateHandoffBody {
  status: HandoffStatus;
}

/** 원장 항목의 사유. seed 초기 지급 · topup 충전 · turn 답변 차감 · adjustment 운영자 조정. */
export type CreditReason = 'seed' | 'topup' | 'turn' | 'adjustment';

export interface CreditEntryDto {
  id: string;
  /** 충전 +, 차감 -. */
  delta: number;
  reason: CreditReason;
  /** 멱등 키. 접두사가 출처다(seed: · turn: · topup: · adj:). */
  idempotencyKey: string;
  createdAt: string;
}

export interface CreditsResponse {
  /** 원장 합계. */
  balance: number;
  items: CreditEntryDto[];
  nextCursor: string | null;
}

/** 충전 주문의 상태. 앞으로만 간다(pending → failed → paid). 실패 뒤에 결제 완료가 오면 paid로 옮겨 충전한다. */
export type TopUpStatus = 'pending' | 'failed' | 'paid';
export type PaymentProviderName = 'mock';
/** 결제 제공자 이벤트가 알리는 결과. 곧 주문의 목표 상태다. */
export type PaymentResult = 'paid' | 'failed';
export const PAYMENT_RESULTS: readonly PaymentResult[] = ['paid', 'failed'];
/** applied = 이벤트가 주문 상태를 옮겼다. stale = 이미 그 이상이라 그대로다. 재배달에는 처음 판정을 그대로 돌려준다. */
export type SettleOutcome = 'applied' | 'stale';

/**
 * 충전 상품표. 금액(원)은 클라이언트가 보내지 않고 서버가 이 표에서만 가져와 주문에 굳힌다 — 웹훅의 금액은 그 값과 대조한다.
 * 가격은 테스트 모드 기본값(크레딧당 100원).
 */
export const TOP_UP_PACKAGES = [
  { id: 'credits_100', credits: 100, amount: 10_000 },
  { id: 'credits_500', credits: 500, amount: 50_000 },
  { id: 'credits_1000', credits: 1000, amount: 100_000 },
] as const;
export type TopUpPackageId = (typeof TOP_UP_PACKAGES)[number]['id'];
export const TOP_UP_PACKAGE_IDS: readonly TopUpPackageId[] = TOP_UP_PACKAGES.map((p) => p.id);

/** 충전 요청의 멱등 키(요청 헤더). 콘솔은 제출할 때 UUID를 만들고, 실패해 같은 상품으로 다시 보내면 같은 키를 쓴다. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
/** 같은 키의 재요청이라 처음 만든 주문을 그대로 돌려줬다는 응답 헤더(값 true). 상태 코드·본문은 첫 요청과 같다. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

export interface TopUpDto {
  /** 결제 제공자에게 넘기는 주문 id. */
  id: string;
  packageId: string;
  credits: number;
  /** 원. */
  amount: number;
  provider: PaymentProviderName;
  status: TopUpStatus;
  createdAt: string;
  settledAt: string | null;
}

export interface CreateTopUpBody {
  packageId: TopUpPackageId;
}

export interface TopUpListResponse {
  /** 충전을 받는 제공자. null이면 충전할 수 없다(운영 기본). mock이면 콘솔이 결제 시뮬레이션 버튼을 보인다. */
  provider: PaymentProviderName | null;
  items: TopUpDto[];
  nextCursor: string | null;
}

export interface SimulatePaymentBody {
  result: PaymentResult;
}

export interface SimulatePaymentResponse {
  outcome: WebhookOutcome;
  /** 같은 이벤트의 재배달이었다. outcome은 처음 판정이다. */
  replayed: boolean;
  topUp: TopUpDto;
}
