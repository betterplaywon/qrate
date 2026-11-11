import { describe, expect, it } from 'vitest';
import { buildLabelsInput, computeAgreement, renderAgreement } from '../eval/labels.js';
import { JUDGE_MODEL } from '../eval/models.js';
import { answerKey, type AnswerKey, type AnswerRecord, type CallRecord, type ErrorRecord, type JudgeVerdict, type JudgmentRecord } from '../eval/records.js';
import { buildSummary, renderReport, type ReportInput } from '../eval/report.js';
import { makeAnswer, makeCase } from './helpers/eval-fixtures.js';

// 보고서 수치: 손으로 센 기대값과 맞는가. 사례 넷, sonnet, 2회차.
//  a: 넘겨야 함(G1) — r1 넘김·판정 좋음 → 충족, r2 넘기지 않음 → 미충족
//  b: 넘기면 안 됨(G2), 인용·필수 표현 — r1 규칙 통과·심판이 지어냄 → 미충족, r2 오류로 없음
//  c: 넘기면 안 됨(G2) — r1·r2 충족 (r1은 한 번 오류 뒤 다시 돌려 얻음)
//  d: 넘겨야 함(G1) — r1 충족, r2 판정 대기 → 미완료

const VERSION = 'v1';
const HANDOFF = { reason: 'not_in_knowledge' as const, summary: null };

const cases = [
  makeCase('a', { group: 'G1', expect: { handoff: true } }),
  makeCase('b', { group: 'G2', expect: { handoff: false, cites: ['faq:x'], mustInclude: [['9,900원']] } }),
  makeCase('c', { group: 'G2', expect: { handoff: false } }),
  makeCase('d', { group: 'G1', expect: { handoff: true } }),
];

const answers: AnswerRecord[] = [
  makeAnswer('sonnet', 'a', 1, { handoff: HANDOFF, text: '그 부분은 상담원이 이어서 안내해 드릴게요.', ttftMs: 100 }),
  makeAnswer('sonnet', 'a', 2, { text: '아마 될 거예요.', ttftMs: 200 }),
  makeAnswer('sonnet', 'b', 1, { text: '월 9,900원입니다.', citations: [{ sourceId: 'faq:x', citedText: '…' }], ttftMs: 300 }),
  makeAnswer('sonnet', 'c', 1, { ttftMs: 400 }),
  makeAnswer('sonnet', 'c', 2, { ttftMs: 500 }),
  makeAnswer('sonnet', 'd', 1, { handoff: HANDOFF, text: '그 부분은 상담원에게 연결해 드릴게요.', ttftMs: 600 }),
  makeAnswer('sonnet', 'd', 2, { handoff: HANDOFF, text: '상담원이 이어서 안내해 드릴게요.', ttftMs: 700 }),
];

function verdict(key: AnswerKey, over: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return { answerKey: key, fabricated: false, fabricatedDetail: '자료대로', appropriate: true, appropriateDetail: '기대대로', ...over };
}

function judgment(caseId: string, verdicts: JudgeVerdict[], over: Partial<JudgmentRecord> = {}): JudgmentRecord {
  return {
    key: `${VERSION}/sonnet/${caseId}`,
    judgeVersion: VERSION,
    variant: 'sonnet',
    caseId,
    model: JUDGE_MODEL,
    servedBy: JUDGE_MODEL,
    order: verdicts.map((v) => v.answerKey),
    verdicts,
    usage: { inputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 9000, outputTokens: 400 },
    durationMs: 5000,
    attempts: 1,
    at: '2026-11-11T00:00:00.000Z',
    ...over,
  };
}

const k = (caseId: string, rep: number) => answerKey('sonnet', caseId, rep);

const judgments: JudgmentRecord[] = [
  judgment('a', [verdict(k('a', 1)), verdict(k('a', 2))]),
  judgment('b', [verdict(k('b', 1), { fabricated: true, fabricatedDetail: '자료에 없는 할인을 단정했다' })]),
  judgment('c', [verdict(k('c', 1)), verdict(k('c', 2))]),
  judgment('d', [verdict(k('d', 1))]),
  // 다른 버전의 판정은 쓰지 않는다.
  judgment('d', [verdict(k('d', 2), { appropriate: false })], { key: 'old/sonnet/d', judgeVersion: 'old' }),
];

const errors: ErrorRecord[] = [
  { phase: 'answers', key: 'sonnet/b/r2', class: 'serving', message: 'rate_limited: test', attempts: 3, usage: null, at: '2026-11-11T00:00:00.000Z' },
  { phase: 'answers', key: 'sonnet/c/r1', class: 'timeout', message: '60000ms 안에 끝나지 않음', attempts: 1, usage: null, at: '2026-11-11T00:00:00.000Z' },
];

function callPair(n: number, key: string, outcome: Extract<CallRecord, { type: 'end' }>['outcome'], phase: 'answers' | 'judge' = 'answers'): CallRecord[] {
  const model = phase === 'answers' ? 'claude-sonnet-5-5' : JUDGE_MODEL;
  return [
    { type: 'start', callId: `c${n}`, phase, key, attempt: 1, model, billable: true, ceilingUsd: 0.05, at: '' },
    { type: 'end', callId: `c${n}`, outcome, at: '' },
  ];
}

const measured = { billing: 'measured' as const, usage: { inputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 1000, outputTokens: 50 }, servedBy: 'claude-sonnet-5-5' };
const calls: CallRecord[] = [
  ...answers.flatMap((a, i) => callPair(i, a.key, measured)),
  ...callPair(10, 'sonnet/b/r2', { billing: 'none' }),
  ...callPair(11, 'sonnet/c/r1', { billing: 'unknown' }),
  ...callPair(12, `${VERSION}/sonnet/a`, { billing: 'measured', usage: { inputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 9000, outputTokens: 400 }, servedBy: JUDGE_MODEL }, 'judge'),
];

const input: ReportInput = {
  cases,
  variants: ['sonnet'],
  reps: 2,
  answers,
  judgments,
  judgeVersion: VERSION,
  errors,
  calls,
  run: { createdAt: '2026-11-11T00:00:00.000Z', gitSha: 'abcdef1234567', cases: { sha256: 'f'.repeat(64), version: 1, status: 'approved', count: 4 } },
  generatedAt: '2026-11-11T01:00:00.000Z',
};

describe('보고서 — buildSummary', () => {
  const summary = buildSummary(input);
  const m = summary.models[0];
  if (!m) throw new Error('모델 요약 없음');

  it('사례 단위: 2회 모두 충족·미충족·미완료를 가른다', () => {
    expect(m.cases).toEqual({ total: 4, allRepsPass: 1, someRepFails: 2, incomplete: 1 });
  });

  it('회차 단위: 채점이 끝난 답만 분모로 센다(오류로 빠진 답은 0점이 아니다)', () => {
    expect(m.reps).toEqual({
      expected: 8,
      answered: 7,
      graded: 6,
      pass: 4,
      byRep: [
        { rep: 1, graded: 4, pass: 3 },
        { rep: 2, graded: 2, pass: 1 },
      ],
    });
  });

  it('넘김 놓침은 그룹별로, 넘기면 안 되는 사례의 넘김과 지어냄은 따로 센다', () => {
    expect(m.missedHandoff).toEqual([{ group: 'G1', cases: 2, answers: 4, missed: 1 }]);
    expect(m.falseHandoff).toEqual({ count: 0, n: 3 });
    expect(m.fabricated).toEqual({ count: 1, n: 6 });
  });

  it('규칙별 실패는 적용되는 답만 센다', () => {
    expect(m.rules).toEqual({
      completed: { count: 0, n: 7 },
      handoff: { count: 1, n: 7 },
      guidance: { count: 0, n: 4 },
      cites: { count: 0, n: 1 },
      mustInclude: { count: 0, n: 1 },
      language: { count: 0, n: 7 },
      plainWords: { count: 0, n: 7 },
      toolMarkup: { count: 0, n: 7 },
      repetition: { count: 0, n: 7 },
    });
  });

  it('TTFT는 nearest-rank 백분위(콘솔 지표와 같은 정의)', () => {
    expect(m.ttftMs).toEqual({ n: 7, p50: 400, p95: 700 });
  });

  it('토큰·비용은 장부에서 센다 — 실패한 호출도 들어가고, 사용량을 모르는 호출은 따로 센다', () => {
    expect(m.usage.calls).toBe(9);
    expect(m.usage.measuredCalls).toBe(7);
    expect(m.usage.unmeasuredCalls).toBe(1);
    expect(m.usage.tokens).toEqual({ inputTokens: 700, cacheCreationInputTokens: 0, cacheReadInputTokens: 7000, outputTokens: 350 });
    // 1건 = (100×$2 + 1000×$0.10 + 50×$10) / 백만 = $0.0008
    expect(m.usage.costUsd).toBeCloseTo(7 * 0.0008, 10);
    expect(summary.judge.usage.costUsd).toBeCloseTo((300 * 4 + 9000 * 0.2 + 400 * 20) / 1_000_000, 10);
  });

  it('오류는 남은 것과 다시 돌려 해결된 것을 나눈다', () => {
    expect(m.errors.unresolved.map((e) => e.key)).toEqual(['sonnet/b/r2']);
    expect(m.errors.resolvedKeys).toBe(1);
  });

  it('실패 목록에 실패한 검사·답 앞부분·심판 근거가 들어간다', () => {
    expect(m.failures.map((f) => `${f.caseId}/${f.rep}`)).toEqual(['a/2', 'b/1']);
    expect(m.failures[0]?.checks).toEqual(['넘김 기대: 넘기지 않음']);
    expect(m.failures[1]?.checks).toEqual(['심판: 지어냄']);
    expect(m.failures[1]?.judgeReasons).toEqual(['자료에 없는 할인을 단정했다']);
  });

  it('다른 버전의 판정은 세지 않고, 몇 개를 뺐는지 알린다', () => {
    expect(summary.judge).toMatchObject({ version: VERSION, model: JUDGE_MODEL, groups: 4, otherVersionRows: 1 });
  });

  it('마크다운에 n과 회차가 함께 보이고 NaN이 없다', () => {
    const md = renderReport(summary);
    expect(md).toContain('| sonnet (claude-sonnet-5-5) | 1/4 (미완료 1) | 4/6 (66.7%) | 1/4 (25.0%) | 0/3 (0.0%) | 1/6 (16.7%) | 400ms / 700ms (n=7) | $0.0056 |');
    expect(md).toContain('| G1 | 2 | 4 | 1/4 (25.0%) |');
    expect(md).not.toMatch(/NaN|undefined/);
  });
});

describe('라벨 내보내기와 대조', () => {
  it('지정한 변형·회차의 답을 판정과 함께 내보낸다', () => {
    const exported = buildLabelsInput({ cases, answers, judgments, judgeVersion: VERSION, variant: 'sonnet', rep: 1 });
    expect(exported.items.map((i) => i.answerKey)).toEqual([k('a', 1), k('b', 1), k('c', 1), k('d', 1)]);
    expect(exported.items[1]?.judge?.fabricated).toBe(true);
    expect(exported.judgeModel).toBe(JUDGE_MODEL);
  });

  it('사람 라벨과 판정의 일치를 판정별로 센다', () => {
    const labels = {
      [k('a', 1)]: { fabricated: false, appropriate: true },
      [k('b', 1)]: { fabricated: false, appropriate: true },
      [k('c', 1)]: { fabricated: false, appropriate: false },
      'sonnet/zz/r1': { fabricated: false, appropriate: true },
    };
    const agreement = computeAgreement(labels, judgments, VERSION);
    expect(agreement.unmatched).toEqual(['sonnet/zz/r1']);
    expect(agreement.properties).toMatchObject([
      { property: 'fabricated', n: 3, agree: 2, humanOnly: 0, judgeOnly: 1 },
      { property: 'appropriate', n: 3, agree: 2, humanOnly: 0, judgeOnly: 1 },
    ]);
    expect(renderAgreement(agreement)).toContain('| 지어냄 | 2/3 (66.7%) | 0 | 1 |');
  });
});
