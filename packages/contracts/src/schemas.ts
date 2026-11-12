// 요청 본문·쿼리의 zod 스키마 — 서버(검증)와 콘솔(폼 검증)이 같은 정의를 쓴다.
//
// 별도 진입점(@qrate/contracts/schemas)인 이유: 루트 진입점은 위젯 런처(3.7kB)도 쓰므로 zod를 끌어들이지 않는다.
// 서버는 safeParse 결과를 계약의 오류 코드(ApiErrorCode)로 옮기고, 콘솔은 react-hook-form의 zodResolver에 넣는다.

import { z } from 'zod';
import { MAX_MESSAGE_CHARS } from './chat.js';
import {
  CONSOLE_LIST_LIMIT,
  HANDOFF_STATUSES,
  KNOWLEDGE_ID_PATTERN,
  KNOWLEDGE_LIMITS,
  MAX_ALLOWED_ORIGINS,
  PAYMENT_RESULTS,
  TOP_UP_PACKAGE_IDS,
} from './console.js';
import { WIDGET_EVENT_TYPES } from './events.js';
import { MAX_HANDOFF_CONTACT_CHARS, MAX_HANDOFF_MESSAGE_CHARS } from './handoff.js';

/**
 * 비어 있지 않은 문자열이면 그대로, 아니면(없음·빈 문자열·배열·숫자) null. 거부하지 않는다 — 요청 전체를 지키고 이 값만 버린다.
 * 대화 id(없으면 새 대화, 옛 위젯과의 호환)와 인사말 변형(없으면 보존값 없음·실험 밖)이 쓴다.
 */
const lenientText = z.unknown().optional().transform((v) => (typeof v === 'string' && v ? v : null));

/** POST /api/chat 본문. message는 앞뒤 공백을 뗀 뒤 비어 있지 않고 MAX_MESSAGE_CHARS 이하. */
export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  tenant: z.string().min(1),
  conversationId: lenientText,
});

/** POST /api/handoff 본문. contact는 이메일, message는 선택(빈 문자열은 없음으로). */
export const handoffRequestSchema = z.object({
  tenant: z.string().min(1),
  conversationId: lenientText,
  contact: z.string().trim().max(MAX_HANDOFF_CONTACT_CHARS).pipe(z.email()),
  message: z
    .string()
    .trim()
    .max(MAX_HANDOFF_MESSAGE_CHARS)
    .nullish()
    .transform((v) => v || null),
});

export const widgetEventSchema = z.object({
  tenant: z.string().min(1),
  type: z.enum(WIDGET_EVENT_TYPES),
  variant: lenientText,
});

/** GET /api/greeting 쿼리. ?variant=a&variant=b 같은 배열은 보존값 없음으로 본다. */
export const greetingQuerySchema = z.object({ tenant: z.string().min(1), variant: lenientText });

/** 콘솔 로그인 본문. 두 값 모두 사람이 적는 짧은 문자열이다 — 상한은 무차별 대입의 본문 크기를 제한한다. */
export const consoleLoginSchema = z.object({
  tenant: z.string().trim().min(1, '테넌트 키를 입력해 주세요.').max(256),
  key: z.string().min(1, '콘솔 키를 입력해 주세요.').max(256),
});
export type ConsoleLoginInput = z.infer<typeof consoleLoginSchema>;

export const handoffStatusSchema = z.enum(HANDOFF_STATUSES);

/** PATCH /api/console/handoffs/:id 본문. */
export const updateHandoffSchema = z.object({ status: handoffStatusSchema });

/** 목록 조회 쿼리(?limit=&cursor=&status=). limit은 1..max의 정수, 없으면 기본값. */
export const consoleListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(CONSOLE_LIST_LIMIT.max).default(CONSOLE_LIST_LIMIT.default),
  cursor: z.string().min(1).optional(),
  status: handoffStatusSchema.optional(),
});

/** 충전 요청의 Idempotency-Key 헤더. 콘솔은 UUID를 쓴다. */
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

/** POST /api/console/top-ups 본문. 금액은 받지 않는다 — 서버의 상품표에서만 온다. */
export const createTopUpSchema = z.object({ packageId: z.enum(TOP_UP_PACKAGE_IDS) });
export type CreateTopUpInput = z.infer<typeof createTopUpSchema>;

/** POST /api/console/top-ups/:id/simulate 본문. */
export const simulatePaymentSchema = z.object({ result: z.enum(PAYMENT_RESULTS) });

/**
 * 토스 안내대로 형식(접두사·길이·문자 구성)은 보지 않고 공백·제어 문자 없는 ASCII와 상한 200자만 본다.
 * 서버가 이 값을 조회 경로 /v1/payments/<결제 키>에 넣는데, "."·".."는 URL이 점 경로로 접어 시크릿 키 요청이 다른 경로로 가서 받지 않는다.
 */
export const paymentKeySchema = z
  .string()
  .regex(/^[\x21-\x7e]{1,200}$/)
  .refine((key) => key !== '.' && key !== '..');

/** POST /api/console/top-ups/:id/confirm 본문. */
export const confirmTopUpSchema = z.object({
  paymentKey: paymentKeySchema,
  amount: z.number().int().nonnegative(),
});

const { titleChars, categoryChars, blocks: maxBlocks, blockChars } = KNOWLEDGE_LIMITS;

/**
 * 공백 계열(\t \n \v \f \r) 말고는 제어 문자가 없고 짝 없는 서로게이트도 없는 글. Postgres text 열은 NUL을 받지 못해 500이 되고,
 * 짝 없는 서로게이트는 저장하면서 U+FFFD로 조용히 바뀐다. \v·\f는 워드·파워포인트에서 붙여 넣은 줄바꿈이라 받는다.
 * for...of는 짝 맞은 서로게이트를 한 글자로 묶으므로 남는 서로게이트는 짝이 없는 것이다.
 */
function isPlainText(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const whitespace = code >= 0x09 && code <= 0x0d;
    if ((code < 0x20 && !whitespace) || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)) return false;
  }
  return true;
}
const PLAIN_TEXT_MESSAGE = '보이지 않는 특수 문자가 들어 있어요. 그 부분을 지우고 다시 써 주세요.';

/** FAQ 문단 하나. 콘솔 폼은 문단마다 칸이 따로라 이 스키마를 칸 단위로도 쓴다. 길이는 zod의 .max()처럼 코드 포인트로 센다(knowledgeChars와 같다). */
export const knowledgeBlockSchema = z
  .string()
  .trim()
  .min(1, '빈 문단이에요. 내용을 쓰거나 문단을 지워 주세요.')
  .max(blockChars, `문단 하나는 ${blockChars.toLocaleString('ko-KR')}자까지 쓸 수 있어요.`)
  .refine(isPlainText, PLAIN_TEXT_MESSAGE);

/** 문단 개수 규칙. 콘솔 폼은 문단을 {text} 객체로 들고 있어서(useFieldArray) 같은 규칙을 다른 원소에 씌운다. */
export function knowledgeBlocks<T extends z.ZodType>(block: T) {
  return z.array(block).min(1, '답을 한 문단 이상 써 주세요.').max(maxBlocks, `문단은 ${maxBlocks}개까지 쓸 수 있어요.`);
}

/** PUT /api/console/knowledge/:id 본문. 앞뒤 공백은 떼고 저장한다. */
export const knowledgeInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, '방문객이 묻는 질문을 써 주세요.')
    .max(titleChars, `질문은 ${titleChars}자까지 쓸 수 있어요.`)
    .refine(isPlainText, PLAIN_TEXT_MESSAGE),
  category: z
    .string()
    .trim()
    .min(1, '분류를 고르거나 새로 써 주세요.')
    .max(categoryChars, `분류는 ${categoryChars}자까지 쓸 수 있어요.`)
    .refine(isPlainText, PLAIN_TEXT_MESSAGE),
  blocks: knowledgeBlocks(knowledgeBlockSchema),
});

export const knowledgeIdSchema = z.string().regex(KNOWLEDGE_ID_PATTERN);

/** PUT /api/console/install/origins 본문. 각 값이 정규형 오리진인지는 서버가 isOriginString으로 본다(CSP 헤더에 그대로 들어가므로 서버 한 곳에서). */
export const updateAllowedOriginsSchema = z.object({ origins: z.array(z.string().max(2048)).max(MAX_ALLOWED_ORIGINS) });
