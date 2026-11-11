import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DEFAULT_SEED_PATH, loadSeedFile, type SeedFile } from '../src/repo/seed.js';
import { planAnswerTargets, runAnswersPhase } from './answers.js';
import { CallGate, foldCalls, type Caps } from './budget.js';
import { parseCaseFile, selectCases, type Case } from './cases.js';
import { answerConfig, engineFactory, judgeClientFor } from './clients.js';
import {
  JUDGE_SETTINGS,
  buildJudgeSystem,
  judgeVersion,
  pickJudgeCheckCases,
  runJudgeCheckPhase,
  runJudgePhase,
  type JudgeClient,
  type JudgePhaseDeps,
} from './judge.js';
import { buildLabelsInput, computeAgreement, labelsFileSchema, renderAgreement } from './labels.js';
import { PRICES, VARIANTS, VARIANT_MODELS, type Variant } from './models.js';
import { answerRecordSchema, callRecordSchema, errorRecordSchema, judgmentRecordSchema } from './records.js';
import { buildSummary, renderReport, type RunHeader } from './report.js';
import { RunDir } from './run-dir.js';

// 평가 명령. 무료: pnpm --filter @qrate/server eval <명령> …(목업 엔진·가짜 심판).
// 실제 모델 호출은 eval:paid(.env의 ANTHROPIC_API_KEY)로 사람이 상한을 정해 직접 돌린다 — README.md.

const CASES_PATH = fileURLToPath(new URL('./cases.json', import.meta.url));
const CONCURRENCY = 3;
const MAX_ATTEMPTS = 3;
const ANSWER_TIMEOUT_MS = 60_000;
// Opus는 사고를 끌 수 없어 답 단계보다 오래 걸린다. 묶음 하나(답 둘)의 채점이 1분을 넘을 수 있어 두 배로 둔다.
const JUDGE_TIMEOUT_MS = 120_000;

const COMMANDS = ['answers', 'judge', 'judge-check', 'report', 'labels', 'agreement'] as const;
type Command = (typeof COMMANDS)[number];

const argsSchema = z.object({
  command: z.enum(COMMANDS),
  run: z.string().min(1, '--run <폴더>가 필요하다'),
  variant: z.enum(['sonnet', 'haiku', 'all']).default('all'),
  reps: z.coerce.number().int().min(1).max(5).default(2),
  cases: z
    .string()
    .optional()
    .transform((s) => s?.split(',').map((x) => x.trim()).filter(Boolean)),
  limit: z.coerce.number().int().positive().optional(),
  engine: z.enum(['mock', 'claude']).default('mock'),
  judge: z.enum(['fake', 'claude']).default('fake'),
  maxCalls: z.coerce.number().int().positive().optional(),
  maxUsd: z.coerce.number().positive().optional(),
  labels: z.string().optional(),
});
type Args = z.infer<typeof argsSchema>;

const runHeaderSchema = z.object({
  createdAt: z.string(),
  gitSha: z.string().nullable(),
  cases: z.object({ sha256: z.string(), version: z.number(), status: z.string(), count: z.number() }),
}) satisfies z.ZodType<RunHeader>;

function parseCli(argv: string[]): Args {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      run: { type: 'string' },
      variant: { type: 'string' },
      reps: { type: 'string' },
      cases: { type: 'string' },
      limit: { type: 'string' },
      engine: { type: 'string' },
      judge: { type: 'string' },
      'max-calls': { type: 'string' },
      'max-usd': { type: 'string' },
      labels: { type: 'string' },
    },
  });
  return argsSchema.parse({ ...values, command: positionals[0], maxCalls: values['max-calls'], maxUsd: values['max-usd'] });
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function log(line: string): void {
  console.log(line);
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** 실제 호출을 하는 명령이면 상한과 키가 있어야 한다. 키 값은 어디에도 찍지 않는다. */
function realCallSetup(real: boolean, args: Args): { caps: Caps | null; apiKey: string | null } {
  if (!real) return { caps: null, apiKey: null };
  if (args.maxCalls === undefined || args.maxUsd === undefined) {
    throw new Error('실제 모델을 부르는 명령에는 --max-calls와 --max-usd가 둘 다 필요하다');
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY가 없다 — 실제 호출은 eval:paid 스크립트로 돌린다');
  return { caps: { maxCalls: args.maxCalls, maxUsd: args.maxUsd }, apiKey };
}

/** 실행 폴더가 처음 쓰일 때 run.json을 한 번 쓰고, 이미 있으면 시험지가 같은지 본다 — 다른 시험지의 답이 한 폴더에 섞이지 않게. */
function ensureRunInfo(run: RunDir, ctx: { args: Args; casesSha: string; caseCount: number; version: number; status: string; seed: SeedFile; caps: Caps | null }): void {
  const existing = run.readJson('info');
  if (existing !== null) {
    const header = runHeaderSchema.parse(existing);
    if (header.cases.sha256 !== ctx.casesSha) {
      throw new Error(`이 실행 폴더는 다른 시험지(sha256 ${header.cases.sha256.slice(0, 12)})로 만들었다. 지금 시험지는 ${ctx.casesSha.slice(0, 12)} — 새 --run 폴더를 쓴다`);
    }
    const head = git(['rev-parse', 'HEAD']);
    if (head && header.gitSha && head !== header.gitSha) log(`주의: 실행 폴더는 git ${header.gitSha.slice(0, 7)}에서 만들었고 지금은 ${head.slice(0, 7)}이다.`);
    return;
  }
  const config = answerConfig('sonnet', undefined);
  const status = git(['status', '--porcelain']);
  const info = {
    createdAt: new Date().toISOString(),
    gitSha: git(['rev-parse', 'HEAD']),
    gitDirty: status === null ? null : status !== '',
    cases: { path: 'apps/server/eval/cases.json', sha256: ctx.casesSha, version: ctx.version, status: ctx.status, count: ctx.caseCount },
    seedSha256: sha256(JSON.stringify(ctx.seed)),
    models: { ...VARIANT_MODELS, judge: JUDGE_SETTINGS.model },
    settings: {
      thinking: config.thinking,
      maxTokens: config.maxTokens,
      fallback: config.fallback,
      concurrency: CONCURRENCY,
      maxAttempts: MAX_ATTEMPTS,
      answerTimeoutMs: ANSWER_TIMEOUT_MS,
      judgeTimeoutMs: JUDGE_TIMEOUT_MS,
      judge: { effort: JUDGE_SETTINGS.effort, maxTokens: JUDGE_SETTINGS.maxTokens },
    },
    prices: PRICES,
    pricesSource: 'https://platform.claude.com/docs/en/about-claude/pricing (2026-11-11)',
    createdBy: { command: ctx.args.command, engine: ctx.args.engine, judge: ctx.args.judge, caps: ctx.caps },
  };
  run.writeOnce('info', `${JSON.stringify(info, null, 2)}\n`);
}

function openGate(run: RunDir, caps: Caps | null): CallGate {
  const calls = run.readJsonl('calls', callRecordSchema);
  if (calls.skipped > 0) log(`주의: calls.jsonl에서 읽지 못한 줄 ${calls.skipped}개를 건너뛰었다(쓰다가 멈춘 흔적).`);
  const totals = foldCalls(calls.rows);
  const gate = new CallGate(totals, caps, (row) => run.appendJsonl('calls', row));
  const capText = caps ? `상한 ${caps.maxCalls}건, $${caps.maxUsd}` : '상한 없음(무료 대역만)';
  log(`예산 장부(이 실행 폴더 누계): 실제 호출 ${totals.calls}건, 쓴 돈 ${usd(totals.spentUsd)}(측정 ${usd(totals.measuredUsd)}, 사용량 모르는 호출 ${totals.unmeasuredCalls}건). ${capText}.`);
  return gate;
}

function closeGate(gate: CallGate): void {
  const s = gate.snapshot();
  log(`예산 장부(끝): 실제 호출 ${s.calls}건, 쓴 돈 ${usd(s.spentUsd)}(측정 ${usd(s.measuredUsd)}).`);
  if (gate.stopReason) log(`새 호출을 멈춘 이유: ${gate.stopReason}`);
}

function runHeader(run: RunDir): RunHeader | null {
  const raw = run.readJson('info');
  return raw === null ? null : runHeaderSchema.parse(raw);
}

async function withLock<T>(run: RunDir, body: () => Promise<T>): Promise<T> {
  const release = run.lock();
  try {
    return await body();
  } finally {
    release();
  }
}

function retryDeps(): { maxAttempts: number; sleep: (ms: number) => Promise<void>; random: () => number; now: () => number; log: (line: string) => void } {
  return { maxAttempts: MAX_ATTEMPTS, sleep: (ms) => sleep(ms), random: Math.random, now: () => performance.now(), log };
}

interface Context {
  args: Args;
  run: RunDir;
  seed: SeedFile;
  caseFile: ReturnType<typeof parseCaseFile>;
  cases: Case[];
  variants: Variant[];
  casesSha: string;
}

async function commandAnswers(ctx: Context): Promise<number> {
  const { caps, apiKey } = realCallSetup(ctx.args.engine === 'claude', ctx.args);
  return withLock(ctx.run, async () => {
    ensureRunInfo(ctx.run, { args: ctx.args, casesSha: ctx.casesSha, caseCount: ctx.caseFile.cases.length, version: ctx.caseFile.version, status: ctx.caseFile.status, seed: ctx.seed, caps });
    const gate = openGate(ctx.run, caps);
    const targets = planAnswerTargets(ctx.cases, ctx.variants, ctx.args.reps);
    log(`답 단계: 엔진 ${ctx.args.engine}, 변형 ${ctx.variants.join('·')}, 사례 ${ctx.cases.length}개 × 회차 ${ctx.args.reps} = ${targets.length}개 키.`);
    const result = await runAnswersPhase(
      {
        ...retryDeps(),
        run: ctx.run,
        gate,
        seed: ctx.seed,
        tenantKey: ctx.caseFile.tenantKey,
        engineFor: engineFactory(ctx.args.engine, apiKey),
        billable: ctx.args.engine === 'claude',
        maxTokens: answerConfig('sonnet', undefined).maxTokens,
        concurrency: CONCURRENCY,
        timeoutMs: ANSWER_TIMEOUT_MS,
      },
      targets,
    );
    log(`답 단계 끝: 이미 있던 키 ${result.alreadyDone}, 새 답 ${result.answered}, 오류 ${result.failed}, 시작하지 않음 ${result.notStarted}.`);
    closeGate(gate);
    return result.failed > 0 || result.notStarted > 0 ? 1 : 0;
  });
}

function judgeDeps(ctx: Context, gate: CallGate, client: JudgeClient): JudgePhaseDeps {
  return { ...retryDeps(), run: ctx.run, gate, client, seed: ctx.seed, concurrency: CONCURRENCY, timeoutMs: JUDGE_TIMEOUT_MS };
}

async function commandJudge(ctx: Context): Promise<number> {
  const { caps, apiKey } = realCallSetup(ctx.args.judge === 'claude', ctx.args);
  return withLock(ctx.run, async () => {
    ensureRunInfo(ctx.run, { args: ctx.args, casesSha: ctx.casesSha, caseCount: ctx.caseFile.cases.length, version: ctx.caseFile.version, status: ctx.caseFile.status, seed: ctx.seed, caps });
    const gate = openGate(ctx.run, caps);
    const result = await runJudgePhase(judgeDeps(ctx, gate, judgeClientFor(ctx.args.judge, apiKey)), {
      cases: ctx.cases,
      variants: ctx.variants,
      reps: ctx.args.reps,
    });
    log(`판정 단계 끝: 묶음 ${result.groups}개 중 이미 판정 ${result.alreadyDone}, 새 판정 ${result.judged}, 오류 ${result.failed}, 시작하지 않음 ${result.notStarted}.`);
    if (result.incomplete.length > 0) log(`회차가 다 모이지 않아 미룬 묶음 ${result.incomplete.length}개: ${result.incomplete.join(', ')}`);
    closeGate(gate);
    return result.failed > 0 || result.notStarted > 0 ? 1 : 0;
  });
}

async function commandJudgeCheck(ctx: Context): Promise<number> {
  const { caps, apiKey } = realCallSetup(ctx.args.judge === 'claude', ctx.args);
  const picked = ctx.args.cases && ctx.args.cases.length > 0 ? ctx.cases : pickJudgeCheckCases(ctx.caseFile.cases);
  return withLock(ctx.run, async () => {
    ensureRunInfo(ctx.run, { args: ctx.args, casesSha: ctx.casesSha, caseCount: ctx.caseFile.cases.length, version: ctx.caseFile.version, status: ctx.caseFile.status, seed: ctx.seed, caps });
    const gate = openGate(ctx.run, caps);
    log(`심판 점검: 사례 ${picked.map((c) => c.id).join(', ')} — 사례마다 나쁜 답 3개를 한 번에 채점(호출 ${picked.length}건).`);
    const result = await runJudgeCheckPhase(judgeDeps(ctx, gate, judgeClientFor(ctx.args.judge, apiKey)), picked);
    for (const line of result.lines) log(`  ${line}`);
    log(result.passed ? '심판 점검 통과: 나쁜 답을 모두 실패로 봤다.' : '심판 점검 실패: 위에서 "통과시킴" 또는 "판정 없음"인 줄을 본다.');
    closeGate(gate);
    return result.passed ? 0 : 1;
  });
}

function commandReport(ctx: Context): number {
  const answers = ctx.run.readJsonl('answers', answerRecordSchema);
  const judgments = ctx.run.readJsonl('judgments', judgmentRecordSchema);
  const errors = ctx.run.readJsonl('errors', errorRecordSchema);
  const calls = ctx.run.readJsonl('calls', callRecordSchema);
  const skipped = answers.skipped + judgments.skipped + errors.skipped + calls.skipped;
  if (skipped > 0) log(`주의: 읽지 못한 줄 ${skipped}개를 건너뛰었다.`);
  const summary = buildSummary({
    cases: ctx.cases,
    variants: ctx.variants,
    reps: ctx.args.reps,
    answers: answers.rows,
    judgments: judgments.rows,
    judgeVersion: judgeVersion(buildJudgeSystem(ctx.seed)),
    errors: errors.rows,
    calls: calls.rows,
    run: runHeader(ctx.run),
    generatedAt: new Date().toISOString(),
  });
  ctx.run.writeAtomic('summary', `${JSON.stringify(summary, null, 2)}\n`);
  log(`보고서: ${ctx.run.writeAtomic('report', renderReport(summary))}`);
  return 0;
}

function commandLabels(ctx: Context): number {
  const variant: Variant = ctx.args.variant === 'all' ? 'sonnet' : ctx.args.variant;
  const input = buildLabelsInput({
    cases: ctx.cases,
    answers: ctx.run.readJsonl('answers', answerRecordSchema).rows,
    judgments: ctx.run.readJsonl('judgments', judgmentRecordSchema).rows,
    judgeVersion: judgeVersion(buildJudgeSystem(ctx.seed)),
    variant,
    rep: 1,
  });
  const path = ctx.run.writeAtomic('labelsInput', `${JSON.stringify(input, null, 2)}\n`);
  const judged = input.items.filter((i) => i.judge !== null).length;
  log(`라벨 입력: ${path} — ${variant} 1회차 답 ${input.items.length}개(판정 있음 ${judged}개).`);
  return 0;
}

function commandAgreement(ctx: Context): number {
  const labelsPath = ctx.args.labels ? resolve(ctx.args.labels) : ctx.run.file('labels');
  const labels = labelsFileSchema.parse(JSON.parse(readFileSync(labelsPath, 'utf8')));
  const agreement = computeAgreement(labels, ctx.run.readJsonl('judgments', judgmentRecordSchema).rows, judgeVersion(buildJudgeSystem(ctx.seed)));
  const text = renderAgreement(agreement);
  ctx.run.writeAtomic('agreement', text);
  log(text);
  return 0;
}

const HANDLERS: Readonly<Record<Command, (ctx: Context) => number | Promise<number>>> = {
  answers: commandAnswers,
  judge: commandJudge,
  'judge-check': commandJudgeCheck,
  report: commandReport,
  labels: commandLabels,
  agreement: commandAgreement,
};

async function main(argv: string[]): Promise<number> {
  const args = parseCli(argv);
  const seed = loadSeedFile(DEFAULT_SEED_PATH);
  const casesText = readFileSync(CASES_PATH, 'utf8');
  const caseFile = parseCaseFile(JSON.parse(casesText), new Set(seed.knowledge.map((k) => k.id)));
  const ctx: Context = {
    args,
    run: new RunDir(resolve(args.run)),
    seed,
    caseFile,
    cases: selectCases(caseFile.cases, { ids: args.cases, limit: args.limit }),
    variants: args.variant === 'all' ? [...VARIANTS] : [args.variant],
    casesSha: sha256(casesText),
  };
  return HANDLERS[args.command](ctx);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof z.ZodError ? z.prettifyError(err) : err instanceof Error ? err.message : err);
    process.exitCode = 2;
  },
);
