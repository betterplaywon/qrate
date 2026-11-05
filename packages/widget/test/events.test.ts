import { describe, expect, it } from 'vitest';
import { sendWidgetEvent } from '../src/frame/events';

function fake(res: Response | Error): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (res instanceof Error) throw res;
    return res;
  };
  return { fetchImpl, calls };
}

describe('sendWidgetEvent', () => {
  it('/api/events에 JSON POST, 페이지를 떠나도 끝까지 가게 keepalive', async () => {
    const { fetchImpl, calls } = fake(new Response(null, { status: 202 }));
    await sendWidgetEvent({ tenant: 'demo', type: 'widget_open' }, { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/events');
    expect(calls[0]?.init).toMatchObject({ method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ tenant: 'demo', type: 'widget_open' });
  });

  it('닿지 못하거나 서버가 거절해도 던지지 않는다', async () => {
    const down = fake(new TypeError('Failed to fetch'));
    await expect(sendWidgetEvent({ tenant: 'demo', type: 'widget_open' }, { fetchImpl: down.fetchImpl })).resolves.toBeUndefined();
    const limited = fake(Response.json({ error: 'too_many_requests' }, { status: 429 }));
    await expect(sendWidgetEvent({ tenant: 'demo', type: 'widget_open' }, { fetchImpl: limited.fetchImpl })).resolves.toBeUndefined();
  });
});
