import { GREETING_PATH, type GreetingResponse } from '@qrate/contracts';

// 대화창이 처음 뜰 때 서버가 배정한 인사말을 묻는다(GET /api/greeting). DOM을 모른다.

export interface Greeting {
  variant: string;
  text: string;
}

export interface GreetingOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** 첫 열림 사건이 인사말을 기다리는 상한. 넘으면 인사말 없이 연다(그 페이지 로드는 실험 밖이 된다). */
const GREETING_TIMEOUT_MS = 3_000;

/**
 * 인사말이 있으면 Greeting, 그 밖의 모든 경우(실험 없음, 4xx·5xx, JSON 아님, 모양 틀림, 네트워크 실패, 시간 초과)는 null. 던지지 않는다.
 * 인사말은 꾸밈이라 없어도 대화창은 그대로 동작한다. 실패는 상한을 기다리지 않고 바로 끝난다.
 */
export async function fetchGreeting(query: { tenant: string; variant: string | null }, opts: GreetingOptions = {}): Promise<Greeting | null> {
  const params = new URLSearchParams({ tenant: query.tenant });
  if (query.variant) params.set('variant', query.variant);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GREETING_TIMEOUT_MS);
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl ?? ''}${GREETING_PATH}?${params}`, { signal: controller.signal });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const greeting = (body as Partial<GreetingResponse> | null)?.greeting;
    return greeting && typeof greeting.variant === 'string' && typeof greeting.text === 'string' && greeting.text
      ? { variant: greeting.variant, text: greeting.text }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
