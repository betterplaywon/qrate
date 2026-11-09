import { MOCK_SIGNATURE_HEADER } from '@qrate/contracts';
import { describe, expect, it } from 'vitest';
import { createMockProvider, signMockPayload } from '../src/billing/mock.js';
import type { WebhookRequest } from '../src/billing/provider.js';

const SECRET = 'mock-secret-0123456789abcdef';
const NOW = new Date('2026-11-05T03:00:00Z');
const T = Math.floor(NOW.getTime() / 1000);
const mock = createMockProvider(SECRET);
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

/** 웹훅 원문 → 거절 이유, 또는 read가 돌려준 사건. 모의 제공자는 서명이 맞으면 본문이 곧 결과다. */
async function verify(req: WebhookRequest, now: Date) {
  const notice = mock.readWebhook(req, now);
  if (!notice.ok) return notice;
  const reading = await notice.read();
  if (reading.kind !== 'event') throw new Error('모의 제공자의 읽음은 늘 사건이다');
  return { ok: true as const, event: reading.event };
}

function raw(body: unknown, t = T, secret = SECRET): WebhookRequest {
  const rawBody = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return { rawBody, headers: { [MOCK_SIGNATURE_HEADER]: signMockPayload(secret, rawBody, t) } };
}

const validBody = { id: 'evt-1', type: 'payment.paid', created: T, data: { orderId: 'order-1', amount: 10_000 } };

describe('모의 제공자 웹훅 서명', () => {
  it('서명이 맞으면 제공자 중립 이벤트가 된다. 이벤트 id 기본값은 evt_<주문>_<결과>', async () => {
    const paid = mock.signEvent({ orderId: 'order-1', amount: 10_000, result: 'paid' }, NOW);
    expect(mock.readWebhook(paid, NOW)).toMatchObject({ ok: true, orderId: 'order-1' });
    expect(await verify(paid, NOW)).toEqual({
      ok: true,
      event: { provider: 'mock', eventId: 'evt_order-1_paid', orderId: 'order-1', result: 'paid', amount: 10_000 },
    });
    const failed = mock.signEvent({ orderId: 'order-1', amount: 10_000, result: 'failed', eventId: 'evt-x' }, NOW);
    expect(await verify(failed, NOW)).toMatchObject({ ok: true, event: { eventId: 'evt-x', result: 'failed' } });
  });

  it('본문을 한 글자만 바꿔도(금액 변조) signature', async () => {
    const signed = mock.signEvent({ orderId: 'order-1', amount: 10_000, result: 'paid' }, NOW);
    const tampered = { ...signed, rawBody: Buffer.from(signed.rawBody.toString('utf8').replace('10000', '90000'), 'utf8') };
    expect(tampered.rawBody.equals(signed.rawBody)).toBe(false);
    expect(await verify(tampered, NOW)).toEqual({ ok: false, reason: 'signature' });
  });

  it('다른 비밀로 서명한 웹훅은 signature', async () => {
    const forged = createMockProvider('another-secret-0123456789').signEvent({ orderId: 'order-1', amount: 10_000, result: 'paid' }, NOW);
    expect(await verify(forged, NOW)).toEqual({ ok: false, reason: 'signature' });
  });

  it('서명 시각이 300초 안이면 통과, 301초 지났거나 301초 미래면 signature', async () => {
    const signed = raw(validBody);
    expect((await verify(signed, at(300))).ok).toBe(true);
    expect((await verify(signed, at(-300))).ok).toBe(true);
    expect(await verify(signed, at(301))).toEqual({ ok: false, reason: 'signature' });
    expect(await verify(signed, at(-301))).toEqual({ ok: false, reason: 'signature' });
  });

  it('헤더 없음 · 형식이 깨짐 · 두 번 옴 · 길이가 다른 v1은 모두 signature', async () => {
    const signed = raw(validBody);
    const header = signed.headers[MOCK_SIGNATURE_HEADER] as string;
    const variants: WebhookRequest['headers'][] = [
      {},
      { [MOCK_SIGNATURE_HEADER]: 'garbage' },
      { [MOCK_SIGNATURE_HEADER]: header.replace('t=', 'ts=') },
      { [MOCK_SIGNATURE_HEADER]: [header, header] },
      { [MOCK_SIGNATURE_HEADER]: header.slice(0, -2) },
      { [MOCK_SIGNATURE_HEADER]: `${header}00` },
      { [MOCK_SIGNATURE_HEADER]: header.toUpperCase() },
    ];
    for (const headers of variants) {
      expect(await verify({ rawBody: signed.rawBody, headers }, NOW), JSON.stringify(headers)).toEqual({
        ok: false,
        reason: 'signature',
      });
    }
  });

  it('서명은 맞는데 JSON이 아니거나 모양이 다르면 malformed', async () => {
    for (const body of [
      'not json',
      { ...validBody, type: 'payment.refunded' },
      { ...validBody, data: { orderId: 'order-1', amount: '10000' } },
      { ...validBody, id: '' },
      { type: 'payment.paid', data: validBody.data },
    ]) {
      expect(await verify(raw(body), NOW), JSON.stringify(body)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('본문의 여분 필드(tenantId)는 이벤트에 실리지 않는다 — 테넌트는 주문에서만 나온다', async () => {
    const result = await verify(raw({ ...validBody, tenantId: 'someone-else' }), NOW);
    expect(result).toEqual({
      ok: true,
      event: { provider: 'mock', eventId: 'evt-1', orderId: 'order-1', result: 'paid', amount: 10_000 },
    });
  });
});
