import { EVENTS_PATH, HANDOFF_PATH } from '@qrate/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineGreetingExperiment } from '../src/greeting/experiment.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from '../src/repo/seed.js';
import type { AppEvent } from '../src/repo/types.js';
import { startApp } from './helpers/app.js';

const OWN_ORIGIN = 'http://widget.test';
const seed = loadSeedFile(DEFAULT_SEED_PATH);
const tenantSeed = { ...seed, tenant: { ...seed.tenant, id: 'tenant-demo-id' } };
const recorded: AppEvent[] = [];
const EXPERIMENT = defineGreetingExperiment({
  id: 'exp',
  variants: [
    { key: 'a', label: 'A', weight: 1, text: '가' },
    { key: 'b', label: 'B', weight: 1, text: '나' },
  ],
});

let baseUrl: string;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  ({ url: baseUrl, close: closeApp } = await startApp({
    repos: createRepositoriesFromSeed(tenantSeed),
    publicOrigin: OWN_ORIGIN,
    recordEvent: (event) => recorded.push(event),
    greeting: EXPERIMENT,
  }));
});

beforeEach(() => {
  recorded.length = 0;
});

afterAll(() => closeApp());

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
      { type: 'widget_open', tenantId: 'tenant-demo-id', conversationId: null, variant: null, createdAt: expect.any(Date), payload: {} },
    ]);
  });

  it('first_question도 받는다 — 페이지 로드당 첫 질문', async () => {
    const res = await post({ tenant: 'demo', type: 'first_question' });
    expect(res.status).toBe(202);
    expect(recorded).toEqual([
      { type: 'first_question', tenantId: 'tenant-demo-id', conversationId: null, variant: null, createdAt: expect.any(Date), payload: {} },
    ]);
  });

  it('variant가 지금 실험의 변형이면 그 id를 싣는다', async () => {
    expect((await post({ tenant: 'demo', type: 'widget_open', variant: 'exp.b' })).status).toBe(202);
    expect((await post({ tenant: 'demo', type: 'first_question', variant: 'exp.a' })).status).toBe(202);
    expect(recorded).toMatchObject([
      { type: 'widget_open', variant: 'exp.b' },
      { type: 'first_question', variant: 'exp.a' },
    ]);
  });

  it('지금 실험의 변형이 아닌 값은 400이 아니라 null로 남긴다 — 열림·질문 수는 지키고 변형만 버린다', async () => {
    const others: unknown[] = ['old.a', 'made-up', 'exp.c', '', 42, ['exp.a'], { id: 'exp.a' }, null];
    for (const variant of others) expect((await post({ tenant: 'demo', type: 'widget_open', variant })).status, JSON.stringify(variant)).toBe(202);
    expect(recorded).toEqual(others.map(() => expect.objectContaining({ type: 'widget_open', variant: null })));
  });

  it('실험이 꺼져 있으면 지금 실험의 변형 모양이어도 null로 남긴다', async () => {
    const { url, close } = await startApp({
      repos: createRepositoriesFromSeed(tenantSeed),
      publicOrigin: OWN_ORIGIN,
      recordEvent: (event) => recorded.push(event),
      greeting: null,
    });
    try {
      expect((await post({ tenant: 'demo', type: 'widget_open', variant: 'exp.a' }, { url })).status).toBe(202);
      expect(recorded).toMatchObject([{ type: 'widget_open', variant: null }]);
    } finally {
      await close();
    }
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
    const { url, close } = await startApp({
      repos: createRepositoriesFromSeed(tenantSeed),
      publicOrigin: OWN_ORIGIN,
      recordEvent: () => undefined,
      eventRequests: { max: 2, windowMs: 60_000 },
      handoffRequests: { max: 2, windowMs: 60_000 },
    });
    try {
      expect((await post({ tenant: 'demo', type: 'widget_open' }, { url })).status).toBe(202);
      expect((await post({ tenant: 'demo', type: 'widget_open' }, { url })).status).toBe(202);
      const blocked = await post({ tenant: 'demo', type: 'widget_open' }, { url });
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toEqual({ error: 'too_many_requests' });
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);

      expect((await post({ tenant: 'demo', contact: 'a@b.co' }, { url, path: HANDOFF_PATH })).status).toBe(201);
    } finally {
      await close();
    }
  });

  it('기본 통로는 저장소에 쓴다 — 202 뒤 사건 로그에서 셀 수 있다', async () => {
    const repos = createRepositoriesFromSeed(tenantSeed);
    const { url, close } = await startApp({ repos, publicOrigin: OWN_ORIGIN });
    try {
      expect((await post({ tenant: 'demo', type: 'widget_open' }, { url })).status).toBe(202);
      const window = { from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) };
      await expect
        .poll(() => repos.events.counts('tenant-demo-id', window), { timeout: 2_000 })
        .toEqual([{ type: 'widget_open', variant: null, count: 1 }]);
    } finally {
      await close();
    }
  });
});
