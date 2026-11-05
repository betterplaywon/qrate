import {
  METRICS_WINDOW_DAYS,
  type ConsoleMetricsResponse,
  type ConsoleSessionResponse,
  type ConversationDetailResponse,
  type ConversationListResponse,
  type CreditsResponse,
  type HandoffListResponse,
  type HandoffQueueItemDto,
} from '@qrate/contracts';
import { randomUUID } from 'node:crypto';
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
import type { Repositories } from '../src/repo/types.js';

// 콘솔 API를 실제 HTTP로 통과시키는 계약 테스트. 저장소는 메모리(시드 + 콘솔 키 해시), 인증 경로는 전부 여기서 고정한다.

const OWN_ORIGIN = 'http://console.test';
const CONSOLE_KEY = 'demo-console-key';
const SECRET = 'test-secret-0123456789abcdef';
const seed = loadSeedFile(DEFAULT_SEED_PATH);
const frameAssetsDir = mkdtempSync(path.join(tmpdir(), 'qrate-console-'));

let server: Server;
let baseUrl: string;
let repos: Repositories;
const reports: { err: unknown; context?: Record<string, unknown> }[] = [];

function serve(app: ReturnType<typeof createApp>): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
  });
}

beforeAll(async () => {
  repos = createRepositoriesFromSeed(seed, { consoleKeyHash: hashConsoleKey(CONSOLE_KEY) });
  const app = createApp({
    engine: new MockEngine(0),
    repos,
    publicOrigin: OWN_ORIGIN,
    frameAssetsDir,
    reportError: (err, context) => void reports.push({ err, context }),
    console: { secret: SECRET },
  });
  ({ server, url: baseUrl } = await serve(app));
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      rmSync(frameAssetsDir, { recursive: true, force: true });
      server.close(() => resolve());
    }),
);

const api = (p: string) => `${baseUrl}/api/console${p}`;

function login(body: unknown = { tenant: 'demo', key: CONSOLE_KEY }, headers: Record<string, string> = {}) {
  return fetch(api('/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: OWN_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

/** 로그인해서 세션 쿠키(이름=값)만 뽑는다. */
async function session(): Promise<string> {
  const res = await login();
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie') ?? '';
  return cookie.split(';')[0] ?? '';
}

function get(p: string, cookie: string | null) {
  return fetch(api(p), { headers: cookie ? { cookie } : {} });
}

function patch(p: string, cookie: string | null, body: unknown, headers: Record<string, string> = { origin: OWN_ORIGIN }) {
  return fetch(api(p), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

describe('로그인·세션', () => {
  it('맞는 테넌트 키 + 콘솔 키 → 200, HttpOnly·SameSite=Strict·Path=/api/console 쿠키(http 오리진이라 Secure 없음), 테넌트 정보', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect((await res.json()) as ConsoleSessionResponse).toEqual({ tenant: { id: 'demo', name: seed.tenant.name } });
    const cookie = res.headers.get('set-cookie') ?? '';
    const [pair, ...attrs] = cookie.split('; ');
    expect(pair).toMatch(/^qrate_console=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // JWT
    expect(attrs.sort()).toEqual(['HttpOnly', 'Max-Age=43200', 'Path=/api/console', 'SameSite=Strict']);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('틀린 키·모르는 테넌트·빈 값·모양이 다른 본문은 모두 같은 401 invalid_credentials — 이유를 나누지 않는다', async () => {
    for (const body of [
      { tenant: 'demo', key: 'wrong' },
      { tenant: 'nope', key: CONSOLE_KEY },
      { tenant: 'demo', key: '' },
      { tenant: 'demo' },
      { tenant: 42, key: CONSOLE_KEY },
      { tenant: 'demo', key: 'x'.repeat(300) },
    ]) {
      const res = await login(body);
      expect(res.status, JSON.stringify(body)).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid_credentials' });
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('콘솔 키가 없는 테넌트(해시 null)는 어떤 키로도 로그인할 수 없다', async () => {
    const noKey = createRepositoriesFromSeed(seed);
    const app = createApp({ engine: new MockEngine(0), repos: noKey, publicOrigin: OWN_ORIGIN, frameAssetsDir, console: { secret: SECRET } });
    const { server: s, url } = await serve(app);
    try {
      const res = await fetch(`${url}/api/console/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
        body: JSON.stringify({ tenant: 'demo', key: '' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it('다른 오리진에서 온 로그인·로그아웃·상태 변경은 403 — 대화 API와 같은 Origin 검사', async () => {
    expect((await login(undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(api('/logout'), { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const cookie = await session();
    expect((await patch('/handoffs/x', cookie, { status: 'done' }, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('세션 없음·꾸민 쿠키·로그아웃 뒤는 401 unauthorized, 세션이 있으면 /me가 테넌트를 돌려준다', async () => {
    expect((await get('/me', null)).status).toBe(401);
    expect((await get('/me', 'qrate_console=abc.def')).status).toBe(401);
    const cookie = await session();
    const me = await get('/me', cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ tenant: { id: 'demo', name: seed.tenant.name } });
    // 다른 비밀로 서명한 토큰은 통하지 않는다
    expect((await get('/me', `${cookie.slice(0, -2)}zz`)).status).toBe(401);

    const out = await fetch(api('/logout'), { method: 'POST', headers: { origin: OWN_ORIGIN, cookie } });
    expect(out.status).toBe(204);
    const [cleared, ...clearedAttrs] = (out.headers.get('set-cookie') ?? '').split('; ');
    expect(cleared).toBe('qrate_console=');
    expect(clearedAttrs.sort()).toEqual(['HttpOnly', 'Max-Age=0', 'Path=/api/console', 'SameSite=Strict']);
  });

  it('https 공개 오리진이면 쿠키에 Secure가 붙는다', async () => {
    const app = createApp({
      engine: new MockEngine(0),
      repos,
      publicOrigin: 'https://widget.example.com',
      frameAssetsDir,
      console: { secret: SECRET },
    });
    const { server: s, url } = await serve(app);
    try {
      const res = await fetch(`${url}/api/console/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://widget.example.com' },
        body: JSON.stringify({ tenant: 'demo', key: CONSOLE_KEY }),
      });
      expect(res.status).toBe(200);
      expect((res.headers.get('set-cookie') ?? '').split('; ')).toContain('Secure');
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it('로그인 시도는 IP당 창 안에서 제한된다 — 넘으면 429 + Retry-After, 키가 맞아도 막힌다', async () => {
    const app = createApp({
      engine: new MockEngine(0),
      repos,
      publicOrigin: OWN_ORIGIN,
      frameAssetsDir,
      console: { secret: SECRET, loginAttempts: { max: 2, windowMs: 60_000 } },
    });
    const { server: s, url } = await serve(app);
    try {
      const attempt = (key: string) =>
        fetch(`${url}/api/console/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
          body: JSON.stringify({ tenant: 'demo', key }),
        });
      expect((await attempt('wrong')).status).toBe(401);
      expect((await attempt('wrong')).status).toBe(401);
      const blocked = await attempt(CONSOLE_KEY);
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toEqual({ error: 'too_many_attempts' });
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it('콘솔 옵션이 없으면 콘솔 API가 없다(404)', async () => {
    const app = createApp({ engine: new MockEngine(0), repos, publicOrigin: OWN_ORIGIN, frameAssetsDir });
    const { server: s, url } = await serve(app);
    try {
      expect((await fetch(`${url}/api/console/me`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});

describe('대화 로그·미응답 큐', () => {
  let cookie: string;
  const ids: string[] = [];

  beforeAll(async () => {
    cookie = await session();
    const base = Date.parse('2026-11-04T13:00:00Z');
    for (let i = 0; i < 3; i += 1) {
      const id = randomUUID();
      ids.push(id);
      await repos.conversations.appendTurn(id, 'demo', {
        question: { role: 'user', content: `콘솔 질문 ${i}`, createdAt: new Date(base + i * 1000) },
        answer: { role: 'assistant', content: `답 ${i}` },
        handoff: i === 2 ? { reason: 'not_in_knowledge', summary: '요약' } : null,
      });
    }
    await repos.handoffs.requestByVisitor(ids[0] as string, 'demo', { contact: 'v@example.com', summary: '전화 주세요' });
  });

  it('목록은 세션의 테넌트 것만, 최근순, 커서로 이어 받고, ISO 날짜·미리보기·개수를 싣는다', async () => {
    const res = await get('/conversations?limit=2', cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const page = (await res.json()) as ConversationListResponse;
    expect(page.items.map((c) => c.id)).toEqual([ids[2], ids[1]]);
    expect(page.items[0]).toEqual({
      id: ids[2],
      createdAt: '2026-11-04T13:00:02.000Z',
      messageCount: 2,
      handoffCount: 1,
      preview: '콘솔 질문 2',
    });
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = (await (await get(`/conversations?limit=2&cursor=${encodeURIComponent(page.nextCursor as string)}`, cookie)).json()) as ConversationListResponse;
    expect(next.items[0]?.id).toBe(ids[0]);
    expect(next.items[0]?.handoffCount).toBe(1); // 방문자 요청
  });

  it('limit·cursor·status 값이 틀리면 400, 세션이 없으면 401', async () => {
    expect((await get('/conversations?limit=0', cookie)).status).toBe(400);
    expect((await get('/conversations?limit=101', cookie)).status).toBe(400);
    expect((await get('/conversations?limit=abc', cookie)).status).toBe(400);
    expect(await (await get('/conversations?cursor=junk', cookie)).json()).toEqual({ error: 'invalid_cursor' });
    expect(await (await get('/handoffs?status=closed', cookie)).json()).toEqual({ error: 'invalid_status' });
    expect((await get('/conversations', null)).status).toBe(401);
    expect((await get(`/conversations/${ids[0]}`, null)).status).toBe(401);
    expect((await get('/handoffs', null)).status).toBe(401);
  });

  it('상세는 메시지와 핸드오프 전부, 없는 id는 404', async () => {
    const res = await get(`/conversations/${ids[2]}`, cookie);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as ConversationDetailResponse;
    expect(detail.messages.map((m) => `${m.role}:${m.content}`)).toEqual(['user:콘솔 질문 2', 'assistant:답 2']);
    expect(detail.handoffs).toHaveLength(1);
    expect(detail.handoffs[0]).toMatchObject({ source: 'model', reason: 'not_in_knowledge', summary: '요약', status: 'open', contact: null });
    expect(typeof detail.handoffs[0]?.createdAt).toBe('string');
    expect((await get(`/conversations/${randomUUID()}`, cookie)).status).toBe(404);
  });

  it('큐는 상태로 거르고, PATCH로 상태를 옮기면 큐·상세에 반영된다. 모르는 상태는 400, 없는 id는 404', async () => {
    const open = (await (await get('/handoffs?status=open', cookie)).json()) as HandoffListResponse;
    const visitor = open.items.find((h) => h.source === 'visitor');
    const model = open.items.find((h) => h.source === 'model');
    expect(visitor).toMatchObject({ conversationId: ids[0], contact: 'v@example.com', summary: '전화 주세요', preview: '콘솔 질문 0' });
    expect(model).toMatchObject({ conversationId: ids[2], reason: 'not_in_knowledge', preview: '콘솔 질문 2' });

    const moved = await patch(`/handoffs/${visitor?.id}`, cookie, { status: 'in_progress' });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as HandoffQueueItemDto).status).toBe('in_progress');
    const stillOpen = (await (await get('/handoffs?status=open', cookie)).json()) as HandoffListResponse;
    expect(stillOpen.items.map((h) => h.id)).not.toContain(visitor?.id);
    const progress = (await (await get('/handoffs?status=in_progress', cookie)).json()) as HandoffListResponse;
    expect(progress.items.map((h) => h.id)).toContain(visitor?.id);
    const detail = (await (await get(`/conversations/${ids[0]}`, cookie)).json()) as ConversationDetailResponse;
    expect(detail.handoffs[0]?.status).toBe('in_progress');

    expect((await patch(`/handoffs/${visitor?.id}`, cookie, { status: 'closed' })).status).toBe(400);
    expect((await patch(`/handoffs/${visitor?.id}`, cookie, {})).status).toBe(400);
    expect((await patch('/handoffs/missing', cookie, { status: 'done' })).status).toBe(404);
    expect((await patch(`/handoffs/${visitor?.id}`, null, { status: 'done' })).status).toBe(401);
  });

  it('잔액은 원장 합계, 원장은 최근순·커서로 이어 받고 접두사 있는 멱등 키를 싣는다. 세션 없으면 401, limit 틀리면 400', async () => {
    const before = await repos.credits.balance('demo');
    await repos.credits.append('demo', { delta: -1, reason: 'turn', idempotencyKey: 'turn:console-test' });

    const res = await get('/credits?limit=1', cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const page = (await res.json()) as CreditsResponse;
    expect(page.balance).toBe(before - 1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ delta: -1, reason: 'turn', idempotencyKey: 'turn:console-test' });
    expect(typeof page.items[0]?.createdAt).toBe('string');
    expect(page.nextCursor).toEqual(expect.any(String));

    const next = (await (await get(`/credits?limit=1&cursor=${encodeURIComponent(page.nextCursor as string)}`, cookie)).json()) as CreditsResponse;
    expect(next.balance).toBe(before - 1);
    expect(next.items[0]).toMatchObject({ delta: seed.initialCredits, reason: 'seed', idempotencyKey: 'seed:initial' });
    expect(next.nextCursor).toBeNull();

    expect((await get('/credits', null)).status).toBe(401);
    expect((await get('/credits?limit=0', cookie)).status).toBe(400);
    expect(await (await get('/credits?cursor=junk', cookie)).json()).toEqual({ error: 'invalid_cursor' });
  });

  it('처리 중 예외는 500 JSON과 보고 통로로 — 본문은 넘기지 않는다', async () => {
    const broken = createApp({
      engine: new MockEngine(0),
      repos: { ...repos, conversations: { ...repos.conversations, listByTenant: async () => { throw new Error('db down'); } } },
      publicOrigin: OWN_ORIGIN,
      frameAssetsDir,
      reportError: (err, context) => void reports.push({ err, context }),
      console: { secret: SECRET },
    });
    const { server: s, url } = await serve(broken);
    try {
      const res = await fetch(`${url}/api/console/conversations`, { headers: { cookie } });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_error' });
      expect(reports.at(-1)?.context).toMatchObject({ where: 'express', path: '/api/console/conversations' });
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});

describe('지표 — GET /api/console/metrics', () => {
  let metricsServer: Server;
  let url: string;
  let cookie: string;

  const metrics = async () => {
    const res = await fetch(`${url}/api/console/metrics`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as ConsoleMetricsResponse;
  };
  const post = (route: string, body: unknown) =>
    fetch(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: OWN_ORIGIN }, body: JSON.stringify(body) });

  beforeAll(async () => {
    const app = createApp({
      engine: new MockEngine(0),
      repos: createRepositoriesFromSeed(seed, { consoleKeyHash: hashConsoleKey(CONSOLE_KEY) }),
      publicOrigin: OWN_ORIGIN,
      frameAssetsDir,
      console: { secret: SECRET },
    });
    ({ server: metricsServer, url } = await serve(app));
    const res = await post('/api/console/login', { tenant: 'demo', key: CONSOLE_KEY });
    expect(res.status).toBe(200);
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  afterAll(() => new Promise<void>((resolve) => metricsServer.close(() => resolve())));

  it('세션이 없으면 401, 빈 저장소면 표본 0·백분위 null·해결률 null·열림 0, 창은 7일이고 캐시 금지', async () => {
    expect((await fetch(`${url}/api/console/metrics`)).status).toBe(401);

    const res = await fetch(`${url}/api/console/metrics`, { headers: { cookie } });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as ConsoleMetricsResponse;
    expect(body).toMatchObject({
      ttft: { samples: 0, p50Ms: null, p95Ms: null },
      autoResolution: { conversations: 0, resolved: 0, rate: null },
      widget: { opens: 0 },
    });
    expect(Date.parse(body.window.to) - Date.parse(body.window.from)).toBe(METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  });

  it('대화·연결 요청·위젯 열림이 각 원천에서 집계된다 — 질문 없이 연결만 요청한 대화는 해결률에서 빠진다', async () => {
    await (await post('/api/chat', { tenant: 'demo', message: '환불 정책 알려줘' })).text();
    await (await post('/api/chat', { tenant: 'demo', message: '[[handoff]] 카카오톡 알림 되나요?' })).text();
    expect((await post('/api/handoff', { tenant: 'demo', contact: 'v@example.com' })).status).toBe(201);
    expect((await post('/api/events', { tenant: 'demo', type: 'widget_open' })).status).toBe(202);

    await expect.poll(async () => (await metrics()).ttft.samples, { timeout: 2_000 }).toBe(2);
    const body = await metrics();
    expect(body.ttft).toEqual({ samples: 2, p50Ms: expect.any(Number), p95Ms: expect.any(Number) });
    expect(body.autoResolution).toEqual({ conversations: 2, resolved: 1, rate: 0.5 });
    expect(body.widget).toEqual({ opens: 1 });
  });
});
