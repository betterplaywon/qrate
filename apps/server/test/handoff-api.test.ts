import { HANDOFF_PATH, type HandoffRequestResponse } from '@qrate/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MockEngine } from '../src/engine/mock.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from '../src/repo/seed.js';
import type { Repositories } from '../src/repo/types.js';

// POST /api/handoff — 방문자의 상담원 연결 요청. 실제 HTTP로 Origin 검사·본문 검증·테넌트·대화 연결·요율 제한을 고정한다.

const OWN_ORIGIN = 'http://widget.test';
const seed = loadSeedFile(DEFAULT_SEED_PATH);
const frameAssetsDir = mkdtempSync(path.join(tmpdir(), 'qrate-handoff-'));

let server: Server;
let baseUrl: string;
let repos: Repositories;

function serve(app: ReturnType<typeof createApp>): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
  });
}

beforeAll(async () => {
  repos = createRepositoriesFromSeed(seed);
  const app = createApp({ engine: new MockEngine(0), repos, publicOrigin: OWN_ORIGIN, frameAssetsDir });
  ({ server, url: baseUrl } = await serve(app));
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      rmSync(frameAssetsDir, { recursive: true, force: true });
      server.close(() => resolve());
    }),
);

function post(body: unknown, headers: Record<string, string> = { origin: OWN_ORIGIN }, url = baseUrl) {
  return fetch(`${url}${HANDOFF_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/handoff', () => {
  it('연락처만 있어도 접수된다 — 대화가 없으면 새 대화를 만들어 돌려주고, 큐에 방문자 항목(연락처·메모)이 생긴다', async () => {
    const res = await post({ tenant: 'demo', contact: ' visitor@example.com ', message: '  전화 주세요  ' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as HandoffRequestResponse;
    expect(body.id).toEqual(expect.any(String));
    expect(body.conversationId).toEqual(expect.any(String));

    const queued = (await repos.handoffs.list('demo', { status: 'open', limit: 100 })).items.find((h) => h.id === body.id);
    expect(queued).toMatchObject({
      source: 'visitor',
      reason: 'needs_human',
      contact: 'visitor@example.com',
      summary: '전화 주세요',
      conversationId: body.conversationId,
      preview: '',
    });
    expect((await repos.conversations.find(body.conversationId, 'demo'))?.messages).toEqual([]);
  });

  it('이 테넌트의 대화 id면 그 대화에 붙고, 모르는 id나 다른 테넌트의 대화 id면 새 대화로 — 임의 id로 대화를 만들 수 없다', async () => {
    const mine = randomUUID();
    await repos.conversations.appendTurn(mine, 'demo', {
      question: { role: 'user', content: '환불되나요?' },
      answer: { role: 'assistant', content: '7일 이내면 됩니다.' },
      handoff: null,
    });
    const attached = (await (await post({ tenant: 'demo', conversationId: mine, contact: 'a@b.co' })).json()) as HandoffRequestResponse;
    expect(attached.conversationId).toBe(mine);
    expect((await repos.conversations.find(mine, 'demo'))?.handoffs).toHaveLength(1);

    const unknown = randomUUID();
    const fresh = (await (await post({ tenant: 'demo', conversationId: unknown, contact: 'a@b.co' })).json()) as HandoffRequestResponse;
    expect(fresh.conversationId).not.toBe(unknown);
    expect(await repos.conversations.find(unknown, 'demo')).toBeNull();
  });

  it('본문 검증: 이메일이 아니거나 너무 긴 연락처는 400 invalid_contact, 긴 메모는 message_too_long, 테넌트 없음은 tenant is required', async () => {
    expect(await (await post({ tenant: 'demo', contact: 'not-an-email' })).json()).toEqual({ error: 'invalid_contact' });
    expect(await (await post({ tenant: 'demo', contact: `${'x'.repeat(200)}@example.com` })).json()).toEqual({ error: 'invalid_contact' });
    expect(await (await post({ tenant: 'demo', contact: 'a@b.co', message: 'x'.repeat(501) })).json()).toEqual({ error: 'message_too_long' });
    expect(await (await post({ contact: 'a@b.co' })).json()).toEqual({ error: 'tenant is required' });
    expect((await post({ tenant: 'demo', contact: '' })).status).toBe(400);
  });

  it('모르는 테넌트는 404, 다른 오리진은 403(본문을 읽기 전에)', async () => {
    expect((await post({ tenant: 'nope', contact: 'a@b.co' })).status).toBe(404);
    const res = await post({ tenant: 'demo', contact: 'a@b.co' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin_not_allowed' });
  });

  it('IP당 요율 제한 — 넘으면 429 too_many_requests + Retry-After', async () => {
    const app = createApp({
      engine: new MockEngine(0),
      repos: createRepositoriesFromSeed(seed),
      publicOrigin: OWN_ORIGIN,
      frameAssetsDir,
      handoffRequests: { max: 2, windowMs: 60_000 },
    });
    const { server: s, url } = await serve(app);
    try {
      expect((await post({ tenant: 'demo', contact: 'a@b.co' }, { origin: OWN_ORIGIN }, url)).status).toBe(201);
      expect((await post({ tenant: 'demo', contact: 'a@b.co' }, { origin: OWN_ORIGIN }, url)).status).toBe(201);
      const blocked = await post({ tenant: 'demo', contact: 'a@b.co' }, { origin: OWN_ORIGIN }, url);
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toEqual({ error: 'too_many_requests' });
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});
