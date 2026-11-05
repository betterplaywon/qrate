import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGreeting } from '../src/frame/greeting';

function fake(respond: (init: RequestInit | undefined) => Promise<Response>) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: new URL(String(input), 'http://frame.test'), init });
    return respond(init);
  };
  return { fetchImpl, calls };
}

/** 서버가 답하지 않는 요청. 대화창이 끊으면(abort) 그때 실패한다. */
const hanging = (init: RequestInit | undefined) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchGreeting', () => {
  it('GET /api/greeting에 테넌트와 보존된 변형을 싣고, 인사말이 있으면 { variant, text }', async () => {
    const { fetchImpl, calls } = fake(async () => Response.json({ greeting: { variant: 'exp.b', text: '나' } }));
    expect(await fetchGreeting({ tenant: 'demo', variant: 'exp.b' }, { fetchImpl })).toEqual({ variant: 'exp.b', text: '나' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe('/api/greeting');
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ tenant: 'demo', variant: 'exp.b' });
  });

  it('보존된 변형이 없으면 variant를 싣지 않는다', async () => {
    const { fetchImpl, calls } = fake(async () => Response.json({ greeting: { variant: 'exp.a', text: '가' } }));
    await fetchGreeting({ tenant: 'demo', variant: null }, { fetchImpl });
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ tenant: 'demo' });
  });

  it('실험이 꺼져 있으면({ greeting: null }) null', async () => {
    const { fetchImpl } = fake(async () => Response.json({ greeting: null }));
    expect(await fetchGreeting({ tenant: 'demo', variant: null }, { fetchImpl })).toBeNull();
  });

  it('실패는 상한을 기다리지 않고 바로 null — 404·500·JSON 아님·모양 틀림·네트워크 실패', async () => {
    vi.useFakeTimers();
    const failures: (() => Promise<Response>)[] = [
      async () => Response.json({ error: 'unknown_tenant' }, { status: 404 }),
      async () => new Response('oops', { status: 500 }),
      async () => new Response('<html>', { status: 200 }),
      async () => Response.json(null),
      async () => Response.json({ greeting: 'b' }),
      async () => Response.json({ greeting: { variant: 2, text: '나' } }),
      async () => Response.json({ greeting: { variant: 'exp.b', text: '' } }),
      async () => {
        throw new TypeError('Failed to fetch');
      },
    ];
    for (const respond of failures) {
      const { fetchImpl } = fake(respond);
      expect(await fetchGreeting({ tenant: 'demo', variant: null }, { fetchImpl })).toBeNull();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('3초 안에 답이 없으면 요청을 끊고 null — 그 페이지 로드는 인사말 없이 연다', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = fake(hanging);
    let settled = false;
    const result = fetchGreeting({ tenant: 'demo', variant: null }, { fetchImpl }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeNull();
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
  });
});
