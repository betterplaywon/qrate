// 요청 본문·쿼리의 zod 스키마 — 서버(검증)와 콘솔(폼 검증)이 같은 정의를 쓴다.
//
// 별도 진입점(@qrate/contracts/schemas)인 이유: 루트 진입점은 위젯 런처(3.7kB)도 쓰므로 zod를 끌어들이지 않는다.
// 서버는 safeParse 결과를 계약의 오류 코드(ApiErrorCode)로 옮기고, 콘솔은 react-hook-form의 zodResolver에 넣는다.

import { z } from 'zod';
import { MAX_MESSAGE_CHARS } from './chat.js';
import { CONSOLE_LIST_LIMIT, HANDOFF_STATUSES } from './console.js';
import { MAX_HANDOFF_CONTACT_CHARS, MAX_HANDOFF_MESSAGE_CHARS } from './handoff.js';

/** 이전 응답 헤더의 대화 id. 없거나 비어 있거나 문자열이 아니면 새 대화로 본다(거부하지 않는다 — 옛 위젯과의 호환). */
const lenientConversationId = z.unknown().optional().transform((v) => (typeof v === 'string' && v ? v : null));

/** POST /api/chat 본문. message는 앞뒤 공백을 뗀 뒤 비어 있지 않고 MAX_MESSAGE_CHARS 이하. */
export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  tenant: z.string().min(1),
  conversationId: lenientConversationId,
});

/** POST /api/handoff 본문. contact는 이메일, message는 선택(빈 문자열은 없음으로). */
export const handoffRequestSchema = z.object({
  tenant: z.string().min(1),
  conversationId: lenientConversationId,
  contact: z.string().trim().max(MAX_HANDOFF_CONTACT_CHARS).pipe(z.email()),
  message: z
    .string()
    .trim()
    .max(MAX_HANDOFF_MESSAGE_CHARS)
    .nullish()
    .transform((v) => v || null),
});

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
export type ConsoleListQuery = z.infer<typeof consoleListQuerySchema>;
