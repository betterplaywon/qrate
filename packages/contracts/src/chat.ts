// 대화 API 계약 — 서버가 보내는 것과 위젯이 읽는 것의 유일한 정의.
//
//   POST /api/chat   본문 ChatRequestBody. 성공이면 SSE 스트림(ChatStreamEvent의 연속)과 응답 헤더 X-Conversation-Id.
//                    첫 이벤트 전에 실패하면 HTTP 상태 + ApiErrorBody(재시도 가능하면 Retry-After 헤더).
//   GET  /frame?t=   대화창 문서. 테넌트 키가 없으면 400, 모르는 키면 404 (ApiErrorBody).
//
// 스트림 이벤트의 전송 형식 (encodeChatEvent ↔ parseChatEvent):
//   data: {"delta":"..."}                        답변 조각. event 필드 없음(= message)
//   event: moderation  data: {level, reasons}    입력이 경고 레벨일 때, 첫 조각 전에 1회
//   event: citation    data: {...Citation}       인용. 답변 조각 사이에 끼어 온다
//   event: done        data: {stopReason, ...}   정상 종료 직전의 메타. 토큰 사용량·모델은 보내지 않는다(운영자 정보)
//   event: error       data: {code, retryable}   스트림 시작 후 실패. 이 뒤에는 [DONE] 없이 연결이 끝난다
//   data: [DONE]                                  종료 센티널
//
// 이벤트 종류를 늘릴 때는 ChatStreamEvent에 변형을 추가하고 encode·parse를 함께 고친다. 왕복 테스트(test/chat.test.ts)가 어긋남을 잡는다.
// 수신 쪽은 모르는 이벤트와 형식이 다른 데이터를 건너뛴다(parseChatEvent → null). 서버가 먼저 배포돼도 이전 위젯이 깨지지 않게.

import { formatSSE, type SSEEvent } from './sse.js';

export const CHAT_PATH = '/api/chat';
export const FRAME_PATH = '/frame';
/** 서버가 첫 응답 헤더로 알려 주는 대화 id. 다음 요청 본문의 conversationId에 실으면 이전 턴이 문맥으로 들어간다. */
export const CONVERSATION_ID_HEADER = 'X-Conversation-Id';

export interface ChatRequestBody {
  message: string;
  /** 위젯 설치 스니펫의 data-tenant 값. 공개 식별자이며 비밀키가 아니다. */
  tenant: string;
  conversationId?: string | null;
}

/** 엔진(상류 모델) 실패. 스트림 시작 전이면 HTTP 상태 + ApiErrorBody, 시작 후면 event: error. */
export type StreamErrorCode =
  | 'upstream_auth'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_bad_request'
  | 'upstream_error';

/** HTTP 오류 본문 {error}의 값. 글자 그대로 공개 계약이라, 바꾸면 위젯·콘솔이 함께 바뀐다. */
export type ApiErrorCode =
  | 'message is required'
  | 'tenant is required'
  | 'unknown_tenant'
  | 'origin_not_allowed'
  | 'blocked_by_moderation'
  | StreamErrorCode;

export interface ApiErrorBody {
  /** 알려진 코드가 기본이지만, 수신 쪽은 모르는 값도 문자열로 받아들인다. */
  error: ApiErrorCode | (string & {});
  /** 엔진 실패일 때만. 같은 요청을 다시 보내도 되는가. */
  retryable?: boolean;
  /** blocked_by_moderation일 때 걸린 규칙. */
  reasons?: string[];
}

export type StopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'other';

/** API가 원문에서 잘라 준 인용. 모델이 만든 문장이 아니라 서버가 넣은 지식 블록의 텍스트다. */
export interface Citation {
  /** 요청에 넣은 지식 블록들 중 몇 번째인지 (0부터). */
  sourceIndex: number;
  /** 지식의 안정적인 식별자. 예: faq:refund-policy */
  sourceId: string;
  title: string;
  citedText: string;
  /** 해당 지식의 blocks 배열에서 [blockStart, blockEnd) 범위. */
  blockStart: number;
  blockEnd: number;
}

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  /** 입력이 경고 레벨(응답은 계속된다). 전송 형식에는 level: 'warn'이 함께 실린다 — 차단은 스트림이 시작되지 않으므로. */
  | { type: 'moderation'; reasons: string[] }
  | { type: 'citation'; citation: Citation }
  | { type: 'done'; stopReason: StopReason; refusalCategory: string | null }
  | { type: 'error'; code: StreamErrorCode | (string & {}); retryable: boolean }
  /** 종료 센티널 data: [DONE] */
  | { type: 'end' };

const DONE_SENTINEL = '[DONE]';
const STOP_REASONS: readonly string[] = ['end_turn', 'max_tokens', 'refusal', 'other'] satisfies StopReason[];

export function encodeChatEvent(ev: ChatStreamEvent): string {
  switch (ev.type) {
    case 'delta':
      return formatSSE(null, JSON.stringify({ delta: ev.text }));
    case 'moderation':
      return formatSSE('moderation', JSON.stringify({ level: 'warn', reasons: ev.reasons }));
    case 'citation':
      return formatSSE('citation', JSON.stringify(ev.citation));
    case 'done':
      return formatSSE(
        'done',
        JSON.stringify({
          stopReason: ev.stopReason,
          ...(ev.refusalCategory ? { refusalCategory: ev.refusalCategory } : {}),
        }),
      );
    case 'error':
      return formatSSE('error', JSON.stringify({ code: ev.code, retryable: ev.retryable }));
    case 'end':
      return formatSSE(null, DONE_SENTINEL);
  }
}

/** 수신한 SSE 이벤트를 계약의 이벤트로. 모르는 이벤트·형식이 다른 데이터는 null(건너뛴다). */
export function parseChatEvent(raw: SSEEvent): ChatStreamEvent | null {
  if (raw.event === 'message' && raw.data === DONE_SENTINEL) return { type: 'end' };
  const data = parseJsonObject(raw.data);
  if (!data) return null;

  switch (raw.event) {
    case 'message':
      return typeof data.delta === 'string' ? { type: 'delta', text: data.delta } : null;
    case 'moderation':
      return isStringArray(data.reasons) ? { type: 'moderation', reasons: data.reasons } : null;
    case 'citation': {
      const citation = readCitation(data);
      return citation ? { type: 'citation', citation } : null;
    }
    case 'done':
      if (typeof data.stopReason !== 'string') return null;
      return {
        type: 'done',
        // 서버가 종료 사유를 늘려도 이전 위젯이 깨지지 않게, 모르는 값은 other로 읽는다.
        stopReason: STOP_REASONS.includes(data.stopReason) ? (data.stopReason as StopReason) : 'other',
        refusalCategory: typeof data.refusalCategory === 'string' ? data.refusalCategory : null,
      };
    case 'error':
      return typeof data.code === 'string' && typeof data.retryable === 'boolean'
        ? { type: 'error', code: data.code, retryable: data.retryable }
        : null;
    default:
      return null;
  }
}

/** 첫 이벤트 전 실패·거절의 JSON 본문. error 문자열이 없으면 이 계약의 오류 본문이 아니다(프록시 오류 페이지 등). */
export function parseApiErrorBody(value: unknown): ApiErrorBody | null {
  if (!isRecord(value) || typeof value.error !== 'string') return null;
  return {
    error: value.error,
    ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
    ...(isStringArray(value.reasons) ? { reasons: value.reasons } : {}),
  };
}

function parseJsonObject(data: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function readCitation(data: Record<string, unknown>): Citation | null {
  const { sourceIndex, sourceId, title, citedText, blockStart, blockEnd } = data;
  if (
    typeof sourceIndex !== 'number' ||
    typeof sourceId !== 'string' ||
    typeof title !== 'string' ||
    typeof citedText !== 'string' ||
    typeof blockStart !== 'number' ||
    typeof blockEnd !== 'number'
  ) {
    return null;
  }
  return { sourceIndex, sourceId, title, citedText, blockStart, blockEnd };
}
