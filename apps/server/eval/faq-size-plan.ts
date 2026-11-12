import { KNOWLEDGE_LIMITS, knowledgeChars } from '@qrate/contracts';
import { knowledgeInputSchema } from '@qrate/contracts/schemas';
import type { KnowledgeSource, Usage } from '../src/engine/types.js';
import type { SeedFile } from '../src/repo/seed.js';
import type { Price } from './models.js';

// FAQ 크기 실측(eval/faq-size.ts)의 순수 계산: 크기별 FAQ 묶음과 호출 전 비용 상한 판정. 비용 없이 시험한다(test/eval-faq-size.test.ts).

export interface FaqSet {
  label: string;
  items: KnowledgeSource[];
  /** 콘솔 상한이 세는 양(제목·문단 코드 포인트 합, knowledgeChars). */
  chars: number;
}

/** 채운 항목이 쓸 문장. 데모 두 회사의 실제 문단을 돌려 써서 토큰 비율이 실제 한국어 FAQ와 같게 한다. */
export function sentencePool(seeds: readonly SeedFile[]): string[] {
  return seeds.flatMap((seed) => seed.knowledge.flatMap((k) => k.blocks));
}

/** 한 문단이 상한(blockChars)을 넘지 않게 공백에서 나눈다. */
function toBlocks(text: string, max: number): string[] {
  const blocks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf(' ', max);
    const at = cut > 0 ? cut : max;
    blocks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) blocks.push(rest);
  return blocks;
}

/**
 * 기본 FAQ(데모 회사 그대로)에 "추가 안내" 항목을 더해 전체 글자가 target에 닿게 한다. 항목 수는 상한(50개)까지 쓰고,
 * 항목마다 문단은 상한(10개 × 1,000자) 안이다. 콘솔이 받는 모양인지 knowledgeInputSchema로 확인한다.
 */
export function padFaqSet(label: string, base: readonly KnowledgeSource[], pool: readonly string[], target: number | null): FaqSet {
  const items: KnowledgeSource[] = base.map((k) => ({ id: k.id, title: k.title, blocks: [...k.blocks] }));
  let chars = items.reduce((sum, k) => sum + knowledgeChars(k), 0);
  if (target !== null) {
    if (target < chars) throw new Error(`${label}: 목표 ${target}자가 기본 FAQ ${chars}자보다 작다`);
    const slots = KNOWLEDGE_LIMITS.items - items.length;
    let next = 0;
    for (let i = 0; i < slots; i++) {
      const title = `추가 안내 ${String(i + 1).padStart(2, '0')}`;
      const quota = Math.floor((target - chars) / (slots - i)) - title.length;
      if (quota < 1) break;
      let text = '';
      while (text.length < quota) {
        const sentence = pool[next++ % pool.length] ?? '';
        text = text ? `${text} ${sentence}` : sentence;
      }
      const blocks = toBlocks(text.slice(0, quota).trim(), KNOWLEDGE_LIMITS.blockChars);
      const item = { id: `faq:pad-${String(i + 1).padStart(2, '0')}`, title, blocks };
      items.push(item);
      chars += knowledgeChars(item);
    }
  }
  for (const item of items) {
    const parsed = knowledgeInputSchema.safeParse({ title: item.title, category: '안내', blocks: item.blocks });
    if (!parsed.success) throw new Error(`${label}: ${item.id}가 콘솔 상한을 넘는다 — ${parsed.error.issues[0]?.message ?? ''}`);
  }
  if (items.length > KNOWLEDGE_LIMITS.items || chars > KNOWLEDGE_LIMITS.totalChars) {
    throw new Error(`${label}: ${items.length}개·${chars}자로 콘솔 상한(${KNOWLEDGE_LIMITS.items}개·${KNOWLEDGE_LIMITS.totalChars}자)을 넘는다`);
  }
  return { label, items, chars };
}

export interface Caps {
  calls: number;
  usd: number;
}

/**
 * 다음 호출을 해도 되는가. 같은 프롬프트를 한 번 불렀으면 그때 잰 입력 토큰 전부를 가장 비싼 입력 단가(캐시 쓰기)로,
 * 출력은 max_tokens 전부로 친 값이 그 호출의 상한이다(캐시를 못 맞혀도 넘지 않는다). 처음 부르는 프롬프트는 바이트로 잡은 상한을 쓴다.
 */
export function nextCallAllowed(
  state: { calls: number; spentUsd: number },
  caps: Caps,
  ceilingUsd: number,
): { ok: true } | { ok: false; reason: string } {
  if (state.calls >= caps.calls) return { ok: false, reason: `호출 상한 ${caps.calls}회에 닿았다` };
  if (state.spentUsd + ceilingUsd > caps.usd) {
    return { ok: false, reason: `쓴 돈 $${state.spentUsd.toFixed(4)} + 다음 호출 상한 $${ceilingUsd.toFixed(4)}이 예산 $${caps.usd}를 넘는다` };
  }
  return { ok: true };
}

/** 같은 프롬프트를 다시 부를 때의 상한. measured는 그 프롬프트의 첫 호출에서 잰 사용량이다. */
export function repeatCallCeilingUsd(measured: Usage, price: Price, maxTokens: number): number {
  const inputTokens = measured.inputTokens + measured.cacheCreationInputTokens + measured.cacheReadInputTokens;
  return (inputTokens * price.cacheWrite + maxTokens * price.output) / 1_000_000;
}
