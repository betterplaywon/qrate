import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashConsoleKey } from '../src/console/key.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from '../src/repo/seed.js';
import { Sentry, sentryOptions } from '../src/sentry.js';
import { startApp } from './helpers/app.js';

const OWN_ORIGIN = 'http://sentry.test';
const VISITOR_MARKER = 'VISITOR-MESSAGE-MARKER';
const COOKIE_MARKER = 'COOKIE-MARKER';
const CONSOLE_KEY = 'CONSOLE-KEY-MARKER-0001';
const envelopes: string[] = [];

let baseUrl: string;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  Sentry.init({
    ...sentryOptions('http://public@127.0.0.1:9/1', 'test'),
    tracesSampleRate: 1,
    transport: (options) =>
      Sentry.createTransport(options, async (request) => {
        envelopes.push(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body));
        return { statusCode: 200 };
      }),
  });
  ({ url: baseUrl, close: closeApp } = await startApp({
    repos: createRepositoriesFromSeed(loadSeedFile(DEFAULT_SEED_PATH), { consoleKeyHash: hashConsoleKey(CONSOLE_KEY) }),
    publicOrigin: OWN_ORIGIN,
    reportError: (err, context) => void Sentry.captureException(err, { extra: context }),
    console: { secret: 'test-secret-0123456789abcdef' },
  }));
});

afterAll(async () => {
  await Sentry.close(2000);
  await closeApp();
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
