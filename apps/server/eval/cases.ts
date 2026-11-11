import { MAX_MESSAGE_CHARS } from '@qrate/contracts';
import { z } from 'zod';

// 시험지(cases.json)는 사람이 고치는 파일이라 여기서 한 번 검사하고, 안쪽 코드는 Case 타입을 믿는다.
// 필드의 뜻은 시험지의 $comment가 정한다.

const historyTurnSchema = z.object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1) }).strict();

const expectSchema = z
  .object({
    /** true = 넘겨야 함, false = 넘기면 안 됨, null = 채점 안 함. */
    handoff: z.boolean().nullable(),
    /** 모두 인용해야 하는 FAQ id. */
    cites: z.array(z.string().min(1)).default([]),
    /** 묶음마다 대안 중 하나가 답에 있어야 한다. */
    mustInclude: z.array(z.array(z.string().trim().min(1)).min(1)).default([]),
    language: z.literal('en').optional(),
    /** 심판과 사람 채점자가 읽는 기대 설명. */
    judge: z.string().trim().min(1),
  })
  .strict();

const caseSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    group: z.string().trim().min(1),
    source: z.enum(['draft', 'seed']),
    tags: z.array(z.string().min(1)).default([]),
    // 운영의 대화 API가 받는 길이 안이어야 한다 — 넘으면 운영에서는 400이라 같은 질문을 잴 수 없다.
    message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
    history: z
      .array(historyTurnSchema)
      .default([])
      // 대화 유스케이스는 완결된 user → assistant 쌍만 문맥에 넣는다(chat/service.ts toHistory). 짝이 안 맞는 턴은 조용히 빠져 시험이 말한 상황이 되지 않는다.
      .refine((turns) => turns.every((t, i) => t.role === (i % 2 === 0 ? 'user' : 'assistant')) && turns.length % 2 === 0, {
        message: 'history는 user → assistant 쌍이어야 한다',
      }),
    expect: expectSchema,
  })
  .strict();

const caseFileSchema = z
  .object({
    $comment: z.string().optional(),
    version: z.number().int().positive(),
    status: z.enum(['draft', 'approved']),
    tenantKey: z.string().min(1),
    cases: z.array(caseSchema).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const c of file.cases) {
      if (seen.has(c.id)) ctx.addIssue({ code: 'custom', message: `case id 중복: ${c.id}` });
      seen.add(c.id);
    }
  });

export type CaseFile = z.infer<typeof caseFileSchema>;
export type Case = CaseFile['cases'][number];
export type HistoryTurn = Case['history'][number];

/** knowledgeIds: 시드의 FAQ id. 인용 기대가 없는 id를 가리키면 그 사례는 영원히 실패하므로 읽을 때 막는다. */
export function parseCaseFile(raw: unknown, knowledgeIds: ReadonlySet<string>): CaseFile {
  const file = caseFileSchema.parse(raw);
  const unknown = file.cases.flatMap((c) => c.expect.cites.filter((id) => !knowledgeIds.has(id)).map((id) => `${c.id}: ${id}`));
  if (unknown.length > 0) throw new Error(`시험지의 cites가 시드에 없는 FAQ를 가리킨다 — ${unknown.join(', ')}`);
  return file;
}

/** --cases(id 목록)로 고르고 --limit로 앞에서 자른다. 없는 id는 오타일 테니 실패시킨다. */
export function selectCases(all: readonly Case[], opts: { ids?: readonly string[]; limit?: number }): Case[] {
  let picked = [...all];
  if (opts.ids && opts.ids.length > 0) {
    const known = new Set(all.map((c) => c.id));
    const missing = opts.ids.filter((id) => !known.has(id));
    if (missing.length > 0) throw new Error(`시험지에 없는 case id: ${missing.join(', ')}`);
    const wanted = new Set(opts.ids);
    picked = picked.filter((c) => wanted.has(c.id));
  }
  return opts.limit === undefined ? picked : picked.slice(0, opts.limit);
}
