import { CHAT_PATH } from '@qrate/contracts';
import { describe, expect, it } from 'vitest';
import { MockEngine } from '../src/engine/mock.js';
import type { AppEvent } from '../src/repo/types.js';
import { startApp } from './helpers/app.js';
import { CapturingEngine } from './helpers/capturing-engine.js';

// POST /api/chat의 IP당 요율 제한. 앱마다 카운터가 따로라 테스트마다 작은 한도로 새로 띄운다.

const OWN_ORIGIN = 'http://widget.test';

async function serveWithLimit(max: number) {
  const engine = new CapturingEngine(new MockEngine(0));
  const recorded: AppEvent[] = [];
  const { url, close } = await startApp({
    engine,
    publicOrigin: OWN_ORIGIN,
    recordEvent: (event) => recorded.push(event),
    chatRequests: { max, windowMs: 60_000 },
  });
  const send = async (message: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}${CHAT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ message, tenant: 'demo' }),
    });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.text() };
  };
  return { engine, recorded, send, close };
}

describe('POST /api/chat — IP당 요율 제한', () => {
  it('창 안에서 한도를 넘은 요청은 429 too_many_requests + Retry-After이고, 엔진을 부르지 않고 사건도 남기지 않는다', async () => {
    const { engine, recorded, send, close } = await serveWithLimit(2);
    try {
      // 대화창(같은 오리진)과 브라우저 밖(Origin 없음)이 같은 IP 한도를 나눠 쓴다
      expect((await send('요금제가 뭐가 있나요?', { origin: OWN_ORIGIN })).status).toBe(200);
      expect((await send('환불되나요?')).status).toBe(200);
      await expect.poll(() => recorded.length).toBe(2);

      const limited = await send('또 물어볼게요');
      expect(limited.status).toBe(429);
      expect(JSON.parse(limited.body)).toEqual({ error: 'too_many_requests' });
      const retryAfter = Number(limited.retryAfter);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);

      expect(engine.requests).toHaveLength(2);
      expect(recorded.map((e) => e.payload.outcome)).toEqual(['done', 'done']);
    } finally {
      await close();
    }
  });

  it('다른 오리진의 403은 본문을 읽기 전에 끊겨 한도를 쓰지 않는다', async () => {
    const { send, close } = await serveWithLimit(2);
    try {
      for (let i = 0; i < 3; i += 1) expect((await send('안녕', { origin: 'https://evil.example' })).status).toBe(403);
      expect((await send('환불되나요?')).status).toBe(200);
      expect((await send('환불되나요?')).status).toBe(200);
      expect((await send('환불되나요?')).status).toBe(429);
    } finally {
      await close();
    }
  });

  it('모더레이션 차단(422)도 한도를 쓴다 — 모델은 부르지 않아도 공개 키로 반복하기 가장 싼 요청이다', async () => {
    const { engine, send, close } = await serveWithLimit(2);
    try {
      expect((await send('씨발 환불해줘')).status).toBe(422);
      expect((await send('씨발 환불해줘')).status).toBe(422);
      expect((await send('요금제가 뭐가 있나요?')).status).toBe(429);
      expect(engine.requests).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
