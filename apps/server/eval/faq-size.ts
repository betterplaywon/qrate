// FAQ 크기에 따른 질문 1건의 비용·첫 응답 시간 실측. 위젯은 질문마다 회사 FAQ 전체를 모델에 보내서(ADR-0004)
// 콘솔의 FAQ 상한(KNOWLEDGE_LIMITS: 50개·제목과 문단 합계 3만 자)이 곧 질문 하나의 최대 비용과 지연이다.
// 데모 FAQ(27개)·1만 5천 자·3만 자에서 같은 질문을 세 번씩 묻는다. 첫 번째는 FAQ를 처음 읽고(캐시 쓰기), 나머지 둘은 5분 안에 다시 읽는다(캐시 읽기).
//
//   pnpm --filter @qrate/server eval:faq-size        가짜 엔진으로 흐름만 확인(비용 0)
//   pnpm --filter @qrate/server eval:faq-size:paid   실제 Claude(운영 엔진·설정 그대로). 작성자가 정한 상한(2026-11-12: 12회·$0.5) 안에서만 부른다
//
// 호출마다 그 호출의 비용 상한을 미리 셈해 예산을 넘으면 부르지 않고 멈춘다(faq-size-plan.ts). 결과는 docs/eval/faq-size/runs/<시각>.jsonl.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineError, type AnswerEngine, type KnowledgeSource, type Usage } from '../src/engine/types.js';
import { loadSeedFiles } from '../src/repo/seed.js';
import { answerConfig, engineFactory } from './clients.js';
import { nextCallAllowed, padFaqSet, repeatCallCeilingUsd, sentencePool, type Caps, type FaqSet } from './faq-size-plan.js';
import { VARIANT_MODELS, billingPrice, callCeilingUsd, costUsd, inputTokenBound, priceOf } from './models.js';

const CAPS: Caps = { calls: 12, usd: 0.5 };
const CALLS_PER_SIZE = 3;
const QUESTION = '연간 결제하면 할인돼요?';
const TENANT_NAME = '마루인보이스';
const EMPTY_USAGE: Usage = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };

interface CallRow {
  size: string;
  items: number;
  chars: number;
  call: number;
  cache: 'write' | 'read' | 'none';
  ttftMs: number | null;
  totalMs: number;
  usage: Usage;
  servedBy: string;
  costUsd: number;
  answerChars: number;
}

type Answer = Pick<CallRow, 'cache' | 'ttftMs' | 'totalMs' | 'usage' | 'servedBy' | 'answerChars'>;

async function ask(engine: AnswerEngine, knowledge: KnowledgeSource[]): Promise<Answer> {
  const start = performance.now();
  let ttftMs: number | null = null;
  let answer = '';
  let done: { usage: Usage; servedBy: string } | null = null;
  const request = { tenantId: 'faq-size', tenantName: TENANT_NAME, message: QUESTION, history: [], knowledge, signal: AbortSignal.timeout(90_000) };
  for await (const ev of engine.stream(request)) {
    if (ev.type === 'delta') {
      if (ttftMs === null && ev.text.trim()) ttftMs = Math.round(performance.now() - start);
      answer += ev.text;
    }
    if (ev.type === 'done') done = { usage: ev.usage, servedBy: ev.servedBy };
  }
  if (!done) throw new Error('done 이벤트 없이 끝났다');
  const { usage } = done;
  const cache = usage.cacheCreationInputTokens > 0 ? 'write' : usage.cacheReadInputTokens > 0 ? 'read' : 'none';
  return { cache, ttftMs, totalMs: Math.round(performance.now() - start), usage, servedBy: done.servedBy, answerChars: answer.length };
}

const paid = process.argv.includes('--paid');
const apiKey = process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY : null;
if (paid && !apiKey) throw new Error('--paid에는 ANTHROPIC_API_KEY가 필요하다(eval:faq-size:paid가 .env에서 읽는다)');
const engine = engineFactory(paid ? 'claude' : 'mock', apiKey)('sonnet');
const model = VARIANT_MODELS.sonnet;
const maxTokens = answerConfig('sonnet', undefined).maxTokens;
const price = priceOf(model);
if (!price) throw new Error(`가격표에 없는 모델: ${model}`);

const seeds = loadSeedFiles();
const [demo] = seeds;
if (!demo) throw new Error('데모 시드가 없다');
const base: KnowledgeSource[] = demo.knowledge.map((k) => ({ id: k.id, title: k.title, blocks: k.blocks }));
const pool = sentencePool(seeds);
const sets: FaqSet[] = [padFaqSet('demo', base, pool, null), padFaqSet('15k', base, pool, 15_000), padFaqSet('30k', base, pool, 30_000)];

// 실제 호출의 기록만 레포(docs)에 남긴다. 가짜 엔진으로 흐름을 볼 때는 운영체제 임시 폴더에 쓴다.
const runsDir = paid ? fileURLToPath(new URL('../../../docs/eval/faq-size/runs/', import.meta.url)) : path.join(tmpdir(), 'qrate-faq-size');
const out = path.join(runsDir, `${new Date().toISOString().replaceAll(':', '-')}${paid ? '' : '-dry'}.jsonl`);
const rows: CallRow[] = [];
let spentUsd = 0;
let stopped: string | null = null;

outer: for (const set of sets) {
  let firstUsage: Usage | null = null;
  const texts = set.items.flatMap((k) => [k.title, ...k.blocks]);
  for (let call = 1; call <= CALLS_PER_SIZE; call++) {
    const ceiling = firstUsage
      ? repeatCallCeilingUsd(firstUsage, price, maxTokens)
      : callCeilingUsd(model, { inputTokens: inputTokenBound(QUESTION, ...texts), maxTokens }, paid);
    const gate = nextCallAllowed({ calls: rows.length, spentUsd }, CAPS, paid ? ceiling : 0);
    if (!gate.ok) {
      stopped = `${set.label} ${call}번째 전: ${gate.reason}`;
      break outer;
    }
    const row: CallRow = { size: set.label, items: set.items.length, chars: set.chars, call, cache: 'none', ttftMs: null, totalMs: 0, usage: EMPTY_USAGE, servedBy: '', costUsd: 0, answerChars: 0 };
    try {
      Object.assign(row, await ask(engine, set.items));
    } catch (err) {
      // 실패한 호출도 돈이 들었을 수 있어 횟수에 넣고 멈춘다. 다시 시도하지 않는다(예산을 아낀다).
      rows.push(row);
      stopped = `${set.label} ${call}번째 실패: ${err instanceof EngineError ? err.code : err instanceof Error ? err.message : String(err)}`;
      break outer;
    }
    const billed = paid ? billingPrice(model, row.servedBy) : null;
    const cost = billed ? costUsd(billed, row.usage) : 0;
    spentUsd += cost;
    row.costUsd = Number(cost.toFixed(6));
    firstUsage ??= row.usage;
    rows.push(row);
    const { inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens } = row.usage;
    console.log(
      `[faq-size] ${set.label} ${row.items}개·${row.chars}자 #${call} ${row.cache} ttft=${row.ttftMs}ms total=${row.totalMs}ms ` +
        `in=${inputTokens} write=${cacheCreationInputTokens} read=${cacheReadInputTokens} out=${outputTokens} $${row.costUsd}`,
    );
  }
}

mkdirSync(runsDir, { recursive: true });
writeFileSync(out, `${rows.map((r) => JSON.stringify({ model: paid ? model : 'mock', ...r })).join('\n')}\n`);
console.log(`[faq-size] 호출 ${rows.length}회, 쓴 돈 $${spentUsd.toFixed(4)}(예산 $${CAPS.usd}, 상한 ${CAPS.calls}회)${stopped ? `. 멈춤: ${stopped}` : ''}`);
console.log(`[faq-size] 기록 ${out}`);
