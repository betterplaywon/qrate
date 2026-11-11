import { z } from 'zod';
import type { Case } from './cases.js';
import { currentJudgments, verdictsByAnswer } from './judge.js';
import type { Variant } from './models.js';
import { answerKey, answerKeySchema, type AnswerKey, type AnswerRecord, type JudgeVerdict, type JudgmentRecord } from './records.js';

// 심판의 정확도를 사람 라벨로 확인한다: 한 모델·한 회차의 답을 판정과 함께 내보내고(labels-input.json),
// 사람이 같은 두 질문(지어냄·알맞음)에 답한 labels.json과 판정을 맞대어 본다.

export interface LabelItem {
  answerKey: AnswerKey;
  caseId: string;
  group: string;
  question: string;
  history: Case['history'];
  expect: { handoff: boolean | null; note: string };
  answer: Pick<AnswerRecord, 'status' | 'text' | 'handoff'> & { citedFaqIds: string[] };
  judge: { fabricated: boolean; fabricatedDetail: string; appropriate: boolean; appropriateDetail: string } | null;
}

export interface LabelsInput {
  judgeVersion: string;
  judgeModel: string | null;
  variant: Variant;
  rep: number;
  items: LabelItem[];
}

export function buildLabelsInput(opts: {
  cases: readonly Case[];
  answers: readonly AnswerRecord[];
  judgments: readonly JudgmentRecord[];
  judgeVersion: string;
  variant: Variant;
  rep: number;
}): LabelsInput {
  const judgments = currentJudgments(opts.judgments, opts.judgeVersion);
  const verdicts = verdictsByAnswer(judgments);
  const answers = new Map(opts.answers.map((a) => [a.key, a]));
  const items = opts.cases.flatMap((c): LabelItem[] => {
    const key = answerKey(opts.variant, c.id, opts.rep);
    const answer = answers.get(key);
    if (!answer) return [];
    const verdict = verdicts.get(key);
    return [
      {
        answerKey: key,
        caseId: c.id,
        group: c.group,
        question: c.message,
        history: c.history,
        expect: { handoff: c.expect.handoff, note: c.expect.judge },
        answer: {
          status: answer.status,
          text: answer.text,
          handoff: answer.handoff,
          citedFaqIds: [...new Set(answer.citations.map((x) => x.sourceId))],
        },
        judge: verdict
          ? {
              fabricated: verdict.fabricated,
              fabricatedDetail: verdict.fabricatedDetail,
              appropriate: verdict.appropriate,
              appropriateDetail: verdict.appropriateDetail,
            }
          : null,
      },
    ];
  });
  return { judgeVersion: opts.judgeVersion, judgeModel: judgments[0]?.model ?? null, variant: opts.variant, rep: opts.rep, items };
}

/** 사람이 쓴 labels.json: { [answerKey]: { fabricated, appropriate } }. */
export const labelsFileSchema = z.record(z.string(), z.object({ fabricated: z.boolean(), appropriate: z.boolean() }).strict());
export type LabelsFile = z.infer<typeof labelsFileSchema>;

const PROPERTIES = ['fabricated', 'appropriate'] as const;
type Property = (typeof PROPERTIES)[number];

export interface PropertyAgreement {
  property: Property;
  /** 사람 라벨과 판정이 둘 다 있는 답. */
  n: number;
  agree: number;
  /** 사람 true·심판 false / 사람 false·심판 true. */
  humanOnly: number;
  judgeOnly: number;
  disagreements: { answerKey: string; human: boolean; judge: boolean; detail: string }[];
}

export interface Agreement {
  judgeVersion: string;
  labelled: number;
  /** 라벨은 있는데 지금 버전의 판정이 없는 답(키 오타·다른 버전의 판정). */
  unmatched: string[];
  properties: PropertyAgreement[];
}

export function computeAgreement(labels: LabelsFile, judgments: readonly JudgmentRecord[], judgeVersion: string): Agreement {
  const verdicts = verdictsByAnswer(currentJudgments(judgments, judgeVersion));
  const unmatched: string[] = [];
  const pairs: { key: string; human: LabelsFile[string]; judge: JudgeVerdict }[] = [];
  for (const [key, human] of Object.entries(labels)) {
    const parsedKey = answerKeySchema.safeParse(key);
    const judge = parsedKey.success ? verdicts.get(parsedKey.data) : undefined;
    if (judge) pairs.push({ key, human, judge });
    else unmatched.push(key);
  }
  const properties = PROPERTIES.map((property): PropertyAgreement => {
    const result: PropertyAgreement = { property, n: pairs.length, agree: 0, humanOnly: 0, judgeOnly: 0, disagreements: [] };
    for (const { key, human, judge } of pairs) {
      const h = human[property];
      const j = judge[property];
      if (h === j) {
        result.agree += 1;
        continue;
      }
      if (h) result.humanOnly += 1;
      else result.judgeOnly += 1;
      result.disagreements.push({ answerKey: key, human: h, judge: j, detail: property === 'fabricated' ? judge.fabricatedDetail : judge.appropriateDetail });
    }
    return result;
  });
  return { judgeVersion, labelled: Object.keys(labels).length, unmatched, properties };
}

const PROPERTY_LABELS: Readonly<Record<Property, string>> = { fabricated: '지어냄', appropriate: '알맞음' };

export function renderAgreement(a: Agreement): string {
  const lines = [
    '# 심판과 사람 라벨의 일치',
    '',
    `- 심판 버전 ${a.judgeVersion}. 라벨 ${a.labelled}개 중 판정과 맞댄 답 ${a.properties[0]?.n ?? 0}개(실측).`,
    ...(a.unmatched.length > 0 ? [`- 판정을 찾지 못한 라벨 ${a.unmatched.length}개: ${a.unmatched.join(', ')}`] : []),
    '',
    '| 판정 | 일치 | 사람만 참 | 심판만 참 |',
    '| --- | --- | --- | --- |',
    ...a.properties.map((p) => {
      const pct = p.n === 0 ? '-' : `${((p.agree / p.n) * 100).toFixed(1)}%`;
      return `| ${PROPERTY_LABELS[p.property]} | ${p.agree}/${p.n} (${pct}) | ${p.humanOnly} | ${p.judgeOnly} |`;
    }),
    '',
  ];
  for (const p of a.properties) {
    if (p.disagreements.length === 0) continue;
    lines.push(`## ${PROPERTY_LABELS[p.property]}에서 갈린 답`, '');
    for (const d of p.disagreements) lines.push(`- ${d.answerKey}: 사람 ${d.human}, 심판 ${d.judge} — 심판 근거: ${d.detail.replace(/\s+/g, ' ')}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
