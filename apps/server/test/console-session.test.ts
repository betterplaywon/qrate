import { describe, expect, it } from 'vitest';
import { MIN_SECRET_LENGTH, SESSION_TTL_MS, createSessionCodec } from '../src/console/session.js';

const SECRET = 'test-secret-0123456789abcdef';

describe('콘솔 세션 토큰(JWT, HS256)', () => {
  it('발급한 토큰은 같은 비밀로만 검증되고, 내용은 테넌트 id·발급·만료 시각이다', async () => {
    const codec = createSessionCodec(SECRET);
    const now = new Date('2026-11-04T12:00:00Z');
    const token = await codec.issue('demo', now);
    expect(token.split('.')).toHaveLength(3);
    expect(await codec.verify(token, new Date(now.getTime() + 1000))).toEqual({
      tenantId: 'demo',
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + SESSION_TTL_MS,
    });
    expect(await createSessionCodec('another-secret-0123456789').verify(token, now)).toBeNull();
  });

  it('만료되면 null — 만료 시각 그 자체도 지난 것으로 본다', async () => {
    const codec = createSessionCodec(SECRET, 1000);
    const issued = new Date('2026-11-04T12:00:00Z');
    const token = await codec.issue('demo', issued);
    expect(await codec.verify(token, new Date(issued.getTime() + 999))).not.toBeNull();
    expect(await codec.verify(token, new Date(issued.getTime() + 1000))).toBeNull();
  });

  it('한 글자만 바꿔도, 서명 없이 내용만 바꿔도, 알고리즘을 none으로 바꿔도, 모양이 다르면 모두 null', async () => {
    const codec = createSessionCodec(SECRET);
    const token = await codec.issue('demo');
    const [header, payload, sig] = token.split('.') as [string, string, string];
    const flipped = (s: string) => s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
    expect(await codec.verify(`${header}.${flipped(payload)}.${sig}`)).toBeNull();
    expect(await codec.verify(`${header}.${payload}.${flipped(sig)}`)).toBeNull();
    // 다른 테넌트로 바꿔 쓴 payload — 서명이 안 맞는다
    const forged = Buffer.from(JSON.stringify({ sub: 'other', iat: 0, exp: 4102444800 })).toString('base64url');
    expect(await codec.verify(`${header}.${forged}.${sig}`)).toBeNull();
    // alg: none — 서명 없는 토큰은 algorithms 고정 때문에 거부된다
    const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    expect(await codec.verify(`${none}.${forged}.`)).toBeNull();
    expect(await codec.verify('')).toBeNull();
    expect(await codec.verify('no-dot')).toBeNull();
    expect(await codec.verify(`${header}.${payload}`)).toBeNull();
  });

  it('짧은 비밀은 거부한다', () => {
    expect(() => createSessionCodec('x'.repeat(MIN_SECRET_LENGTH - 1))).toThrow(/at least/);
    expect(() => createSessionCodec('x'.repeat(MIN_SECRET_LENGTH))).not.toThrow();
  });
});
