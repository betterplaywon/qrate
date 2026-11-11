import type { Usage } from '../src/engine/types.js';
import { nearestRank } from '../src/events/metrics.js';
import { measuredCostUsd } from './budget.js';
import type { Case } from './cases.js';
import { currentJudgments, verdictsByAnswer } from './judge.js';
import { priceOf, type Variant } from './models.js';
import {
  ZERO_USAGE,
  answerKey,
  type AnswerKey,
  type AnswerRecord,
  type Billing,
  type CallRecord,
  type CallStart,
  type ErrorRecord,
  type JudgeVerdict,
  type JudgmentRecord,
} from './records.js';
import { RULE_NAMES, failedRules, gradeRules, type RuleName } from './rules.js';

// 보고서: 실행 폴더의 기록만으로 계산하는 순수 함수(buildSummary)와 그 결과를 한국어 마크다운으로 옮기는 함수(renderReport).
// 오류로 끝난 답은 0점이 아니라 "없음"이다 — 분모에서 빠지고, 미완료와 오류 목록으로 따로 보인다.

export interface RunHeader {
  createdAt: string;
  gitSha: string | null;
  cases: { sha256: string; version: number; status: string; count: number };
}

export interface ReportInput {
  cases: readonly Case[];
  variants: readonly Variant[];
  reps: number;
  answers: readonly AnswerRecord[];
  judgments: readonly JudgmentRecord[];
  judgeVersion: string;
  errors: readonly ErrorRecord[];
  calls: readonly CallRecord[];
  run: RunHeader | null;
  generatedAt: string;
}

/** count/n. n이 0이면 비율이 없다. */
export interface Tally {
  count: number;
  n: number;
}

export interface Spread {
  n: number;
  p50: number | null;
  p95: number | null;
}

export interface UsageTotals {
  calls: number;
  measuredCalls: number;
  /** 사용량을 모르는 실제 호출(시간 초과·도중 실패). 비용에 들어 있지 않다. */
  unmeasuredCalls: number;
  tokens: Usage;
  /** 가격표에 있는 모델의 측정 비용. 목업·가짜뿐이면 null. */
  costUsd: number | null;
}

export type RepState = 'missing' | 'pending' | 'pass' | 'fail';

export interface FailureRow {
  caseId: string;
  group: string;
  variant: Variant;
  rep: number;
  checks: string[];
  excerpt: string;
  judgeReasons: string[];
}

export interface ModelSummary {
  variant: Variant;
  /** 답을 만든 모델(답 기록의 model). 답이 없으면 null. */
  model: string | null;
  synthetic: boolean;
  cases: { total: number; allRepsPass: number; someRepFails: number; incomplete: number };
  reps: { expected: number; answered: number; graded: number; pass: number; byRep: { rep: number; graded: number; pass: number }[] };
  missedHandoff: { group: string; cases: number; answers: number; missed: number }[];
  falseHandoff: Tally;
  fabricated: Tally;
  rules: Record<RuleName, Tally>;
  ttftMs: Spread;
  durationMs: Spread;
  usage: UsageTotals;
  errors: { unresolved: ErrorRecord[]; resolvedKeys: number };
  failures: FailureRow[];
}

export interface Summary {
  generatedAt: string;
  run: RunHeader | null;
  caseCount: number;
  reps: number;
  judge: { version: string; model: string | null; groups: number; otherVersionRows: number; usage: UsageTotals; unresolvedErrors: number };
  models: ModelSummary[];
}

const RULE_LABELS: Readonly<Record<RuleName, string>> = {
  completed: '정상 종료',
  handoff: '넘김 기대',
  guidance: '넘길 때 안내 문장',
  cites: '인용',
  mustInclude: '필수 표현',
  language: '영어 답',
  plainWords: '내부 표현 없음',
  toolMarkup: '본문 도구 태그 없음',
  repetition: '문장 반복 없음',
};

function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: nearestRank(sorted, 50), p95: nearestRank(sorted, 95) };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** 장부의 호출 중 고른 것들의 토큰·비용. 재시도와 실패한 호출도 들어 있다(돈은 거기서도 나간다). */
export function usageOf(calls: readonly CallRecord[], pick: (start: CallStart) => boolean): UsageTotals {
  const ends = new Map<string, Billing>();
  for (const row of calls) if (row.type === 'end') ends.set(row.callId, row.outcome);
  const totals: UsageTotals = { calls: 0, measuredCalls: 0, unmeasuredCalls: 0, tokens: ZERO_USAGE, costUsd: null };
  for (const start of calls) {
    if (start.type !== 'start' || !pick(start)) continue;
    totals.calls += 1;
    const outcome = ends.get(start.callId);
    if (outcome?.billing === 'measured') {
      totals.measuredCalls += 1;
      totals.tokens = addUsage(totals.tokens, outcome.usage);
      if (priceOf(start.model)) totals.costUsd = (totals.costUsd ?? 0) + measuredCostUsd(start, outcome);
    } else if (start.billable && outcome?.billing !== 'none') {
      totals.unmeasuredCalls += 1;
    }
  }
  return totals;
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '(빈 답)';
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function repState(rulesFailed: boolean, verdict: JudgeVerdict | undefined): RepState {
  if (rulesFailed) return 'fail';
  if (!verdict) return 'pending';
  return !verdict.fabricated && verdict.appropriate ? 'pass' : 'fail';
}

function summarizeVariant(input: ReportInput, variant: Variant, verdicts: ReadonlyMap<AnswerKey, JudgeVerdict>): ModelSummary {
  const answersByKey = new Map(input.answers.map((a) => [a.key, a]));
  const reps = Array.from({ length: input.reps }, (_, i) => i + 1);
  // 이 보고서가 다루는 답의 키(고른 사례 × 회차). 오류·토큰도 이 키만 센다.
  const expectedKeys = new Set<string>(input.cases.flatMap((c) => reps.map((rep) => answerKey(variant, c.id, rep))));
  const rules = Object.fromEntries(RULE_NAMES.map((r) => [r, { count: 0, n: 0 }])) as Record<RuleName, Tally>;
  const byRep = reps.map((rep) => ({ rep, graded: 0, pass: 0 }));
  const groups = new Map<string, { group: string; cases: number; answers: number; missed: number }>();
  const summary: ModelSummary = {
    variant,
    model: null,
    synthetic: false,
    cases: { total: input.cases.length, allRepsPass: 0, someRepFails: 0, incomplete: 0 },
    reps: { expected: input.cases.length * input.reps, answered: 0, graded: 0, pass: 0, byRep },
    missedHandoff: [],
    falseHandoff: { count: 0, n: 0 },
    fabricated: { count: 0, n: 0 },
    rules,
    ttftMs: spread([]),
    durationMs: spread([]),
    usage: usageOf(input.calls, (s) => s.phase === 'answers' && expectedKeys.has(s.key)),
    errors: { unresolved: [], resolvedKeys: 0 },
    failures: [],
  };
  const ttft: number[] = [];
  const duration: number[] = [];

  for (const c of input.cases) {
    const handoffGroup = c.expect.handoff === true ? (groups.get(c.group) ?? { group: c.group, cases: 0, answers: 0, missed: 0 }) : null;
    if (handoffGroup) {
      handoffGroup.cases += 1;
      groups.set(c.group, handoffGroup);
    }
    const states: RepState[] = [];
    for (const rep of reps) {
      const key = answerKey(variant, c.id, rep);
      const answer = answersByKey.get(key);
      if (!answer) {
        states.push('missing');
        continue;
      }
      summary.model ??= answer.model;
      summary.reps.answered += 1;
      if (answer.ttftMs !== null) ttft.push(answer.ttftMs);
      if (answer.status !== 'blocked') duration.push(answer.durationMs);
      if (handoffGroup) {
        handoffGroup.answers += 1;
        if (answer.handoff === null) handoffGroup.missed += 1;
      }
      if (c.expect.handoff === false) {
        summary.falseHandoff.n += 1;
        if (answer.handoff !== null) summary.falseHandoff.count += 1;
      }
      const result = gradeRules(c, answer);
      for (const rule of RULE_NAMES) {
        if (result[rule].verdict === 'na') continue;
        rules[rule].n += 1;
        if (result[rule].verdict === 'fail') rules[rule].count += 1;
      }
      const failed = failedRules(result);
      const verdict = verdicts.get(key);
      if (verdict) {
        summary.fabricated.n += 1;
        if (verdict.fabricated) summary.fabricated.count += 1;
      }
      const state = repState(failed.length > 0, verdict);
      states.push(state);
      const slot = byRep[rep - 1];
      if (slot && (state === 'pass' || state === 'fail')) {
        slot.graded += 1;
        summary.reps.graded += 1;
        if (state === 'pass') {
          slot.pass += 1;
          summary.reps.pass += 1;
        }
      }
      if (state === 'fail') {
        const judgeChecks = verdict ? [...(verdict.fabricated ? ['지어냄'] : []), ...(verdict.appropriate ? [] : ['알맞지 않음'])] : [];
        summary.failures.push({
          caseId: c.id,
          group: c.group,
          variant,
          rep,
          checks: [...failed.map((f) => `${RULE_LABELS[f.rule]}: ${f.detail}`), ...judgeChecks.map((j) => `심판: ${j}`)],
          excerpt: excerptOf(answer.text),
          judgeReasons: verdict
            ? [...(verdict.fabricated ? [verdict.fabricatedDetail] : []), ...(verdict.appropriate ? [] : [verdict.appropriateDetail])]
            : [],
        });
      }
    }
    if (states.every((s) => s === 'pass')) summary.cases.allRepsPass += 1;
    else if (states.includes('fail')) summary.cases.someRepFails += 1;
    else summary.cases.incomplete += 1;
  }

  summary.synthetic = summary.model !== null && priceOf(summary.model) === null;
  summary.missedHandoff = [...groups.values()];
  summary.ttftMs = spread(ttft);
  summary.durationMs = spread(duration);

  const latestError = new Map<string, ErrorRecord>();
  for (const e of input.errors) if (e.phase === 'answers' && expectedKeys.has(e.key)) latestError.set(e.key, e);
  const answeredKeys = new Set<string>(answersByKey.keys());
  for (const [key, e] of latestError) {
    if (answeredKeys.has(key)) summary.errors.resolvedKeys += 1;
    else summary.errors.unresolved.push(e);
  }
  return summary;
}

export function buildSummary(input: ReportInput): Summary {
  const judgments = currentJudgments(input.judgments, input.judgeVersion);
  const verdicts = verdictsByAnswer(judgments);
  const judgeErrors = new Set(input.errors.filter((e) => e.phase === 'judge' && e.key.startsWith(`${input.judgeVersion}/`)).map((e) => e.key));
  for (const j of judgments) judgeErrors.delete(j.key);
  return {
    generatedAt: input.generatedAt,
    run: input.run,
    caseCount: input.cases.length,
    reps: input.reps,
    judge: {
      version: input.judgeVersion,
      model: judgments[0]?.model ?? null,
      groups: judgments.length,
      otherVersionRows: input.judgments.length - judgments.length,
      usage: usageOf(input.calls, (s) => s.phase === 'judge' || s.phase === 'judge-check'),
      unresolvedErrors: judgeErrors.size,
    },
    models: input.variants.map((variant) => summarizeVariant(input, variant, verdicts)),
  };
}

function rate({ count, n }: Tally): string {
  return n === 0 ? `0/0` : `${count}/${n} (${((count / n) * 100).toFixed(1)}%)`;
}

function ms(value: number | null): string {
  return value === null ? '-' : `${Math.round(value)}ms`;
}

function money(usage: UsageTotals, synthetic: boolean): string {
  if (usage.costUsd === null) return synthetic ? '합성값이라 없음' : '-';
  return `$${usage.costUsd.toFixed(4)}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
}

function modelName(m: ModelSummary): string {
  return `${m.variant} (${m.model ?? '답 없음'})`;
}

function usageLine(usage: UsageTotals, synthetic: boolean): string {
  const t = usage.tokens;
  const unmeasured = usage.unmeasuredCalls > 0 ? `, 사용량을 모르는 호출 ${usage.unmeasuredCalls}건(비용에 없음 — 예산 장부는 상한으로 셈)` : '';
  return (
    `호출 ${usage.calls}건(사용량 측정 ${usage.measuredCalls}건${unmeasured}). 입력 ${t.inputTokens}, 캐시 쓰기 ${t.cacheCreationInputTokens}, 캐시 읽기 ${t.cacheReadInputTokens}, 출력 ${t.outputTokens} 토큰` +
    `${synthetic ? '(합성값)' : ''}. 비용 ${money(usage, synthetic)}.`
  );
}

function renderModel(m: ModelSummary, reps: number): string[] {
  const lines = [`### ${modelName(m)}`, ''];
  lines.push(
    `- 사례 ${m.cases.total}개: ${reps}회 모두 충족 ${m.cases.allRepsPass}, 한 회라도 미충족 ${m.cases.someRepFails}, 미완료(답·판정이 덜 모임) ${m.cases.incomplete}.`,
    `- 답 ${m.reps.answered}/${m.reps.expected}개를 받았고, 채점이 끝난 답 ${m.reps.graded}개 중 충족 ${rate({ count: m.reps.pass, n: m.reps.graded })}. 회차별: ${m.reps.byRep.map((r) => `${r.rep}회 ${rate({ count: r.pass, n: r.graded })}`).join(', ')}.`,
    `- 넘기면 안 되는 사례에서 넘김: ${rate(m.falseHandoff)}. 심판이 본 지어냄: ${rate(m.fabricated)}.`,
    `- TTFT p50 ${ms(m.ttftMs.p50)}, p95 ${ms(m.ttftMs.p95)} (n=${m.ttftMs.n}). 응답 시간 p50 ${ms(m.durationMs.p50)}, p95 ${ms(m.durationMs.p95)} (n=${m.durationMs.n}). 유스케이스 호출부터 잰 값이라 HTTP·네트워크 왕복은 빠져 있다.`,
    `- 토큰·비용(답 단계, 재시도 포함): ${usageLine(m.usage, m.synthetic)}`,
    '',
    '넘김 놓침(넘겨야 하는 사례, 그룹별):',
    '',
    '| 그룹 | 사례 | 답 | 놓침 |',
    '| --- | --- | --- | --- |',
    ...m.missedHandoff.map((g) => `| ${cell(g.group)} | ${g.cases} | ${g.answers} | ${rate({ count: g.missed, n: g.answers })} |`),
    '',
    '기계 채점(적용되는 답 중 실패):',
    '',
    '| 규칙 | 실패 |',
    '| --- | --- |',
    ...RULE_NAMES.map((r) => `| ${RULE_LABELS[r]} | ${rate(m.rules[r])} |`),
    '',
  );
  if (m.errors.unresolved.length > 0 || m.errors.resolvedKeys > 0) {
    lines.push(`오류: 남은 것 ${m.errors.unresolved.length}건, 다시 돌려 해결된 키 ${m.errors.resolvedKeys}건.`, '');
    for (const e of m.errors.unresolved) lines.push(`- ${e.key} ${e.class}(시도 ${e.attempts}): ${cell(e.message)}`);
    if (m.errors.unresolved.length > 0) lines.push('');
  }
  return lines;
}

export function renderReport(s: Summary): string {
  const synthetic = s.models.some((m) => m.synthetic) || (s.judge.model !== null && priceOf(s.judge.model) === null);
  const run = s.run;
  const lines = [
    '# 응답 품질 평가 보고서',
    '',
    `- 만든 시각: ${s.generatedAt}. 실행 폴더: ${run ? `${run.createdAt}에 생성, git ${run.gitSha?.slice(0, 7) ?? '알 수 없음'}` : 'run.json 없음'}.`,
    run
      ? `- 시험지: v${run.cases.version}(${run.cases.status}), sha256 ${run.cases.sha256.slice(0, 12)}, 이 보고서의 사례 ${s.caseCount}개 × 회차 ${s.reps} × 모델 ${s.models.length}개.`
      : `- 사례 ${s.caseCount}개 × 회차 ${s.reps} × 모델 ${s.models.length}개.`,
    `- 심판: ${s.judge.model ?? '판정 없음'}, 버전 ${s.judge.version}. 판정한 묶음 ${s.judge.groups}개${s.judge.otherVersionRows > 0 ? `(다른 버전의 판정 ${s.judge.otherVersionRows}개는 쓰지 않음)` : ''}.`,
    '- 모든 수치는 이 실행 폴더의 기록에서 센 실측값이다. 비율 옆 a/b의 b가 센 답의 수(n)다. 오류로 끝난 답은 0점이 아니라 빠진 답으로 센다.',
    `- 한 회차는 적용되는 기계 채점을 모두 통과하고 심판이 지어냄 없음·알맞음으로 볼 때 충족이다.`,
  ];
  if (synthetic) lines.push('- 목업 엔진·가짜 심판이 낸 수치가 섞여 있다: 토큰은 글자 수로 만든 합성값이고 비용은 없으며, 점수는 파이프라인 확인용이라 뜻이 없다.');
  lines.push(
    '',
    '## 요약',
    '',
    `| 모델 | ${s.reps}회 모두 충족 | 회차 충족률 | 넘김 놓침 | 넘기면 안 되는데 넘김 | 지어냄 | TTFT p50 / p95 | 비용(답) |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...s.models.map((m) => {
      const missed = m.missedHandoff.reduce((acc, g) => ({ count: acc.count + g.missed, n: acc.n + g.answers }), { count: 0, n: 0 });
      return `| ${modelName(m)} | ${m.cases.allRepsPass}/${m.cases.total} (미완료 ${m.cases.incomplete}) | ${rate({ count: m.reps.pass, n: m.reps.graded })} | ${rate(missed)} | ${rate(m.falseHandoff)} | ${rate(m.fabricated)} | ${ms(m.ttftMs.p50)} / ${ms(m.ttftMs.p95)} (n=${m.ttftMs.n}) | ${money(m.usage, m.synthetic)} |`;
    }),
    '',
    '## 모델별',
    '',
    ...s.models.flatMap((m) => renderModel(m, s.reps)),
    '## 심판',
    '',
    `- 이 실행 폴더의 심판 호출 전체(판정·점검): ${usageLine(s.judge.usage, s.judge.model !== null && priceOf(s.judge.model) === null)}`,
    `- 판정을 받지 못한 묶음(오류): ${s.judge.unresolvedErrors}개.`,
    '',
    '## 실패 목록',
    '',
  );
  const failures = s.models.flatMap((m) => m.failures);
  if (failures.length === 0) lines.push('실패한 회차가 없다.');
  else {
    lines.push('| 사례 | 그룹 | 모델 | 회차 | 실패한 검사 | 답 앞부분 | 심판 근거 |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const f of failures) {
      lines.push(`| ${f.caseId} | ${cell(f.group)} | ${f.variant} | ${f.rep} | ${cell(f.checks.join('; '))} | ${cell(f.excerpt)} | ${cell(f.judgeReasons.join(' / ') || '-')} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
