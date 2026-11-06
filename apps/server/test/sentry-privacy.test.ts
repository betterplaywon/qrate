import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashConsoleKey } from '../src/console/key.js';
import { MockEngine } from '../src/engine/mock.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from '../src/repo/seed.js';
import { Sentry, sentryOptions } from '../src/sentry.js';

// Sentry가 실제로 받는 envelope에 방문자 메시지·콘솔 로그인 키·세션 쿠키가 없는지 본다.
// SDK 기본값은 요청 본문·쿠키·헤더를 오류 이벤트와 트랜잭션(span 속성 포함)에 붙인다. 운영 설정(sentryOptions)이 그것을 막는지가 이 테스트의 대상이다.

const OWN_ORIGIN = 'http://sentry.test';
const VISITOR_MARKER = 'VISITOR-MESSAGE-MARKER';
const COOKIE_MARKER = 'COOKIE-MARKER';
const CONSOLE_KEY = 'CONSOLE-KEY-MARKER-0001';
const frameAssetsDir = mkdtempSync(path.join(tmpdir(), 'qrate-sentry-'));
const envelopes: string[] = [];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  Sentry.init({
    ...sentryOptions('http://public@127.0.0.1:9/1', 'test'),
    // 모든 요청을 트랜잭션으로 남겨 본문·쿠키가 span에 실리는지까지 본다.
    tracesSampleRate: 1,
    transport: (options) =>
      Sentry.createTransport(options, async (request) => {
        envelopes.push(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body));
        return { statusCode: 200 };
      }),
  });
  const repos = createRepositoriesFromSeed(loadSeedFile(DEFAULT_SEED_PATH), { consoleKeyHash: hashConsoleKey(CONSOLE_KEY) });
  const app = createApp({
    engine: new MockEngine(0),
    repos,
    publicOrigin: OWN_ORIGIN,
    frameAssetsDir,
    reportError: (err, context) => void Sentry.captureException(err, { extra: context }),
    console: { secret: 'test-secret-0123456789abcdef' },
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await Sentry.close(2000);
  rmSync(frameAssetsDir, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function itemsOf(type: string): string[] {
  return envelopes.flatMap((envelope) => {
    const lines = envelope.split('\n');
    const payloads: string[] = [];
    for (let i = 1; i + 1 < lines.length; i += 2) {
      if ((JSON.parse(lines[i]!) as { type?: string }).type === type) payloads.push(lines[i + 1]!);
    }
    return payloads;
  });
}

describe('Sentry로 가는 데이터', () => {
  it('엔진 실패 보고에 방문자 메시지와 쿠키가 없다', async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: OWN_ORIGIN, cookie: `qrate_console=${COOKIE_MARKER}` },
      body: JSON.stringify({ tenant: 'demo', message: `${VISITOR_MARKER} [[fail:401]]` }),
    });
    expect(res.status).toBe(502);
    await Sentry.flush(2000);

    const events = itemsOf('event');
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('upstream_auth');
    expect(events[0]).not.toContain(VISITOR_MARKER);
    expect(events[0]).not.toContain(COOKIE_MARKER);
  });

  it('콘솔 로그인 키와 세션 쿠키가 트랜잭션에 없다', async () => {
    const login = await fetch(`${baseUrl}/api/console/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
      body: JSON.stringify({ tenant: 'demo', key: CONSOLE_KEY }),
    });
    expect(login.status).toBe(200);
    const session = login.headers.get('set-cookie')!.split(';')[0]!;
    const me = await fetch(`${baseUrl}/api/console/me`, { headers: { cookie: session } });
    expect(me.status).toBe(200);
    await Sentry.flush(2000);

    const transactions = itemsOf('transaction');
    expect(transactions.some((t) => t.includes('/api/console/login'))).toBe(true);
    expect(transactions.some((t) => t.includes('/api/console/me'))).toBe(true);
    for (const t of transactions) {
      expect(t).not.toContain(CONSOLE_KEY);
      expect(t).not.toContain(session.split('=')[1]);
      expect(t).not.toContain(VISITOR_MARKER);
      expect(t).not.toContain(COOKIE_MARKER);
    }
  });
});
