// 답변 엔진 계약.
//
// 왜 인터페이스를 두는가: 실제 모델(Claude)과 목업을 같은 모양으로 바꿔 끼우기 위해서다.
// CI·테스트는 키 없이 목업으로 돌고, 모델·공급자 교체는 이 계약 뒤에서 일어난다.
// SSE 전송 형식(src/sse.ts)은 이 이벤트들을 그대로 직렬화한다.

/** 프롬프트에 넣을 지식 한 건. blocks 하나가 인용의 최소 단위가 된다. (W2 지식 연결에서 채움) */
export interface KnowledgeSource {
  /** 안정적인 식별자. 인용의 source 필드로 돌아온다. 예: faq:refund-policy */
  id: string;
  title: string;
  blocks: string[];
}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface EngineRequest {
  tenantId: string;
  /** 시스템 지시에 들어가는 표시 이름. 테넌트별로 고정이어야 캐시 접두사가 유지된다. */
  tenantName: string;
  message: string;
  /** 이전 턴들. 첫 턴은 반드시 user. (W2에서는 비어 있고, 대화 저장소가 생기면 채운다) */
  history: HistoryTurn[];
  knowledge: KnowledgeSource[];
  /** 클라이언트가 연결을 끊으면 abort된다. 엔진은 즉시 멈춰야 한다. */
  signal: AbortSignal;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'other';

/** API가 원문에서 잘라 준 인용. 모델이 만든 문장이 아니라 우리가 넣은 블록의 텍스트다. */
export interface Citation {
  /** 요청에 넣은 search_result 블록들 중 몇 번째인지 (0부터). */
  sourceIndex: number;
  sourceId: string;
  title: string;
  citedText: string;
  /** 해당 지식의 blocks 배열에서 [blockStart, blockEnd) 범위. */
  blockStart: number;
  blockEnd: number;
}

export interface Usage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

export type EngineEvent =
  | { type: 'delta'; text: string }
  | { type: 'citation'; citation: Citation }
  | {
      type: 'done';
      stopReason: StopReason;
      /** stop_reason이 refusal일 때 분류기 카테고리. */
      refusalCategory: string | null;
      /** 요청한 모델. */
      model: string;
      /** 실제로 답한 모델. 서버 측 폴백이 작동하면 요청 모델과 다르다. */
      servedBy: string;
      fallbackUsed: boolean;
      usage: Usage;
    };

export interface AnswerEngine {
  readonly name: string;
  readonly model: string;
  stream(req: EngineRequest): AsyncIterable<EngineEvent>;
}

export type EngineErrorCode =
  | 'upstream_auth'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_bad_request'
  | 'upstream_error'
  | 'aborted';

/** 엔진 실패를 HTTP 응답으로 옮길 수 있는 형태로 정규화한다. 공급자별 예외는 각 엔진이 여기로 변환한다. */
export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    /** 첫 이벤트 전에 실패했을 때 위젯에 돌려줄 HTTP 상태. */
    readonly status: number,
    /** 위젯이 같은 요청을 다시 보내도 되는가 (재시도 정책의 입력). */
    readonly retryable: boolean,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EngineError';
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** 어떤 예외든 EngineError로 만든다. 엔진이 변환하지 못한 것은 upstream_error로 본다. */
export function asEngineError(err: unknown): EngineError {
  if (err instanceof EngineError) return err;
  if (isAbortError(err)) return new EngineError('aborted', 499, false, 'client aborted', { cause: err });
  const message = err instanceof Error ? err.message : String(err);
  return new EngineError('upstream_error', 502, false, message, { cause: err });
}
