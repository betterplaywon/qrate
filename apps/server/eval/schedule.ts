import { asEngineError, type EngineErrorCode, type Usage } from '../src/engine/types.js';
import type { ErrorClass } from './records.js';

// 호출을 어떻게 돌리는가: 동시 실행 상한, 재시도, 실패의 분류. 답 단계와 심판 단계가 같은 규칙을 쓴다.

export interface Failure {
  class: ErrorClass;
  message: string;
  usage: Usage | null;
  /** 같은 실행 안에서 다시 시도해도 되는가(재시도 가능한 엔진 오류만). */
  retryable: boolean;
}

/** 시도 한 번의 결과. refused = 예산 관문이 막아 호출을 시작하지 않음. */
export type Attempt<T> = { kind: 'value'; value: T } | { kind: 'failure'; failure: Failure } | { kind: 'refused'; reason: string };

export interface RetryPolicy {
  maxAttempts: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

/** 첫 조각 전에 이 코드로 실패한 요청은 과금되지 않는다(요율 제한·서버 오류·인증·잘못된 요청). */
const REJECTED_UPFRONT: ReadonlySet<EngineErrorCode> = new Set(['rate_limited', 'upstream_unavailable', 'upstream_auth', 'upstream_bad_request']);

/** 2초·4초…를 기준으로 절반~전부 사이에서 고른다 — 같은 순간 실패한 호출들이 같은 순간 다시 몰리지 않게. */
export function backoffMs(failedAttempt: number, random: () => number): number {
  return Math.round(2000 * 2 ** (failedAttempt - 1) * (0.5 + random() / 2));
}

/** 재시도 가능한 실패면 기다렸다 다시, 아니면 그 결과로 끝낸다. lastFailure는 관문이 재시도를 막았을 때 기록할 직전 실패다. */
export async function retrying<T>(
  policy: RetryPolicy,
  run: (attempt: number) => Promise<Attempt<T>>,
): Promise<{ result: Attempt<T>; lastFailure: Failure | null }> {
  let lastFailure: Failure | null = null;
  for (let attempt = 1; ; attempt += 1) {
    const result = await run(attempt);
    if (result.kind !== 'failure' || !result.failure.retryable || attempt >= policy.maxAttempts) return { result, lastFailure };
    lastFailure = result.failure;
    await policy.sleep(backoffMs(attempt, policy.random));
  }
}

/** 호출이 던진 예외를 실패와 과금 여부로 옮긴다. 시간 초과는 과금됐을 수 있고 같은 실행에서 다시 시도하지 않는다. */
export function classifyThrown(
  err: unknown,
  ctx: { timedOut: boolean; sawOutput: boolean; timeoutMs: number },
): { failure: Failure; billing: 'none' | 'unknown' } {
  if (ctx.timedOut) {
    return { failure: { class: 'timeout', message: `${ctx.timeoutMs}ms 안에 끝나지 않음`, usage: null, retryable: false }, billing: 'unknown' };
  }
  const e = asEngineError(err);
  return {
    failure: { class: 'serving', message: `${e.code}: ${e.message}`, usage: null, retryable: e.retryable },
    billing: !ctx.sawOutput && REJECTED_UPFRONT.has(e.code) ? 'none' : 'unknown',
  };
}

/**
 * 동시 실행 상한 안에서 항목을 차례로 처리한다. 일이 'stop'을 돌려주면 새 항목을 꺼내지 않는다(진행 중인 것은 끝까지 간다).
 * warmFirst: 첫 항목을 혼자 먼저 끝낸다 — 동시에 출발한 첫 호출들이 저마다 프롬프트 캐시를 쓰는 비용을 한 번으로 줄인다.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<'continue' | 'stop'>,
  opts: { warmFirst?: boolean } = {},
): Promise<{ started: number; stopped: boolean }> {
  let next = 0;
  let stopped = false;
  const take = (): T | undefined => (stopped || next >= items.length ? undefined : items[next++]);
  const drain = async (): Promise<void> => {
    for (let item = take(); item !== undefined; item = take()) {
      if ((await work(item)) === 'stop') stopped = true;
    }
  };
  if (opts.warmFirst) {
    const first = take();
    if (first !== undefined && (await work(first)) === 'stop') stopped = true;
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, drain));
  return { started: next, stopped };
}
