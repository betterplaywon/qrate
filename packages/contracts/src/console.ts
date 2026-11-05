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
// 상태를 바꾸는 요청(login·logout·PATCH)은 대화 API와 같은 Origin 검사를 받는다. 날짜는 ISO 8601 문자열이다.

import type { HandoffReason } from './chat.js';

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
/** applied = 이벤트가 주문 상태를 옮겼다. stale = 이미 그 이상이라 그대로다. 재배달에는 처음 판정을 그대로 돌려준다. */
export type SettleOutcome = 'applied' | 'stale';
