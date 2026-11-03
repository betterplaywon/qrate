import type { AnswerEngine, EngineEvent, EngineRequest } from '../../src/engine/types.js';

/** 엔진에 들어간 요청을 기록해 history·knowledge가 제대로 조립되는지 확인하는 테스트용 래퍼. */
export class CapturingEngine implements AnswerEngine {
  readonly name: string;
  readonly model: string;
  readonly requests: EngineRequest[] = [];

  constructor(private readonly inner: AnswerEngine) {
    this.name = inner.name;
    this.model = inner.model;
  }

  stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    this.requests.push(req);
    return this.inner.stream(req);
  }
}
