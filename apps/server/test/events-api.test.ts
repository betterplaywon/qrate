import { EVENTS_PATH, HANDOFF_PATH } from '@qrate/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MockEngine } from '../src/engine/mock.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from '../src/repo/seed.js';
import type { AppEvent } from '../src/repo/types.js';

const OWN_ORIGIN = 'http://widget.test';
const seed = loadSeedFile(DEFAULT_SEED_PATH);
const tenantSeed = { ...seed, tenant: { ...seed.tenant, id: 'tenant-demo-id' } };
const frameAssetsDir = mkdtempSync(path.join(tmpdir(), 'qrate-events-'));
const recorded: AppEvent[] = [];

let server: Server;
let baseUrl: string;

function serve(app: ReturnType<typeof createApp>): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
  });
}

function close(s: Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

beforeAll(async () => {
  const app = createApp({
    engine: new MockEngine(0),
    repos: createRepositoriesFromSeed(tenantSeed),
    publicOrigin: OWN_ORIGIN,
    frameAssetsDir,
    recordEvent: (event) => recorded.push(event),
  });
  ({ server, url: baseUrl } = await serve(app));
});

beforeEach(() => {
  recorded.length = 0;
});

afterAll(async () => {
  rmSync(frameAssetsDir, { recursive: true, force: true });
  await close(server);
});

function post(body: unknown, { origin = OWN_ORIGIN, url = baseUrl, path: route = EVENTS_PATH } = {}) {
  return fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/events', () => {
  it('widget_open → 202 본문 없음, 사건 한 건(테넌트 id, 대화 없음, 빈 payload)', async () => {
    const res = await post({ tenant: 'demo', type: 'widget_open' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    expect(recorded).toEqual([
      { type: 'widget_open', tenantId: 'tenant-demo-id', conversationId: null, createdAt: expect.any(Date), payload: {} },
    ]);
  });

  it('본문의 다른 값은 사건에 옮기지 않는다', async () => {
    const res = await post({ tenant: 'demo', type: 'widget_open', conversationId: 'c-1', message: '원문표지-8841', payload: { x: 1 } });
    expect(res.status).toBe(202);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ conversationId: null, payload: {} });
    expect(JSON.stringify(recorded)).not.toContain('원문표지');
  });

  it('종류는 화이트리스트 — 서버 사건(chat_request)·모르는 종류·종류 없음은 400 invalid_event, 테넌트 없음은 tenant is required', async () => {
    for (const body of [{ tenant: 'demo', type: 'chat_request' }, { tenant: 'demo', type: 'nope' }, { tenant: 'demo' }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_event' });
    }
    const noTenant = await post({ type: 'widget_open' });
    expect(noTenant.status).toBe(400);
    expect(await noTenant.json()).toEqual({ error: 'tenant is required' });
    expect(recorded).toEqual([]);
  });

  it('모르는 테넌트 404, 다른 오리진 403, JSON 아님 400 invalid_json, 1kb 초과 413 — 모두 기록 없음', async () => {
    const unknown = await post({ tenant: 'nope', type: 'widget_open' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown_tenant' });

    const foreign = await post({ tenant: 'demo', type: 'widget_open' }, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: 'origin_not_allowed' });

    const malformed = await post('{bad json');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid_json' });

    const huge = await post({ tenant: 'demo', type: 'widget_open', pad: 'x'.repeat(2_000) });
    expect(huge.status).toBe(413);
    expect(await huge.json()).toEqual({ error: 'payload_too_large' });

    expect(recorded).toEqual([]);
  });

  it('IP당 요율 제한 — 넘으면 429 too_many_requests, 카운터는 상담원 연결과 따로다', async () => {
    const app = createApp({
      engine: new MockEngine(0),
      repos: createRepositoriesFromSeed(tenantSeed),
      publicOrigin: OWN_ORIGIN,
      frameAssetsDir,
      recordEvent: () => undefined,
      eventRequests: { max: 2, windowMs: 60_000 },
      handoffRequests: { max: 2, windowMs: 60_000 },
    });
    const { server: s, url } = await serve(app);
    try {
      expect((await post({ tenant: 'demo', type: 'widget_open' }, { url })).status).toBe(202);
      expect((await post({ tenant: 'demo', type: 'widget_open' }, { url })).status).toBe(202);
      const blocked = await post({ tenant: 'demo', type: 'widget_open' }, { url });
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toEqual({ error: 'too_many_requests' });
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);

      expect((await post({ tenant: 'demo', contact: 'a@b.co' }, { url, path: HANDOFF_PATH })).status).toBe(201);
    } finally {
      await close(s);
    }
  });

  it('기본 통로는 저장소에 쓴다 — 202 뒤 사건 로그에서 셀 수 있다', async () => {
    const repos = createRepositoriesFromSeed(tenantSeed);
    const app = createApp({ engine: new MockEngine(0), repos, publicOrigin: OWN_ORIGIN, frameAssetsDir });
    const { server: s, url } = await serve(app);
    try {
      expect((await post({ tenant: 'demo', type: 'widget_open' }, { url })).status).toBe(202);
      const window = { from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) };
      await expect
        .poll(() => repos.events.counts('tenant-demo-id', window), { timeout: 2_000 })
        .toEqual([{ type: 'widget_open', variant: null, count: 1 }]);
    } finally {
      await close(s);
    }
  });
});
