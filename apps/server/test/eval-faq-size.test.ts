import { KNOWLEDGE_LIMITS, knowledgeChars } from '@qrate/contracts';
import { describe, expect, it } from 'vitest';
import { nextCallAllowed, padFaqSet, repeatCallCeilingUsd, sentencePool } from '../eval/faq-size-plan.js';
import { PRICES } from '../eval/models.js';
import { loadSeedFiles } from '../src/repo/seed.js';

// FAQ 크기 실측(eval/faq-size.ts)의 순수 계산. 실제 호출 없이 FAQ 묶음이 콘솔 상한 안에서 목표 크기에 닿는지,
// 호출 전 판정이 예산을 넘는 호출을 막는지 본다.

const seeds = loadSeedFiles();
const demo = seeds[0];
if (!demo) throw new Error('데모 시드가 없다');
const base = demo.knowledge.map((k) => ({ id: k.id, title: k.title, blocks: k.blocks }));
const pool = sentencePool(seeds);

describe('FAQ 묶음 만들기', () => {
  it('목표가 없으면 데모 FAQ 그대로다', () => {
    const set = padFaqSet('demo', base, pool, null);
    expect(set.items).toHaveLength(base.length);
    expect(set.chars).toBe(base.reduce((sum, k) => sum + knowledgeChars(k), 0));
  });

  it.each([KNOWLEDGE_LIMITS.totalChars, 30_000])('목표 %i자면 항목을 상한(50개)까지 채워 목표에 거의 닿고, 항목·문단은 콘솔 상한을 지킨다', (target) => {
    const set = padFaqSet(`t${target}`, base, pool, target);
    expect(set.items).toHaveLength(KNOWLEDGE_LIMITS.items);
    expect(set.chars).toBeLessThanOrEqual(target);
    expect(set.chars).toBeGreaterThan(target - 100);
    expect(set.chars).toBe(set.items.reduce((sum, k) => sum + knowledgeChars(k), 0));
    expect(new Set(set.items.map((k) => k.id)).size).toBe(set.items.length);
    for (const item of set.items) {
      expect(item.blocks.length).toBeGreaterThan(0);
      expect(item.blocks.length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.blocks);
      expect(Math.max(...item.blocks.map((b) => b.length))).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.blockChars);
    }
  });

  it('목표가 기본 FAQ보다 작으면 시작하지 않는다', () => {
    expect(() => padFaqSet('small', base, pool, 100)).toThrow(/기본 FAQ/);
  });
});

describe('호출 전 판정', () => {
  const caps = { calls: 12, usd: 0.5 };

  it('호출 수가 상한에 닿거나, 쓴 돈과 다음 호출의 상한을 더한 값이 예산을 넘으면 막는다', () => {
    expect(nextCallAllowed({ calls: 0, spentUsd: 0 }, caps, 0.2)).toEqual({ ok: true });
    expect(nextCallAllowed({ calls: 12, spentUsd: 0 }, caps, 0)).toMatchObject({ ok: false, reason: expect.stringMatching(/12회/) });
    expect(nextCallAllowed({ calls: 3, spentUsd: 0.35 }, caps, 0.16)).toMatchObject({ ok: false, reason: expect.stringMatching(/예산/) });
    expect(nextCallAllowed({ calls: 3, spentUsd: 0.35 }, caps, 0.15)).toEqual({ ok: true });
  });

  it('같은 프롬프트를 다시 부를 때의 상한은 잰 입력 토큰 전부를 캐시 쓰기 단가로, 출력은 max_tokens 전부로 친다', () => {
    const price = PRICES['claude-sonnet-5-5'];
    if (!price) throw new Error('가격표에 Sonnet 5.5가 없다');
    const measured = { inputTokens: 100, cacheCreationInputTokens: 60_000, cacheReadInputTokens: 900, outputTokens: 170 };
    // (61,000 × 2.5 + 1,024 × 10) / 1,000,000
    expect(repeatCallCeilingUsd(measured, price, 1024)).toBeCloseTo(0.16274, 5);
  });
});
