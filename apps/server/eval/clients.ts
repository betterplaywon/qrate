import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, type AppConfig } from '../src/config.js';
import { ClaudeEngine } from '../src/engine/claude.js';
import type { AnswerEngine } from '../src/engine/types.js';
import { FakeJudgeClient, SyntheticUsageEngine } from './fakes.js';
import { ClaudeJudgeClient, type JudgeClient } from './judge.js';
import { VARIANT_MODELS, type Variant } from './models.js';

// 무엇을 부를지: 목업·가짜 대역 또는 실제 Claude. 실제 쪽은 운영 엔진(ClaudeEngine)을 운영 설정 그대로 쓴다.

/**
 * 답 단계의 엔진 설정. process.env를 펼치지 않고 필요한 값만 넘긴다 — .env의 다른 QRATE_* 값(사고 설정, max_tokens 등)이 섞이면
 * 비교하려던 운영 설정이 몰래 바뀐다. 나머지는 운영 기본값(서버 측 폴백 포함)이다.
 */
export function answerConfig(variant: Variant, apiKey: string | undefined): AppConfig {
  return loadConfig({ ANTHROPIC_API_KEY: apiKey, QRATE_ENGINE: 'claude', QRATE_MODEL: VARIANT_MODELS[variant], QRATE_THINKING: 'off' });
}

/** SDK의 자동 재시도(기본 2회)를 끈다 — 재시도는 이 도구가 세고 예산 장부에 남긴다. */
function anthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 0 });
}

export function engineFactory(kind: 'mock' | 'claude', apiKey: string | null): (variant: Variant) => AnswerEngine {
  if (kind === 'mock' || apiKey === null) {
    if (kind === 'claude') throw new Error('실제 엔진에는 ANTHROPIC_API_KEY가 필요하다');
    const engine = new SyntheticUsageEngine();
    return () => engine;
  }
  const client = anthropicClient(apiKey);
  const engines = new Map<Variant, AnswerEngine>();
  return (variant) => {
    const existing = engines.get(variant);
    if (existing) return existing;
    const engine = new ClaudeEngine(answerConfig(variant, apiKey), client);
    engines.set(variant, engine);
    return engine;
  };
}

export function judgeClientFor(kind: 'fake' | 'claude', apiKey: string | null): JudgeClient {
  if (kind === 'fake') return new FakeJudgeClient();
  if (apiKey === null) throw new Error('실제 심판에는 ANTHROPIC_API_KEY가 필요하다');
  return new ClaudeJudgeClient(anthropicClient(apiKey));
}
