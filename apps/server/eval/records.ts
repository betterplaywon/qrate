import { z } from 'zod';
import type { HandoffReason, StopReason, Usage } from '../src/engine/types.js';
import { VARIANTS } from './models.js';
import type { AnswerStatus } from './rules.js';

// 실행 폴더의 jsonl 한 줄 한 줄의 모양. 단계마다 자기 파일에 붙여 쓰기만 하고, 같은 키를 다시 만나면 건너뛴다(멱등).
// 파일은 사람이 열어 볼 수도 있는 외부 입력이라 읽을 때마다 이 스키마로 검사한다.

export const variantSchema = z.enum(VARIANTS);
export const phaseSchema = z.enum(['answers', 'judge', 'judge-check']);
export type Phase = z.infer<typeof phaseSchema>;

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
}) satisfies z.ZodType<Usage>;

export const ZERO_USAGE: Usage = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };

const HANDOFF_REASONS = ['not_in_knowledge', 'needs_human', 'out_of_scope', 'other'] as const satisfies readonly HandoffReason[];
const STOP_REASONS = ['end_turn', 'max_tokens', 'refusal', 'other'] as const satisfies readonly StopReason[];
const ANSWER_STATUSES = ['ok', 'truncated', 'refusal', 'blocked'] as const satisfies readonly AnswerStatus[];

/** 변형/사례/회차. 심판 판정과 사람 라벨이 이 키로 답을 가리킨다. */
export const answerKeySchema = z
  .string()
  .regex(/^[a-z]+\/[a-z][a-z0-9-]*\/r[1-9]\d*$/)
  .brand<'AnswerKey'>();
export type AnswerKey = z.infer<typeof answerKeySchema>;

export function answerKey(variant: z.infer<typeof variantSchema>, caseId: string, rep: number): AnswerKey {
  return answerKeySchema.parse(`${variant}/${caseId}/r${rep}`);
}

export const answerRecordSchema = z.object({
  key: answerKeySchema,
  variant: variantSchema,
  caseId: z.string(),
  rep: z.number().int().positive(),
  /** 요청한 모델(엔진의 model). 목업이면 mock. */
  model: z.string(),
  status: z.enum(ANSWER_STATUSES),
  text: z.string(),
  citations: z.array(z.object({ sourceId: z.string(), citedText: z.string() })),
  handoff: z.object({ reason: z.enum(HANDOFF_REASONS), summary: z.string().nullable() }).nullable(),
  stopReason: z.enum(STOP_REASONS).nullable(),
  servedBy: z.string().nullable(),
  fallbackUsed: z.boolean(),
  usage: usageSchema,
  /** 유스케이스 호출 시작 → 공백이 아닌 첫 조각(ms). HTTP·네트워크 왕복은 빠져 있다. */
  ttftMs: z.number().nonnegative().nullable(),
  durationMs: z.number().nonnegative(),
  /** 이 답을 얻기까지 시작한 모델 호출 수(재시도 포함). 차단된 답은 0. */
  attempts: z.number().int().nonnegative(),
  at: z.string(),
});
export type AnswerRecord = z.infer<typeof answerRecordSchema>;

export const ERROR_CLASSES = ['harness', 'serving', 'timeout', 'served-model-mismatch', 'judge-parse', 'refusal'] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/**
 * 같은 단계를 다시 돌릴 때 이 오류의 키를 다시 시도하는가. 모델의 결과(폴백으로 다른 모델이 답함·정책 거절)는 다시 뽑지 않는다 —
 * 거절된 질문을 될 때까지 다시 뽑으면 거절이 측정에서 사라진다. 기반 시설 탓(서빙·시간 초과·하네스·파싱)은 다시 시도한다.
 */
export const RETRY_ON_RERUN: Readonly<Record<ErrorClass, boolean>> = {
  harness: true,
  serving: true,
  timeout: true,
  'judge-parse': true,
  'served-model-mismatch': false,
  refusal: false,
};

export const errorRecordSchema = z.object({
  phase: phaseSchema,
  key: z.string(),
  class: z.enum(ERROR_CLASSES),
  message: z.string(),
  attempts: z.number().int().nonnegative(),
  usage: usageSchema.nullable(),
  at: z.string(),
});
export type ErrorRecord = z.infer<typeof errorRecordSchema>;

const verdictFields = {
  fabricated: z.boolean(),
  fabricatedDetail: z.string(),
  appropriate: z.boolean(),
  appropriateDetail: z.string(),
};

export const judgeVerdictSchema = z.object({ answerKey: answerKeySchema, ...verdictFields });
export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

export const judgmentRecordSchema = z.object({
  /** 심판 버전/변형/사례. 심판 지시·스키마·설정이 바뀌면 버전이 바뀌어 다시 채점된다. */
  key: z.string(),
  judgeVersion: z.string(),
  variant: variantSchema,
  caseId: z.string(),
  model: z.string(),
  servedBy: z.string(),
  /** 심판에게 보인 순서. i번째가 라벨 A, B, …다. */
  order: z.array(answerKeySchema),
  verdicts: z.array(judgeVerdictSchema).min(1),
  usage: usageSchema,
  durationMs: z.number().nonnegative(),
  attempts: z.number().int().positive(),
  at: z.string(),
});
export type JudgmentRecord = z.infer<typeof judgmentRecordSchema>;

export const judgeCheckRecordSchema = z.object({
  key: z.string(),
  judgeVersion: z.string(),
  caseId: z.string(),
  model: z.string(),
  servedBy: z.string(),
  results: z.array(z.object({ label: z.string(), kind: z.string(), text: z.string(), ...verdictFields })).min(1),
  usage: usageSchema,
  durationMs: z.number().nonnegative(),
  attempts: z.number().int().positive(),
  at: z.string(),
});
export type JudgeCheckRecord = z.infer<typeof judgeCheckRecordSchema>;

/**
 * measured = 응답의 사용량을 받음, none = 요청이 거절돼 과금되지 않음(첫 조각 전의 429·5xx·인증·잘못된 요청),
 * unknown = 과금됐을 수 있으나 사용량을 모름(시간 초과·스트림 도중 실패).
 */
export const billingSchema = z.discriminatedUnion('billing', [
  z.object({ billing: z.literal('measured'), usage: usageSchema, servedBy: z.string().nullable() }),
  z.object({ billing: z.literal('none') }),
  z.object({ billing: z.literal('unknown') }),
]);
export type Billing = z.infer<typeof billingSchema>;

/**
 * 모델 호출 장부. 호출 전에 start, 끝나면 end를 쓴다 — 도중에 프로세스가 죽어도 시작한 호출은 남는다.
 * 예산 장부(budget.ts)는 unknown과 end 없는 start를 시작 때 잡은 상한으로 센다.
 */
export const callRecordSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    callId: z.string(),
    phase: phaseSchema,
    key: z.string(),
    attempt: z.number().int().positive(),
    model: z.string(),
    /** 실제 API 호출인가. 목업 엔진·가짜 심판은 false — 장부에는 남기되 상한에는 세지 않는다. */
    billable: z.boolean(),
    ceilingUsd: z.number().nonnegative(),
    at: z.string(),
  }),
  z.object({ type: z.literal('end'), callId: z.string(), outcome: billingSchema, at: z.string() }),
]);
export type CallRecord = z.infer<typeof callRecordSchema>;
export type CallStart = Extract<CallRecord, { type: 'start' }>;
