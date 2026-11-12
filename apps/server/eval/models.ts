import type { Usage } from '../src/engine/types.js';

// 평가에 나오는 모델의 사실: 비교할 변형, 심판, 가격, "같은 모델이 답했는가"의 판정.

export const VARIANTS = ['sonnet', 'haiku'] as const;
export type Variant = (typeof VARIANTS)[number];

export const VARIANT_MODELS: Readonly<Record<Variant, string>> = {
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

export const JUDGE_MODEL = 'claude-opus-5-5';

export interface Price {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

// 백만 토큰당 달러. 출처: https://platform.claude.com/docs/en/about-claude/pricing (2026-11-11 확인).
// 캐시 쓰기는 5분짜리 값이다 — 엔진과 심판 모두 ephemeral 기본 TTL만 쓴다. Haiku 5.5는 프롬프트 10만 토큰 이하 가격이고, 이 평가의 프롬프트는 그보다 훨씬 짧다.
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
};

const MOST_EXPENSIVE: Price = Object.values(PRICES).reduce((a, b) => (b.output > a.output ? b : a));

/**
 * 바이트로 센 본문 밖의 토큰(시스템 지시, 도구 정의, 역할 표시, search_result 구조)의 몫. 바이트로 센 본문 위에 더한다.
 * 시스템 지시와 도구 정의만 2,218토큰으로 쟀다(2026-11-12 FAQ 크기 실측, docs/eval/faq-size). 상한이 되려면 그보다 커야 해서 넉넉히 둔다.
 */
const PROMPT_OVERHEAD_TOKENS = 4096;

export function priceOf(model: string): Price | null {
  return PRICES[model] ?? null;
}

export function costUsd(price: Price, usage: Usage): number {
  return (
    (usage.inputTokens * price.input +
      usage.cacheCreationInputTokens * price.cacheWrite +
      usage.cacheReadInputTokens * price.cacheRead +
      usage.outputTokens * price.output) /
    1_000_000
  );
}

/** 응답의 model이 요청한 모델인가. 날짜가 붙은 스냅숏 id(요청-YYYYMMDD)도 같은 모델로 본다. */
export function servedByMatches(requested: string, servedBy: string): boolean {
  if (servedBy === requested) return true;
  return servedBy.startsWith(`${requested}-`) && /^\d{8}$/.test(servedBy.slice(requested.length + 1));
}

/** 측정한 사용량을 어느 모델 가격으로 셀까. 다른 모델이 답했으면(폴백) 그 모델 가격, 모르는 모델이면 표에서 가장 비싼 가격으로 센다. */
export function billingPrice(requested: string, servedBy: string | null): Price | null {
  if (servedBy === null || servedByMatches(requested, servedBy)) return priceOf(requested);
  return priceOf(servedBy) ?? MOST_EXPENSIVE;
}

/** 입력 토큰의 상한. 토큰 하나는 1바이트 이상이므로 UTF-8 바이트 수가 상한이다. */
export function inputTokenBound(...parts: string[]): number {
  return parts.reduce((sum, part) => sum + Buffer.byteLength(part, 'utf8'), 0) + PROMPT_OVERHEAD_TOKENS;
}

/**
 * 아직 사용량을 모르는 호출 1건의 비용 상한: 입력 전부를 가장 비싼 입력 단가(캐시 쓰기)로, 출력은 max_tokens 전부로 친다.
 * 실제 호출인데 가격을 모르는 모델이면 상한을 낼 수 없으니 시작하지 않는다.
 */
export function callCeilingUsd(model: string, bound: { inputTokens: number; maxTokens: number }, billable: boolean): number {
  const price = priceOf(model);
  if (!price) {
    if (billable) throw new Error(`가격표에 없는 모델이라 비용 상한을 잡을 수 없다: ${model}`);
    return 0;
  }
  return (bound.inputTokens * Math.max(price.input, price.cacheWrite) + bound.maxTokens * price.output) / 1_000_000;
}
