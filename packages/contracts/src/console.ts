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
//   GET   /api/console/metrics          → ConsoleMetricsResponse (최근 METRICS_WINDOW_DAYS일, 쿼리 없음)
//   GET   /api/console/knowledge        → KnowledgeListResponse (그 테넌트의 FAQ 전부, id 오름차순)
//   PUT   /api/console/knowledge/:id    KnowledgeInput → 201(새로 만듦)·200(바꿈) KnowledgeItemDto. 새 항목의 id는 콘솔이 만든다(KNOWLEDGE_ID_PATTERN).
//                                       같은 요청을 다시 보내도 항목은 하나다. id·본문 모양 400 invalid_knowledge,
//                                       새 항목인데 개수가 상한이면 409 knowledge_limit, 전체 글자가 상한을 넘고 전보다 늘면 409 knowledge_too_large
//   DELETE /api/console/knowledge/:id   → 204. 이미 없어도 204. id 모양 400 invalid_knowledge
//   GET   /api/console/install          → InstallStatusResponse (설치 스니펫 재료·허용 사이트·위젯이 마지막으로 열린 때)
//   PUT   /api/console/install/origins  UpdateAllowedOriginsBody → InstallStatusResponse. 정규형 오리진만, 최대 MAX_ALLOWED_ORIGINS개.
//                                       같은 값은 한 번만 저장한다. 모양 400 invalid_origins
//   GET   /api/console/top-ups          ?limit=&cursor= → TopUpListResponse (충전 주문 최근순 + 콘솔이 결제하는 방법: provider, 토스면 clientKey)
//   POST  /api/console/top-ups          헤더 Idempotency-Key(8~128자 [A-Za-z0-9_-]) + CreateTopUpBody → 201 TopUpDto.
//                                       같은 키 재요청도 201 + 같은 본문 + Idempotent-Replayed: true. 같은 키·다른 상품 422 idempotency_key_reused,
//                                       키 없음·형식 400 invalid_idempotency_key, 모르는 상품 400 invalid_package, 제공자 없음 503 payments_unavailable
//   POST  /api/console/top-ups/:id/simulate  SimulatePaymentBody → SimulatePaymentResponse. 모의 제공자일 때만 있다(아니면 404).
//                                       모의 제공자가 서명한 웹훅을 웹훅 경로와 같은 처리에 넣는다. 이벤트 id가 주문·결과로 정해져 같은 버튼은 곧 재배달
//   POST  /api/console/top-ups/:id/confirm   ConfirmTopUpBody → ConfirmTopUpResponse. 토스 제공자일 때만 있다(아니면 404).
//                                       결제창 성공 주소로 돌아온 결제를 서버가 토스 승인 API로 확정한다. 같은 결제는 몇 번 보내도 원장 한 줄.
//                                       본문 모양 400 invalid_payment, 주문 없음·다른 테넌트·토스 주문 아님 404 not_found,
//                                       돌아온 금액 ≠ 주문 금액(토스를 부르지 않는다)·토스가 알려 준 결제가 이 주문·금액이 아님 422 payment_mismatch
// 상태를 바꾸는 요청(login·logout·PATCH·POST·PUT·DELETE)은 대화 API와 같은 Origin 검사를 받는다. 날짜는 ISO 8601 문자열이다.

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
export type PaymentProviderName = 'mock' | 'toss';
/** 결제 제공자 이벤트가 알리는 결과. 곧 주문의 목표 상태다. */
export type PaymentResult = 'paid' | 'failed';
export const PAYMENT_RESULTS: readonly PaymentResult[] = ['paid', 'failed'];
/** applied = 이벤트가 주문 상태를 옮겼다. stale = 이미 그 이상이라 그대로다. 재배달에는 처음 판정을 그대로 돌려준다. */
export type SettleOutcome = 'applied' | 'stale';

/**
 * 충전 상품표. 금액(원)은 클라이언트가 보내지 않고 서버가 이 표에서만 가져와 주문에 굳힌다 — 웹훅의 금액은 그 값과 대조한다.
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

/** 콘솔이 충전 주문을 결제하는 방법. mock = 결제 결과 흉내 버튼, toss = 토스 결제창(clientKey는 SDK를 여는 브라우저용 공개 값). */
export type TopUpCheckout = { provider: 'mock' } | { provider: 'toss'; clientKey: string };

/** 버전 없는 주소라 SRI를 걸 수 없다. */
export const TOSS_SDK_URL = 'https://js.tosspayments.com/v2/standard';

/** provider가 null이면 이 서버에서는 충전할 수 없다(운영 기본). */
export type TopUpListResponse = (TopUpCheckout | { provider: null }) & { items: TopUpDto[]; nextCursor: string | null };

/** POST /api/console/top-ups/:id/confirm의 클라이언트 시간 제한(ms). 서버는 토스 승인·조회를 이 안에 끝내고 답한다. */
export const CONFIRM_TOP_UP_TIMEOUT_MS = 30_000;

export interface ConfirmTopUpBody {
  /** 결제창 성공 주소 쿼리의 paymentKey. */
  paymentKey: string;
  /** 결제창 성공 주소 쿼리의 amount(원). 서버는 주문 금액과 대조만 하고, 승인에는 언제나 주문 금액을 쓴다. */
  amount: number;
}

export type ConfirmTopUpResponse =
  /**
   * 토스가 결과(완료·실패·만료)를 확인해 줬고 판정을 거쳤다. topUp.status가 지금 상태다.
   * replayed = 같은 결과를 이미 반영했었다(재확정·웹훅과 겹침). outcome은 처음 판정이고, 이 요청으로 잔액은 움직이지 않았다.
   */
  | { outcome: SettleOutcome; replayed: boolean; topUp: TopUpDto }
  /** 토스가 아직 결제를 끝내지 않았거나, 그런 결제를 찾지 못했거나, 답을 받지 못했다. 주문은 그대로이고, 같은 본문을 다시 보내도 두 번 결제되지 않는다. */
  | { outcome: 'unconfirmed' };

export interface SimulatePaymentBody {
  result: PaymentResult;
}

export interface SimulatePaymentResponse {
  outcome: WebhookOutcome;
  /** 같은 이벤트의 재배달이었다. outcome은 처음 판정이다. */
  replayed: boolean;
  topUp: TopUpDto;
}

/** 지표 집계 창의 길이(일). 창은 [응답 시각 − 7×24h, 응답 시각). */
export const METRICS_WINDOW_DAYS = 7;

export interface ConsoleMetricsResponse {
  /** 집계 창 [from, to). to는 응답을 만든 시각. */
  window: { from: string; to: string };
  /**
   * 공백이 아닌 답변 조각을 보낸 대화 요청의 TTFT(요청 수신 → 그런 첫 조각, ms). nearest-rank 백분위(= Postgres percentile_disc)라
   * 값은 언제나 실제 한 요청의 값이다. samples가 0이면 둘 다 null.
   */
  ttft: { samples: number; p50Ms: number | null; p95Ms: number | null };
  autoResolution: {
    /** 창 안에 시작해 방문자 질문이 1개 이상인 대화. 분모. 질문 없이 상담원 연결만 요청한 대화는 빠진다(공개 키로 분모를 부풀릴 수 없게). */
    conversations: number;
    /** 그중 답이 1개 이상이고 상담원 연결 요청(모델 신호·방문자 요청, 상태 무관)이 없는 대화. 분자. */
    resolved: number;
    /** resolved / conversations. conversations가 0이면 null. 반올림하지 않는다. */
    rate: number | null;
    /**
     * 창 안에 시작해 질문 없이 상담원 연결만 요청한 대화. conversations·resolved·rate에는 넣지 않는다.
     * 비율에서 뺀 대화를 운영자가 볼 수 있게 따로 센다. 공개 키로 늘릴 수 있는 수라 비율과 섞지 않는다.
     */
    handoffOnly: number;
  };
  /** 방문자 브라우저가 보고한 위젯 열림(페이지 로드당 첫 열림). 공개 키로 꾸밀 수 있어 서버 사건과 비율을 만들지 않는다. */
  widget: { opens: number };
  /**
   * 지금 인사말 실험의 변형별 노출 → 첫 질문. 둘 다 방문자 브라우저가 보고한 수라 같은 신뢰 수준끼리의 비율이다(서버 사건과 섞지 않는다).
   * 단위는 페이지 로드(노출)이고 방문자가 아니다. 실험이 없으면 null.
   */
  greeting: {
    experiment: string;
    /** 지금 정의의 변형 순서. 사건이 없는 변형도 0으로 나온다. */
    variants: {
      id: string;
      label: string;
      text: string;
      /** 창 안 widget_open 중 이 변형을 실은 것. 분모. */
      exposures: number;
      /** 창 안 first_question 중 이 변형을 실은 것. 분자. */
      firstQuestions: number;
      /** firstQuestions / exposures. exposures가 0이면 null. 반올림·상한 없음(1을 넘으면 열림 사건 유실이나 위조다). */
      rate: number | null;
    }[];
    /**
     * 창 안 위젯 사건 중 지금 실험의 변형이 없는 것(인사말 실패·첫 질문이 인사말보다 먼저 나간 페이지 로드·실험 전 대화창·옛 실험).
     * 위 비율에는 넣지 않고, 뺀 수를 숨기지 않게 따로 센다.
     */
    outside: { opens: number; questions: number };
  } | null;
}

/**
 * FAQ 상한. 위젯은 질문마다 그 회사의 FAQ 전체를 읽고 답해서(ADR-0004) 항목과 글자가 늘수록 답이 느려지고 한 번의 답에 드는 비용이 는다.
 * items·totalChars는 서버가 막는 상한이고 recommendedItems는 콘솔이 알려 주는 권장 개수다. 시드·회사 파일도 같은 상한을 지킨다.
 */
export const KNOWLEDGE_LIMITS = {
  items: 50,
  recommendedItems: 30,
  titleChars: 100,
  categoryChars: 30,
  blocks: 10,
  blockChars: 1000,
  /** 회사 FAQ 전체의 제목·문단 글자 합(knowledgeChars). */
  totalChars: 30_000,
} as const;

/** FAQ id. 시드의 faq:refund-policy 같은 모양이고, 콘솔은 새 항목에 faq:<무작위>를 만들어 PUT한다. */
export const KNOWLEDGE_ID_PATTERN = /^faq:[a-z0-9][a-z0-9-]{0,63}$/;

/** PUT /api/console/knowledge/:id 본문. 문단(blocks) 하나가 위젯이 인용하는 최소 단위다. */
export interface KnowledgeInput {
  /** 방문객이 묻는 질문. 위젯의 출처 이름으로도 보인다. */
  title: string;
  category: string;
  blocks: string[];
}

export interface KnowledgeItemDto extends KnowledgeInput {
  id: string;
}

export interface KnowledgeListResponse {
  items: KnowledgeItemDto[];
}

/**
 * 전체 글자 상한(totalChars)이 세는 양. 분류는 위젯이 읽는 자료에 들어가지 않아 세지 않는다.
 * 길이는 코드 포인트로 센다. 칸마다의 상한(zod의 .max())과 같은 단위라야 칸을 모두 지킨 저장이 합계에서 다르게 세지지 않는다.
 */
export function knowledgeChars(item: Pick<KnowledgeInput, 'title' | 'blocks'>): number {
  const length = (text: string): number => [...text].length;
  return item.blocks.reduce((sum, block) => sum + length(block), length(item.title));
}

/** 서버가 위젯 런처 스크립트를 주는 경로. 런처는 이 스크립트를 내려준 오리진을 위젯 서버로 쓴다(packages/widget/src/loader.ts). */
export const WIDGET_SCRIPT_PATH = '/widget.js';

/** 위젯을 넣을 수 있는 사이트 수 상한. 허용 사이트는 대화창 응답의 CSP frame-ancestors 헤더에 그대로 들어간다. */
export const MAX_ALLOWED_ORIGINS = 10;

export interface InstallStatusResponse {
  /** 설치 스니펫의 data-tenant 값. 공개 식별자다. */
  tenantKey: string;
  /** 위젯 런처 스크립트 주소(이 서버의 WIDGET_SCRIPT_PATH). */
  scriptUrl: string;
  /** 위젯이 열리는 사이트의 정규형 오리진(scheme://host[:port]). */
  allowedOrigins: string[];
  /**
   * 대화창이 마지막으로 열린 때(widget_open 사건). 없으면 null. 대화창은 허용 사이트에서만 열리지만,
   * 방문자 브라우저가 보내는 사건이라 공개 키로 꾸밀 수 있다. 설치 확인 표시에만 쓴다.
   */
  lastOpenedAt: string | null;
}

/** PUT /api/console/install/origins 본문. 목록 전체를 바꾼다(빈 목록이면 어느 사이트에서도 위젯이 열리지 않는다). */
export interface UpdateAllowedOriginsBody {
  origins: string[];
}

const escapeAttribute = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/** 고객 사이트에 붙이는 설치 스니펫 한 줄. 콘솔 설치 화면과 운영자 명령(tenant:add)이 같은 모양을 쓴다. */
export function widgetSnippet({ scriptUrl, tenantKey }: { scriptUrl: string; tenantKey: string }): string {
  return `<script src="${escapeAttribute(scriptUrl)}" data-tenant="${escapeAttribute(tenantKey)}" defer></script>`;
}
