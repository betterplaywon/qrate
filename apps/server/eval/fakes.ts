import { setTimeout as sleep } from 'node:timers/promises';
import { MockEngine } from '../src/engine/mock.js';
import type { AnswerEngine, EngineEvent, EngineRequest, Usage } from '../src/engine/types.js';
import type { JudgeClient, JudgeReply, JudgeTask } from './judge.js';
import { gradeRules, rulesPass } from './rules.js';

// 돈이 들지 않는 대역: --engine mock, --judge fake. 파이프라인(기록·재개·장부·보고서)을 키 없이 끝까지 돌리는 데 쓴다.
// 사용량은 글자 수로 만든 합성값이다 — 보고서는 가격표에 없는 모델(mock, fake-judge)의 수치를 합성값으로 표시한다.

function tokensOf(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

function syntheticUsage(prefix: string, question: string, answer: string): Usage {
  return { inputTokens: tokensOf(question), cacheCreationInputTokens: 0, cacheReadInputTokens: tokensOf(prefix), outputTokens: tokensOf(answer) };
}

/**
 * 운영의 목업 엔진(답·인용·핸드오프 훅)에 첫 조각까지의 지연과 합성 사용량만 얹는다.
 * 목업은 첫 글자를 바로 내고 사용량을 0으로 내서, 그대로 두면 TTFT·토큰 집계 경로가 0으로 비어 보인다.
 */
export class SyntheticUsageEngine implements AnswerEngine {
  readonly name = 'mock';
  readonly model = 'mock';

  constructor(
    private readonly inner: AnswerEngine = new MockEngine(2),
    private readonly firstTokenMs = 40,
  ) {}

  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    await sleep(this.firstTokenMs, undefined, { signal: req.signal });
    let answer = '';
    for await (const ev of this.inner.stream(req)) {
      if (ev.type === 'delta') answer += ev.text;
      if (ev.type !== 'done') {
        yield ev;
        continue;
      }
      const history = req.history.map((t) => t.text).join('\n');
      yield { ...ev, usage: syntheticUsage(JSON.stringify(req.knowledge), `${history}\n${req.message}`, answer) };
    }
  }
}

/**
 * 가짜 심판: 기계 채점과 같은 결론을 낸다(규칙을 모두 통과하고 답이 비어 있지 않으면 알맞음, 지어냄은 늘 false).
 * 뜻을 읽지 못하므로 점수 자체에는 의미가 없다. 판정 단계의 묶음·섞기·기록·재개를 돈 없이 돌려 보는 용도다.
 */
export class FakeJudgeClient implements JudgeClient {
  readonly model = 'fake-judge';
  readonly billable = false;

  async grade(task: JudgeTask): Promise<JudgeReply> {
    const verdicts = task.answers.map(({ label, answer }) => {
      const appropriate = answer.text.trim() !== '' && rulesPass(gradeRules(task.case, answer));
      return {
        label,
        fabricatedDetail: '가짜 심판은 지어냄을 판정하지 않는다.',
        fabricated: false,
        appropriateDetail: appropriate ? '기계 채점을 모두 통과했다.' : '기계 채점에서 실패한 규칙이 있다.',
        appropriate,
      };
    });
    const text = JSON.stringify({ verdicts });
    return { stopReason: 'end_turn', text, servedBy: this.model, usage: syntheticUsage(task.system, task.user, text) };
  }
}
