import { randomUUID } from 'node:crypto';
import { createChatService } from '../src/chat/service.js';
import { HANDOFF_TOOL } from '../src/engine/handoff.js';
import { buildSystemPrompt } from '../src/engine/prompt.js';
import type { AnswerEngine, EngineEvent, StopReason } from '../src/engine/types.js';
import { createRepositoriesFromSeed, type SeedFile } from '../src/repo/seed.js';
import type { Repositories } from '../src/repo/types.js';
import type { CallGate } from './budget.js';
import type { Case } from './cases.js';
import { callCeilingUsd, inputTokenBound, servedByMatches, type Variant } from './models.js';
import {
  RETRY_ON_RERUN,
  ZERO_USAGE,
  answerKey,
  answerRecordSchema,
  errorRecordSchema,
  type AnswerKey,
  type AnswerRecord,
  type ErrorRecord,
} from './records.js';
import type { AnswerStatus } from './rules.js';
import type { RunDir } from './run-dir.js';
import { classifyThrown, retrying, runPool, type Attempt, type Failure, type RetryPolicy } from './schedule.js';

// 답 단계: 시험지의 질문을 운영과 같은 대화 유스케이스(createChatService)에 넣고 답을 기록한다.
// HTTP를 거치지 않으므로 TTFT·인용 수·핸드오프는 http/chat.ts와 같은 규칙으로 여기서 잰다.

export interface AnswerPhaseDeps extends RetryPolicy {
  run: RunDir;
  gate: CallGate;
  seed: SeedFile;
  tenantKey: string;
  engineFor: (variant: Variant) => AnswerEngine;
  /** 실제 API 호출인가(목업 엔진이면 false). */
  billable: boolean;
  /** 엔진 설정의 max_tokens — 호출 1건의 비용 상한에 쓴다. */
  maxTokens: number;
  concurrency: number;
  timeoutMs: number;
  /** 단조 증가 시계(ms). */
  now: () => number;
  log: (line: string) => void;
}

export interface AnswerTarget {
  key: AnswerKey;
  variant: Variant;
  rep: number;
  case: Case;
}

export interface AnswerPhaseResult {
  targets: number;
  alreadyDone: number;
  answered: number;
  failed: number;
  notStarted: number;
  stopReason: string | null;
}

type AnswerBody = Omit<AnswerRecord, 'attempts' | 'at'>;

function statusFor(stopReason: StopReason): AnswerStatus | null {
  switch (stopReason) {
    case 'end_turn':
      return 'ok';
    case 'max_tokens':
      return 'truncated';
    case 'refusal':
      return 'refusal';
    case 'other':
      return null;
  }
}

/** 시험지의 고정된 앞 대화를 저장소에 미리 넣는다(차감·핸드오프 없음). 유스케이스는 이 대화 id로 이어 가며 history를 만든다. */
async function seedHistory(repos: Repositories, tenantId: string, c: Case): Promise<string | null> {
  if (c.history.length === 0) return null;
  const conversationId = randomUUID();
  for (let i = 0; i < c.history.length; i += 2) {
    const [question, answer] = [c.history[i], c.history[i + 1]];
    if (!question || !answer) break;
    await repos.conversations.appendTurn(conversationId, tenantId, {
      question: { role: 'user', content: question.text },
      answer: { role: 'assistant', content: answer.text },
      handoff: null,
      charge: null,
    });
  }
  return conversationId;
}

export function planAnswerTargets(cases: readonly Case[], variants: readonly Variant[], reps: number): AnswerTarget[] {
  return variants.flatMap((variant) =>
    Array.from({ length: reps }, (_, i) => i + 1).flatMap((rep) =>
      cases.map((c) => ({ key: answerKey(variant, c.id, rep), variant, rep, case: c })),
    ),
  );
}

/** 이 실행 폴더에서 이미 끝난 키: 답이 있거나, 다시 뽑지 않는 오류(폴백·거절)로 끝난 키. */
export function finishedAnswerKeys(answers: readonly AnswerRecord[], errors: readonly ErrorRecord[]): Set<string> {
  const done = new Set<string>(answers.map((a) => a.key));
  for (const e of errors) if (e.phase === 'answers' && !RETRY_ON_RERUN[e.class]) done.add(e.key);
  return done;
}

async function attemptAnswer(deps: AnswerPhaseDeps, target: AnswerTarget, attempt: number, calls: { n: number }): Promise<Attempt<AnswerBody>> {
  const engine = deps.engineFor(target.variant);
  const c = target.case;
  const repos = createRepositoriesFromSeed(deps.seed);
  const conversationId = await seedHistory(repos, deps.seed.tenant.id, c);
  const chat = createChatService({ engine, repos });
  const base = { key: target.key, variant: target.variant, caseId: c.id, rep: target.rep, model: engine.model };

  const signal = AbortSignal.timeout(deps.timeoutMs);
  const t0 = deps.now();
  const turn = await chat.start({ tenantKey: deps.tenantKey, message: c.message, conversationId, signal });
  if (turn.status === 'blocked') {
    const body: AnswerBody = {
      ...base,
      status: 'blocked',
      text: '',
      citations: [],
      handoff: null,
      stopReason: null,
      servedBy: null,
      fallbackUsed: false,
      usage: ZERO_USAGE,
      ttftMs: null,
      durationMs: Math.round(deps.now() - t0),
    };
    return { kind: 'value', value: body };
  }
  if (turn.status !== 'accepted') {
    return { kind: 'failure', failure: { class: 'harness', message: `대화 유스케이스가 ${turn.status}를 돌려줬다`, usage: null, retryable: false } };
  }

  const ceilingUsd = callCeilingUsd(
    engine.model,
    {
      inputTokens: inputTokenBound(
        buildSystemPrompt(deps.seed.tenant.name),
        JSON.stringify(HANDOFF_TOOL),
        JSON.stringify(deps.seed.knowledge),
        JSON.stringify(c.history),
        c.message,
      ),
      maxTokens: deps.maxTokens,
    },
    deps.billable,
  );
  const decision = deps.gate.begin({ phase: 'answers', key: target.key, attempt, model: engine.model, billable: deps.billable, ceilingUsd });
  if (!decision.ok) return { kind: 'refused', reason: decision.reason };
  calls.n += 1;

  let text = '';
  let ttftMs: number | null = null;
  let sawOutput = false;
  let done: Extract<EngineEvent, { type: 'done' }> | null = null;
  const citations: AnswerRecord['citations'] = [];
  let handoff: AnswerRecord['handoff'] = null;
  try {
    for await (const ev of turn.events) {
      sawOutput = true;
      if (ev.type === 'delta') {
        text += ev.text;
        // 공백뿐인 조각은 첫 응답이 아니다 — http/chat.ts와 같은 규칙.
        if (ttftMs === null && ev.text.trim() !== '') ttftMs = Math.round(deps.now() - t0);
      } else if (ev.type === 'citation') {
        citations.push({ sourceId: ev.citation.sourceId, citedText: ev.citation.citedText });
      } else if (ev.type === 'handoff') {
        handoff = { reason: ev.reason, summary: ev.summary };
      } else {
        done = ev;
      }
    }
  } catch (err) {
    const { failure, billing } = classifyThrown(err, { timedOut: signal.aborted, sawOutput, timeoutMs: deps.timeoutMs });
    deps.gate.end(decision.ticket, { billing });
    return { kind: 'failure', failure };
  }
  const durationMs = Math.round(deps.now() - t0);

  if (!done) {
    deps.gate.end(decision.ticket, { billing: 'unknown' });
    return { kind: 'failure', failure: { class: 'harness', message: 'done 이벤트 없이 스트림이 끝났다', usage: null, retryable: false } };
  }
  deps.gate.end(decision.ticket, { billing: 'measured', usage: done.usage, servedBy: done.servedBy });
  if (done.fallbackUsed || !servedByMatches(engine.model, done.servedBy)) {
    const message = `요청 ${engine.model}, 응답 ${done.servedBy}${done.fallbackUsed ? '(서버 측 폴백)' : ''}`;
    return { kind: 'failure', failure: { class: 'served-model-mismatch', message, usage: done.usage, retryable: false } };
  }
  const status = statusFor(done.stopReason);
  if (!status) {
    return { kind: 'failure', failure: { class: 'serving', message: `예상 밖의 stop_reason(${done.stopReason})`, usage: done.usage, retryable: false } };
  }
  return {
    kind: 'value',
    value: {
      ...base,
      status,
      text: text.trim(),
      citations,
      handoff,
      stopReason: done.stopReason,
      servedBy: done.servedBy,
      fallbackUsed: done.fallbackUsed,
      usage: done.usage,
      ttftMs,
      durationMs,
    },
  };
}

function writeError(deps: AnswerPhaseDeps, key: string, failure: Failure, attempts: number, note = ''): void {
  const row: ErrorRecord = {
    phase: 'answers',
    key,
    class: failure.class,
    message: `${failure.message}${note}`,
    attempts,
    usage: failure.usage,
    at: new Date().toISOString(),
  };
  deps.run.appendJsonl('errors', row);
}

async function answerTarget(deps: AnswerPhaseDeps, target: AnswerTarget, tally: AnswerPhaseResult): Promise<'continue' | 'stop'> {
  const calls = { n: 0 };
  let settled: { result: Attempt<AnswerBody>; lastFailure: Failure | null };
  try {
    settled = await retrying(deps, (attempt) => attemptAnswer(deps, target, attempt, calls));
  } catch (err) {
    // 엔진 밖(저장소·유스케이스·이 파일)의 예외. 버그이거나 설정 문제라 다시 시도하지 않는다.
    writeError(deps, target.key, { class: 'harness', message: err instanceof Error ? err.message : String(err), usage: null, retryable: false }, calls.n);
    tally.failed += 1;
    deps.log(`${target.key} 오류(harness)`);
    return 'continue';
  }
  const { result, lastFailure } = settled;
  if (result.kind === 'value') {
    const row: AnswerRecord = { ...result.value, attempts: calls.n, at: new Date().toISOString() };
    deps.run.appendJsonl('answers', row);
    tally.answered += 1;
    const ttft = row.ttftMs === null ? '-' : `${Math.round(row.ttftMs)}ms`;
    deps.log(`${target.key} ${row.status}${row.handoff ? ' 넘김' : ''} ttft ${ttft} 시도 ${row.attempts}`);
    return 'continue';
  }
  if (result.kind === 'failure') {
    writeError(deps, target.key, result.failure, calls.n);
    tally.failed += 1;
    deps.log(`${target.key} 오류(${result.failure.class}) ${result.failure.message}`);
    return 'continue';
  }
  if (lastFailure) {
    writeError(deps, target.key, lastFailure, calls.n, ' — 예산 상한으로 재시도하지 않음');
    tally.failed += 1;
  } else {
    tally.notStarted += 1;
  }
  return 'stop';
}

export async function runAnswersPhase(deps: AnswerPhaseDeps, targets: readonly AnswerTarget[]): Promise<AnswerPhaseResult> {
  const answers = deps.run.readJsonl('answers', answerRecordSchema).rows;
  const errors = deps.run.readJsonl('errors', errorRecordSchema).rows;
  // 같은 변형의 답은 같은 모델에서 나와야 한다. 목업 답과 실제 답이 한 폴더에 섞이면 보고서가 둘을 한 모델로 센다.
  for (const a of answers) {
    const model = deps.engineFor(a.variant).model;
    if (a.model !== model) throw new Error(`이 실행 폴더의 ${a.variant} 답은 ${a.model}로 만들었다. ${model}로 이어 쓰지 않는다 — 새 --run 폴더를 쓴다`);
  }
  const done = finishedAnswerKeys(answers, errors);
  const pending = targets.filter((t) => !done.has(t.key));
  const tally: AnswerPhaseResult = {
    targets: targets.length,
    alreadyDone: targets.length - pending.length,
    answered: 0,
    failed: 0,
    notStarted: 0,
    stopReason: null,
  };
  const { started } = await runPool(pending, deps.concurrency, (target) => answerTarget(deps, target, tally), { warmFirst: true });
  tally.notStarted += pending.length - started;
  tally.stopReason = deps.gate.stopReason;
  return tally;
}
