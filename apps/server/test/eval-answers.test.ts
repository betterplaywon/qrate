import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { planAnswerTargets, runAnswersPhase, type AnswerPhaseDeps } from '../eval/answers.js';
import { CallGate, foldCalls, type Caps } from '../eval/budget.js';
import type { Case } from '../eval/cases.js';
import { answerRecordSchema, callRecordSchema, errorRecordSchema } from '../eval/records.js';
import type { RunDir } from '../eval/run-dir.js';
import { MockEngine } from '../src/engine/mock.js';
import { EngineError, type AnswerEngine, type EngineEvent, type EngineRequest } from '../src/engine/types.js';
import { DEFAULT_SEED_PATH, loadSeedFile } from '../src/repo/seed.js';
import { CapturingEngine } from './helpers/capturing-engine.js';
import { makeCase, tempRun } from './helpers/eval-fixtures.js';

// 답 단계: 운영 대화 유스케이스를 그대로 지나 기록되는가, 다시 돌리면 이어 가는가, 예산 상한에서 멈추는가.

const seed = loadSeedFile(DEFAULT_SEED_PATH);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function newRun(): RunDir {
  const { run, cleanup } = tempRun();
  cleanups.push(cleanup);
  return run;
}

function gateFor(run: RunDir, caps: Caps | null = null): CallGate {
  return new CallGate(foldCalls(run.readJsonl('calls', callRecordSchema).rows), caps, (row) => run.appendJsonl('calls', row));
}

function deps(run: RunDir, engine: AnswerEngine, over: Partial<AnswerPhaseDeps> = {}): AnswerPhaseDeps {
  return {
    run,
    gate: gateFor(run),
    seed,
    tenantKey: seed.tenant.apiKey,
    engineFor: () => engine,
    billable: false,
    maxTokens: 1024,
    concurrency: 3,
    timeoutMs: 5_000,
    maxAttempts: 3,
    sleep: async () => {},
    random: () => 0.5,
    now: () => performance.now(),
    log: () => {},
    ...over,
  };
}

const rows = (run: RunDir) => ({
  answers: run.readJsonl('answers', answerRecordSchema).rows,
  errors: run.readJsonl('errors', errorRecordSchema).rows,
  calls: run.readJsonl('calls', callRecordSchema).rows,
});

/** 실제 모델처럼 가격표의 모델 이름과 사용량을 내는 엔진. 응답 끝(done)을 고쳐 폴백·다른 모델 상황을 만든다. */
class PricedEngine implements AnswerEngine {
  readonly name = 'priced';
  readonly requests: EngineRequest[] = [];

  constructor(
    readonly model: string,
    private readonly patch: (done: Extract<EngineEvent, { type: 'done' }>) => Extract<EngineEvent, { type: 'done' }> = (d) => d,
    private readonly inner: AnswerEngine = new MockEngine(0),
  ) {}

  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    this.requests.push(req);
    for await (const ev of this.inner.stream(req)) {
      if (ev.type !== 'done') {
        yield ev;
        continue;
      }
      const usage = { inputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 5000, outputTokens: 200 };
      yield this.patch({ ...ev, model: this.model, servedBy: this.model, usage });
    }
  }
}

/** 처음 failures번은 재시도 가능한 오류로 첫 조각 전에 실패한다(요율 제한처럼). */
class FlakyEngine implements AnswerEngine {
  readonly name = 'flaky';
  readonly model = 'mock';
  calls = 0;

  constructor(
    private readonly failures: number,
    private readonly error = () => new EngineError('rate_limited', true, 'test: rate limited'),
  ) {}

  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    this.calls += 1;
    if (this.calls <= this.failures) throw this.error();
    yield* new MockEngine(0).stream(req);
  }
}

const plain = makeCase('a01', { message: '요금제 알려 주세요' });

describe('답 단계 — runAnswersPhase', () => {
  it('시험지의 앞 대화가 운영 유스케이스를 지나 엔진의 history로 들어간다', async () => {
    const run = newRun();
    const engine = new CapturingEngine(new MockEngine(0));
    const withHistory = makeCase('m01', {
      message: '연간으로 내면요?',
      history: [
        { role: 'user', text: '팀 요금제는 얼마예요?' },
        { role: 'assistant', text: '팀 플랜은 월 29,000원입니다.' },
      ],
    });
    await runAnswersPhase(deps(run, engine), planAnswerTargets([withHistory], ['sonnet'], 1));
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]?.message).toBe('연간으로 내면요?');
    expect(engine.requests[0]?.history).toEqual([
      { role: 'user', text: '팀 요금제는 얼마예요?' },
      { role: 'assistant', text: '팀 플랜은 월 29,000원입니다.' },
    ]);
  });

  it('인용과 핸드오프 신호, 종료 사유, TTFT가 답 기록에 남는다', async () => {
    const run = newRun();
    const engine = new CapturingEngine(new MockEngine(0));
    const handoff = makeCase('h01', { message: '환불해 주세요 [[handoff:needs_human]]' });
    const result = await runAnswersPhase(deps(run, engine), planAnswerTargets([plain, handoff], ['sonnet'], 1));
    expect(result).toMatchObject({ answered: 2, failed: 0, notStarted: 0 });

    const { answers } = rows(run);
    const cited = answers.find((a) => a.caseId === 'a01');
    const firstKnowledge = engine.requests.find((r) => r.message === plain.message)?.knowledge[0];
    expect(cited?.citations.map((c) => c.sourceId)).toEqual([firstKnowledge?.id]);
    expect(cited).toMatchObject({ status: 'ok', handoff: null, stopReason: 'end_turn', attempts: 1, key: 'sonnet/a01/r1' });
    expect(cited?.ttftMs).not.toBeNull();

    const handed = answers.find((a) => a.caseId === 'h01');
    expect(handed?.handoff).toEqual({ reason: 'needs_human', summary: '목업: 자료에 없는 질문' });
    expect(handed?.citations).toEqual([]);
    expect(handed?.text).not.toBe('');
  });

  it('다시 돌리면 이미 있는 키는 건너뛰고 기록을 겹쳐 쓰지 않는다', async () => {
    const run = newRun();
    const engine = new CapturingEngine(new MockEngine(0));
    const targets = planAnswerTargets([plain, makeCase('a02')], ['sonnet', 'haiku'], 2);
    expect(targets).toHaveLength(8);
    await runAnswersPhase(deps(run, engine), targets);
    const again = await runAnswersPhase(deps(run, engine), targets);
    expect(again).toMatchObject({ alreadyDone: 8, answered: 0 });
    expect(engine.requests).toHaveLength(8);
    expect(new Set(rows(run).answers.map((a) => a.key)).size).toBe(8);
    expect(rows(run).answers).toHaveLength(8);
  });

  it('재시도 가능한 오류는 다시 시도하고, 시도 수와 호출 장부에 남는다', async () => {
    const run = newRun();
    const engine = new FlakyEngine(1);
    await runAnswersPhase(deps(run, engine, { concurrency: 1 }), planAnswerTargets([plain], ['sonnet'], 1));
    const { answers, calls } = rows(run);
    expect(answers[0]?.attempts).toBe(2);
    expect(calls.filter((c) => c.type === 'start')).toHaveLength(2);
    // 첫 조각 전의 요율 제한은 과금되지 않은 호출로 남는다.
    expect(calls.filter((c) => c.type === 'end').map((c) => c.type === 'end' && c.outcome.billing)).toEqual(['none', 'measured']);
  });

  it('재시도해도 안 되면 답이 아니라 오류로 남고, 다음 실행에서 다시 시도한다', async () => {
    const run = newRun();
    const always = new FlakyEngine(99);
    const first = await runAnswersPhase(deps(run, always), planAnswerTargets([plain], ['sonnet'], 1));
    expect(first).toMatchObject({ answered: 0, failed: 1 });
    expect(rows(run).answers).toEqual([]);
    expect(rows(run).errors).toMatchObject([{ phase: 'answers', key: 'sonnet/a01/r1', class: 'serving', attempts: 3 }]);

    const healthy = new FlakyEngine(0);
    const second = await runAnswersPhase(deps(run, healthy), planAnswerTargets([plain], ['sonnet'], 1));
    expect(second).toMatchObject({ answered: 1 });
    expect(healthy.calls).toBe(1);
  });

  it('재시도할 수 없는 오류는 한 번으로 끝낸다', async () => {
    const run = newRun();
    const engine = new FlakyEngine(99, () => new EngineError('upstream_bad_request', false, 'test: bad request'));
    await runAnswersPhase(deps(run, engine), planAnswerTargets([plain], ['sonnet'], 1));
    expect(engine.calls).toBe(1);
    expect(rows(run).errors[0]).toMatchObject({ class: 'serving', attempts: 1 });
  });

  it('요청과 다른 모델이 답했거나 폴백이 작동한 답은 점수에 넣지 않고 오류로 남기며, 다시 뽑지 않는다', async () => {
    const run = newRun();
    const other = new PricedEngine('claude-haiku-5-5', (d) => ({ ...d, servedBy: 'claude-opus-5-5' }));
    const fallback = new PricedEngine('claude-haiku-5-5', (d) => ({ ...d, fallbackUsed: true }));
    await runAnswersPhase(deps(run, other), planAnswerTargets([plain], ['haiku'], 1));
    await runAnswersPhase(deps(run, fallback), planAnswerTargets([makeCase('a02')], ['haiku'], 1));
    const { answers, errors } = rows(run);
    expect(answers).toEqual([]);
    expect(errors.map((e) => e.class)).toEqual(['served-model-mismatch', 'served-model-mismatch']);
    expect(errors[0]?.usage?.cacheReadInputTokens).toBe(5000);

    const again = await runAnswersPhase(deps(run, other), planAnswerTargets([plain, makeCase('a02')], ['haiku'], 1));
    expect(again.alreadyDone).toBe(2);
    expect(other.requests).toHaveLength(1);
  });

  it('날짜가 붙은 스냅숏 id로 답해도 같은 모델로 본다', async () => {
    const run = newRun();
    const dated = new PricedEngine('claude-haiku-5-5', (d) => ({ ...d, servedBy: 'claude-haiku-5-5-20261001' }));
    await runAnswersPhase(deps(run, dated), planAnswerTargets([plain], ['haiku'], 1));
    expect(rows(run).answers).toHaveLength(1);
  });

  it('같은 변형의 답을 다른 모델로 이어 쓰지 않는다(목업 답과 실제 답이 섞이지 않게)', async () => {
    const run = newRun();
    await runAnswersPhase(deps(run, new MockEngine(0)), planAnswerTargets([plain], ['haiku'], 1));
    const real = new PricedEngine('claude-haiku-5-5');
    await expect(runAnswersPhase(deps(run, real), planAnswerTargets([plain, makeCase('a02')], ['haiku'], 1))).rejects.toThrow(/새 --run/);
    expect(real.requests).toEqual([]);
  });

  it('시간 안에 끝나지 않은 호출은 timeout 오류이고, 장부는 그 호출을 상한 금액으로 센다', async () => {
    const run = newRun();
    const stuck: AnswerEngine = {
      name: 'stuck',
      model: 'claude-haiku-5-5',
      async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
        await new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason)));
        yield* [];
      },
    };
    const caps = { maxCalls: 10, maxUsd: 1 };
    await runAnswersPhase(deps(run, stuck, { billable: true, gate: gateFor(run, caps), timeoutMs: 30 }), planAnswerTargets([plain], ['haiku'], 1));
    const { errors, calls } = rows(run);
    expect(errors[0]).toMatchObject({ class: 'timeout', attempts: 1 });
    const totals = foldCalls(calls);
    const start = calls.find((c) => c.type === 'start');
    expect(totals).toMatchObject({ calls: 1, unmeasuredCalls: 1, measuredUsd: 0 });
    expect(totals.spentUsd).toBe(start?.type === 'start' ? start.ceilingUsd : NaN);
    expect(totals.spentUsd).toBeGreaterThan(0);
  });
});

describe('예산 관문 — 호출 상한에서 새 호출을 시작하지 않는다', () => {
  const cases: Case[] = Array.from({ length: 6 }, (_, i) => makeCase(`b0${i}`));

  it('호출 상한에 닿으면 멈추고, 시작한 호출 수가 상한을 넘지 않는다', async () => {
    const run = newRun();
    const engine = new PricedEngine('claude-haiku-5-5');
    const result = await runAnswersPhase(
      deps(run, engine, { billable: true, gate: gateFor(run, { maxCalls: 3, maxUsd: 100 }) }),
      planAnswerTargets(cases, ['haiku'], 1),
    );
    expect(engine.requests).toHaveLength(3);
    expect(result).toMatchObject({ answered: 3, notStarted: 3 });
    expect(result.stopReason).toMatch(/호출 상한/);
  });

  it('장부는 실행 폴더에 남아 다음 실행도 같은 상한 안에서 센다', async () => {
    const run = newRun();
    const engine = new PricedEngine('claude-haiku-5-5');
    const caps = { maxCalls: 3, maxUsd: 100 };
    await runAnswersPhase(deps(run, engine, { billable: true, gate: gateFor(run, caps) }), planAnswerTargets(cases, ['haiku'], 1));
    const second = await runAnswersPhase(deps(run, engine, { billable: true, gate: gateFor(run, caps) }), planAnswerTargets(cases, ['haiku'], 1));
    expect(engine.requests).toHaveLength(3);
    expect(second).toMatchObject({ answered: 0, notStarted: 3 });
  });

  it('비용 상한은 진행 중인 호출들의 상한까지 더해 본다 — 첫 호출의 상한이 예산을 넘으면 시작하지 않는다', async () => {
    const run = newRun();
    const engine = new PricedEngine('claude-sonnet-5-5');
    const result = await runAnswersPhase(
      deps(run, engine, { billable: true, gate: gateFor(run, { maxCalls: 100, maxUsd: 0.001 }) }),
      planAnswerTargets(cases, ['sonnet'], 1),
    );
    expect(engine.requests).toEqual([]);
    expect(result.notStarted).toBe(6);
    expect(result.stopReason).toMatch(/비용 상한/);
  });

  it('측정한 사용량으로 비용을 센다(가격표의 단가)', async () => {
    const run = newRun();
    const engine = new PricedEngine('claude-sonnet-5-5');
    await runAnswersPhase(deps(run, engine, { billable: true, gate: gateFor(run, { maxCalls: 10, maxUsd: 10 }) }), planAnswerTargets([plain], ['sonnet'], 1));
    // 입력 100×$2 + 캐시 읽기 5000×$0.10 + 출력 200×$10, 백만 토큰당.
    expect(foldCalls(rows(run).calls).measuredUsd).toBeCloseTo((100 * 2 + 5000 * 0.1 + 200 * 10) / 1_000_000, 10);
  });
});
