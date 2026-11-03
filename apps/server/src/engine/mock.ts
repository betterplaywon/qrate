import type { AnswerEngine, EngineEvent, EngineRequest } from './types.js';
import { EngineError } from './types.js';

// API 키 없이 파이프라인(SSE 전송·인용·위젯 표시·에러 경로)을 끝까지 돌리기 위한 목업.
// CI와 테스트는 항상 이 엔진으로 돈다. 실제 모델 응답과 "delta 조각의 연속 + 인용"이라는 형태는 같다.
const MOCK_ANSWER =
  '안녕하세요! 목업 응답입니다. 이 글자들이 한 글자씩 도착한다면 SSE 파이프라인은 정상이고, ANTHROPIC_API_KEY를 넣으면 실제 모델 답변으로 바뀝니다.';

// 테스트 훅 — 메시지에 아래 마커가 있으면 해당 실패 상황을 재현한다. 목업 전용이다.
const FAIL_BEFORE_FIRST = /\[\[fail:(\d{3})\]\]/; //  [[fail:429]] → 첫 이벤트 전에 그 상태로 실패
const FAIL_MID_STREAM = '[[fail-mid]]'; //          일부 전송 후 끊김
const REFUSE = '[[refuse]]'; //                    정책 거절(stop_reason: refusal)

export class MockEngine implements AnswerEngine {
  readonly name = 'mock';
  readonly model = 'mock';

  constructor(private readonly delayMs = 20) {}

  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    const fail = FAIL_BEFORE_FIRST.exec(req.message);
    if (fail?.[1]) throw failureFor(Number(fail[1]));

    const refuse = req.message.includes(REFUSE);
    const failMid = req.message.includes(FAIL_MID_STREAM);

    // 지식이 있으면 첫 항목의 첫 블록을 "근거"로 삼아 답하고 인용을 붙인다 — 인용 경로를 키 없이 검증한다.
    const source = req.knowledge[0];
    const cited = source?.blocks[0];
    const answer = refuse ? '' : source && cited ? `목업 응답입니다. 자료 "${source.title}"에 따르면: ${cited}` : MOCK_ANSWER;

    for (const [i, ch] of [...answer].entries()) {
      req.signal.throwIfAborted();
      if (failMid && i === 5) {
        throw new EngineError('upstream_unavailable', 503, true, 'mock: mid-stream failure');
      }
      yield { type: 'delta', text: ch };
      if (this.delayMs > 0) await sleep(this.delayMs, req.signal);
    }

    if (!refuse && source && cited) {
      yield {
        type: 'citation',
        citation: { sourceIndex: 0, sourceId: source.id, title: source.title, citedText: cited, blockStart: 0, blockEnd: 1 },
      };
    }

    yield {
      type: 'done',
      stopReason: refuse ? 'refusal' : 'end_turn',
      refusalCategory: refuse ? 'mock' : null,
      model: this.model,
      servedBy: this.model,
      fallbackUsed: false,
      usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
    };
  }
}

function failureFor(status: number): EngineError {
  switch (status) {
    case 401:
      return new EngineError('upstream_auth', 502, false, 'mock: upstream auth failure');
    case 429:
      return new EngineError('rate_limited', 503, true, 'mock: rate limited');
    case 503:
      return new EngineError('upstream_unavailable', 503, true, 'mock: upstream unavailable');
    default:
      return new EngineError('upstream_error', 502, false, `mock: upstream error ${status}`);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
