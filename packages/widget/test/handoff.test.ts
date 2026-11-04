import { describe, expect, it } from 'vitest';
import { requestHandoff } from '../src/frame/handoff';

// 상담원 연결 요청(POST /api/handoff)의 결과 해석을 고정한다. fetch를 가짜로 바꿔 서버 없이 돌린다.

function fake(res: Response | Error): { fetchImpl: typeof fetch; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body) });
    if (res instanceof Error) throw res;
    return res;
  };
  return { fetchImpl, calls };
}

const body = { tenant: 'demo', conversationId: null, contact: 'v@example.com', message: '전화 주세요' };

describe('requestHandoff', () => {
  it('201이면 id와 대화 id를 돌려주고, 요청은 /api/handoff에 JSON으로 간다', async () => {
    const { fetchImpl, calls } = fake(Response.json({ id: 'h1', conversationId: 'c1' }, { status: 201 }));
    expect(await requestHandoff(body, { fetchImpl })).toEqual({ ok: true, id: 'h1', conversationId: 'c1' });
    expect(calls[0]?.url).toBe('/api/handoff');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(body);
  });

  it('4xx·5xx는 계약의 오류 코드를, 본문이 JSON이 아니면 코드 없이 상태만 돌려준다', async () => {
    const { fetchImpl } = fake(Response.json({ error: 'invalid_contact' }, { status: 400 }));
    expect(await requestHandoff(body, { fetchImpl })).toEqual({ ok: false, status: 400, code: 'invalid_contact' });
    const html = fake(new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    expect(await requestHandoff(body, { fetchImpl: html.fetchImpl })).toEqual({ ok: false, status: 502, code: null });
  });

  it('닿지 못하면 상태도 코드도 없다. 200인데 모양이 다르면 실패로 본다', async () => {
    const down = fake(new TypeError('Failed to fetch'));
    expect(await requestHandoff(body, { fetchImpl: down.fetchImpl })).toEqual({ ok: false, status: null, code: null });
    const odd = fake(Response.json({ hello: 'world' }, { status: 200 }));
    expect(await requestHandoff(body, { fetchImpl: odd.fetchImpl })).toEqual({ ok: false, status: 200, code: null });
  });
});
