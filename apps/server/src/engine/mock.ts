import { setTimeout as sleep } from 'node:timers/promises';
import { HANDOFF_REASONS, isOneOf } from '@qrate/contracts';
import type { AnswerEngine, EngineEvent, EngineRequest } from './types.js';
import { EngineError } from './types.js';

// API 키 없이 파이프라인(SSE 전송·인용·위젯 표시·에러 경로)을 끝까지 돌리기 위한 목업.
// CI와 테스트는 항상 이 엔진으로 돈다. 실제 모델 응답과 "delta 조각의 연속 + 인용"이라는 형태는 같다.
const MOCK_ANSWER =
  '안녕하세요! 목업 응답입니다. 이 글자들이 한 글자씩 도착한다면 SSE 파이프라인은 정상이고, ANTHROPIC_API_KEY를 넣으면 실제 모델 답변으로 바뀝니다.';
/** 핸드오프 훅의 답. 실제 모델이 신호용 도구를 부르기 전에 쓰는 안내 문장과 같은 역할이다. */
const MOCK_HANDOFF_ANSWER = '목업 응답입니다. 그 내용은 안내 자료에 없어요. 상담원에게 문의해 주세요.';

// 테스트 훅 — 메시지에 아래 마커가 있으면 해당 상황을 재현한다. 목업 전용이다.
const FAIL_BEFORE_FIRST = /\[\[fail:(\d{3})\]\]/; //  [[fail:429]] → 첫 이벤트 전에 그 상태로 실패
const FAIL_MID_STREAM = '[[fail-mid]]'; //          일부 전송 후 끊김
const REFUSE = '[[refuse]]'; //                    정책 거절(stop_reason: refusal)
const HANDOFF = /\[\[handoff(?::([a-z_]+))?\]\]/; // [[handoff]] 또는 [[handoff:needs_human]] → 안내 문장 뒤 핸드오프 신호, 인용 없음

/** 훅의 숫자는 상류 상태 코드를 흉내 낸 별칭일 뿐이다. 위젯이 받는 HTTP 상태는 코드에서 http/chat.ts가 정한다. */
function failureFor(status: number): EngineError {
  switch (status) {
    case 401:
      return new EngineError('upstream_auth', false, 'mock: upstream auth failure');
    case 429:
      return new EngineError('rate_limited', true, 'mock: rate limited');
    case 503:
      return new EngineError('upstream_unavailable', true, 'mock: upstream unavailable');
    default:
      return new EngineError('upstream_error', false, `mock: upstream error ${status}`);
  }
}

export class MockEngine implements AnswerEngine {
  readonly name = 'mock';
  readonly model = 'mock';

  constructor(private readonly delayMs = 20) {}

  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    const fail = FAIL_BEFORE_FIRST.exec(req.message);
    if (fail?.[1]) throw failureFor(Number(fail[1]));

    const refuse = req.message.includes(REFUSE);
    const failMid = req.message.includes(FAIL_MID_STREAM);
    const handoff = HANDOFF.exec(req.message);

    // 지식이 있으면 첫 항목의 첫 블록을 "근거"로 삼아 답하고 인용을 붙인다 — 인용 경로를 키 없이 검증한다.
    // 핸드오프 훅이면 자료 없이 안내 문장만 답하고 인용을 붙이지 않는다 — 실제 모델의 "자료에 없는 질문" 턴과 같은 모양.
    const source = handoff ? undefined : req.knowledge[0];
    const cited = source?.blocks[0];
    const answer = refuse
      ? ''
      : handoff
        ? MOCK_HANDOFF_ANSWER
        : source && cited
          ? `목업 응답입니다. 자료 "${source.title}"에 따르면: ${cited}`
          : MOCK_ANSWER;

    for (const [i, ch] of [...answer].entries()) {
      req.signal.throwIfAborted();
      if (failMid && i === 5) {
        throw new EngineError('upstream_unavailable', true, 'mock: mid-stream failure');
      }
      yield { type: 'delta', text: ch };
      // 끊기면(abort) 기다리지 않고 거절된다 — 타이머와 신호를 손수 엮지 않고 Node 내장 timers/promises를 쓴다.
      if (this.delayMs > 0) await sleep(this.delayMs, undefined, { signal: req.signal });
    }

    if (!refuse && source && cited) {
      yield {
        type: 'citation',
        citation: { sourceIndex: 0, sourceId: source.id, title: source.title, citedText: cited, blockStart: 0, blockEnd: 1 },
      };
    }

    if (handoff && !refuse) {
      const reason = isOneOf(HANDOFF_REASONS, handoff[1]) ? handoff[1] : 'not_in_knowledge';
      yield { type: 'handoff', reason, summary: '목업: 자료에 없는 질문' };
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

