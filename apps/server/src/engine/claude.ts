import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../config.js';
import { HANDOFF_TOOL, readHandoff } from './handoff.js';
import { buildSystemPrompt } from './prompt.js';
import { thinkingParamsFor } from './thinking.js';
import {
  EngineError,
  isAbortError,
  type AnswerEngine,
  type Citation,
  type EngineEvent,
  type EngineRequest,
  type KnowledgeSource,
  type StopReason,
} from './types.js';

// 정책 거절(stop_reason: refusal) 시 서버 측 대체 모델 재시도(베타).
// 'default'는 API가 정한 대체 구성을 쓰고, 지원하지 않는 모델에서는 요청 모델만으로 실행된다(400이 아니다).
// 배열 형태(모델 직접 지정)는 다른 베타 헤더를 쓰므로 섞지 않는다.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class ClaudeEngine implements AnswerEngine {
  readonly name = 'claude';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(
    private readonly config: AppConfig,
    client?: Anthropic,
  ) {
    this.model = config.model;
    this.client = client ?? new Anthropic({ apiKey: config.apiKey });
  }

  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        // 시스템 지시는 테넌트별 고정 → 캐시 지점 1. (512토큰 미만이면 캐시되지 않지만 해롭지 않다)
        system: [
          { type: 'text', text: buildSystemPrompt(req.tenantName), cache_control: { type: 'ephemeral' } },
        ],
        messages: buildMessages(req),
        // 핸드오프 신호용 도구(engine/handoff.ts). 도구는 하나고 턴마다 신호는 최대 1회라 병렬 호출은 끈다.
        tools: [HANDOFF_TOOL],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        ...thinkingParamsFor(this.config.model, this.config.thinking),
        ...(this.config.fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
      },
      // 위젯이 연결을 끊으면 모델 호출도 끊는다. 생성이 멈추므로 출력 토큰 비용도 거기서 멈춘다.
      { signal: req.signal },
    );

    try {
      for await (const event of stream) {
        if (event.type !== 'content_block_delta') continue;
        if (event.delta.type === 'text_delta') {
          yield { type: 'delta', text: event.delta.text };
        } else if (event.delta.type === 'citations_delta') {
          // 인용은 텍스트 조각 사이에 끼어 온다. API가 원문에서 잘라 준 것이라 검증 없이 쓴다.
          const citation = toCitation(event.delta.citation);
          if (citation) yield { type: 'citation', citation };
        }
      }
      const final = await stream.finalMessage();
      // 신호용 도구 호출은 응답 끝의 블록이라 finalMessage에서 읽는다. 텍스트 조각을 다 보낸 뒤, done 앞에 1회.
      const handoff = readHandoff(final.content);
      if (handoff) yield handoff;
      yield summarize(final, this.config.model);
    } catch (err) {
      throw toEngineError(err);
    }
  }
}

function buildMessages(req: EngineRequest): Anthropic.Beta.BetaMessageParam[] {
  const turns = [...req.history, { role: 'user' as const, text: req.message }];
  const knowledgeBlocks = toSearchResults(req.knowledge);
  // 지식 블록은 "첫" 사용자 턴에 둔다. 턴이 쌓여도 앞부분이 그대로라 캐시가 맞는다.
  return turns.map((turn, i): Anthropic.Beta.BetaMessageParam => {
    if (i === 0 && knowledgeBlocks.length > 0) {
      return { role: turn.role, content: [...knowledgeBlocks, { type: 'text', text: turn.text }] };
    }
    return { role: turn.role, content: turn.text };
  });
}

function toSearchResults(knowledge: KnowledgeSource[]): Anthropic.Beta.BetaSearchResultBlockParam[] {
  return knowledge.map((k, i): Anthropic.Beta.BetaSearchResultBlockParam => ({
    type: 'search_result',
    source: k.id,
    title: k.title,
    // blocks 하나가 인용의 최소 단위다. 문단별로 나눠 넣으면 문단 단위로 인용된다.
    content: k.blocks.map((text): Anthropic.Beta.BetaTextBlockParam => ({ type: 'text', text })),
    // 인용은 요청 안의 모든 search_result에 같은 설정이어야 한다(전부 켬).
    citations: { enabled: true },
    // 마지막 지식 블록 → 캐시 지점 2. 시스템 지시 + 지식 전체가 요청마다 같은 접두사다.
    ...(i === knowledge.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
}

function toCitation(c: Anthropic.Beta.BetaTextCitation): Citation | null {
  if (c.type !== 'search_result_location') return null;
  return {
    sourceIndex: c.search_result_index,
    sourceId: c.source,
    title: c.title ?? '',
    citedText: c.cited_text,
    blockStart: c.start_block_index,
    blockEnd: c.end_block_index,
  };
}

function summarize(final: Anthropic.Beta.BetaMessage, requestedModel: string): EngineEvent {
  const iterations = final.usage.iterations ?? [];
  // 서버 측 폴백이 작동했는지: 전환 지점 블록(fallback) 또는 사용량 반복 항목으로 안다.
  const fallbackUsed =
    final.content.some((b) => b.type === 'fallback') ||
    iterations.some((it) => it.type === 'fallback_message');
  return {
    type: 'done',
    stopReason: toStopReason(final.stop_reason),
    refusalCategory: final.stop_details?.category ?? null,
    model: requestedModel,
    servedBy: final.model,
    fallbackUsed,
    usage: {
      inputTokens: final.usage.input_tokens,
      cacheCreationInputTokens: final.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: final.usage.cache_read_input_tokens ?? 0,
      outputTokens: final.usage.output_tokens,
    },
  };
}

function toStopReason(reason: Anthropic.Beta.BetaStopReason | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'max_tokens':
    case 'refusal':
      return reason;
    case 'tool_use':
      // 신호용 도구(request_handoff) 호출로 끝난 턴. 사용자에게는 정상 종료다 — 신호는 event: handoff로 따로 간다.
      return 'end_turn';
    default:
      return 'other';
  }
}

// SDK의 타입 있는 예외를 우리 계약으로 옮긴다. 문자열 매칭은 하지 않는다.
// 비밀값이 섞일 수 있는 메시지(인증)는 그대로 노출하지 않는다. 테스트에서 매핑을 고정하려고 export한다.
export function toEngineError(err: unknown): EngineError {
  if (err instanceof EngineError) return err;
  if (err instanceof Anthropic.APIUserAbortError || isAbortError(err)) {
    return new EngineError('aborted', false, 'client aborted', { cause: err });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new EngineError('upstream_auth', false, 'upstream rejected credentials', { cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new EngineError('rate_limited', true, 'upstream rate limited', { cause: err });
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) {
    return new EngineError('upstream_bad_request', false, err.message, { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.InternalServerError) {
    return new EngineError('upstream_unavailable', true, 'upstream unavailable', { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    // 스트림 도중의 `event: error`는 SDK가 상태 코드 없는 APIError로 던진다(core/streaming.js). 그래서 위 상태별 클래스에 걸리지 않고
    // 본문의 type만 남는다. overloaded·api_error는 재시도의 대표 사례라 여기서 가른다.
    if (err.type === 'overloaded_error' || err.type === 'api_error') {
      return new EngineError('upstream_unavailable', true, `upstream ${err.type}`, { cause: err });
    }
    if (err.type === 'rate_limit_error') {
      return new EngineError('rate_limited', true, 'upstream rate limited', { cause: err });
    }
    return new EngineError('upstream_error', false, err.message, { cause: err });
  }
  return new EngineError('upstream_error', false, err instanceof Error ? err.message : String(err), {
    cause: err,
  });
}
