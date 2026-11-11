import type Anthropic from '@anthropic-ai/sdk';
import type { EngineEvent, HandoffReason } from './types.js';

// 핸드오프 신호용 도구 (2026-11-03 결정, ADR-0005).
//
// 모델이 "이 질문은 안내 자료로 답할 수 없다"고 판단하면 안내 문장을 쓴 뒤 이 도구를 부른다. 서버는 도구를 실행하지 않는다 —
// 돌려줄 결과가 없고, 호출 자체가 신호다. 그 턴은 거기서 끝나고 서버는 event: handoff를 보낸다.
// 글자 마커 대신 도구를 쓰는 이유: 신호가 응답의 별도 블록(tool_use)이라 글자 비교가 없고, 사용자 입력으로 위조할 수 없고,
// 사유·요약을 스키마로 받는다. 놓침(도구를 안 부름)은 호출 부재로 셀 수 있다.
// 도구 정의는 프롬프트 접두사(tools → system → messages)의 맨 앞에 들어간다. 이 텍스트를 바꾸면 캐시가 한 번 다시 만들어진다.

export const HANDOFF_TOOL_NAME = 'request_handoff';

/** 도구 스키마의 enum. 계약(HandoffReason)의 other는 수신 쪽 안전값이라 모델에게는 주지 않는다. */
const REASONS = ['not_in_knowledge', 'needs_human'] as const satisfies readonly HandoffReason[];

/**
 * 신호에서 읽어 줄 사유. 모델에게 주는 enum(REASONS)보다 넓다 — out_of_scope는 계약의 값이지만 무관한 질문은 넘기지 않기로 해서
 * (2026-11-11 답 기준) 모델에게는 주지 않는다. 그래도 들어오면 버리지 않고 그대로 옮긴다.
 */
const KNOWN_REASONS = [...REASONS, 'out_of_scope'] as const satisfies readonly HandoffReason[];

/** 상담원이 볼 한 줄 요약의 길이 상한. 큐·로그에 들어가는 값이라 모델이 길게 써도 자른다. */
const SUMMARY_MAX = 200;

export const HANDOFF_TOOL: Anthropic.Beta.BetaTool = {
  name: HANDOFF_TOOL_NAME,
  description: [
    '함께 제공된 자료로 답할 수 없어 상담원이 이어서 답해야 할 때 상담원 연결을 요청합니다.',
    '먼저 사용자에게 그 부분은 상담원이 이어서 안내한다고 알리는 문장을 쓴 뒤 이 도구를 호출합니다. 도구만 호출하고 문장을 생략하지 않습니다.',
    '자료에 답이 있으면 호출하지 않습니다. 자료에 지원하지 않는다고 적힌 기능을 물을 때, 인사·감사, 이 서비스와 무관한 질문에도 호출하지 않습니다.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        enum: [...REASONS],
        description: 'not_in_knowledge = 자료로 답할 수 없는 질문. needs_human = 환불 처리·계정 변경처럼 사람이 직접 처리해야 하는 요청.',
      },
      summary: { type: 'string', description: '상담원이 볼 한 줄 요약. 사용자가 무엇을 물었는지 한국어로 짧게.' },
    },
    required: ['reason'],
  },
};

/** 응답 content의 블록 중 신호를 읽는 데 필요한 모양. SDK의 content 블록 유니언이 그대로 들어온다. */
interface ContentBlockLike {
  type: string;
  name?: string;
  input?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 응답 content에서 신호용 도구 호출을 찾아 엔진 이벤트로 만든다. 없으면 null.
 * 입력이 스키마와 달라도 신호 자체는 살린다 — reason은 other, summary는 null. 신호를 잃는 것보다 사유를 잃는 쪽이 낫다.
 */
export function readHandoff(content: readonly ContentBlockLike[]): Extract<EngineEvent, { type: 'handoff' }> | null {
  const block = content.find((b) => b.type === 'tool_use' && b.name === HANDOFF_TOOL_NAME);
  if (!block) return null;
  const input = isRecord(block.input) ? block.input : {};
  const reason: HandoffReason =
    typeof input.reason === 'string' && (KNOWN_REASONS as readonly string[]).includes(input.reason)
      ? (input.reason as HandoffReason)
      : 'other';
  const summary = typeof input.summary === 'string' && input.summary.trim() ? input.summary.trim().slice(0, SUMMARY_MAX) : null;
  return { type: 'handoff', reason, summary };
}
