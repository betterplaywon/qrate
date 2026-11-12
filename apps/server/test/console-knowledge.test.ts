import { KNOWLEDGE_LIMITS, knowledgeChars, type ApiErrorBody, type KnowledgeInput, type KnowledgeItemDto, type KnowledgeListResponse } from '@qrate/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashConsoleKey } from '../src/console/key.js';
import { MockEngine } from '../src/engine/mock.js';
import { createRepositoriesFromSeeds, loadSeedFiles } from '../src/repo/seed.js';
import type { Repositories } from '../src/repo/types.js';

// 콘솔의 FAQ 편집(/api/console/knowledge)을 실제 HTTP로 본다. 저장소는 데모 시드 둘(demo, reception)을 올린 메모리이고,
// 두 회사 모두 콘솔 키가 있어 회사 경계를 양쪽에서 확인한다.

const OWN_ORIGIN = 'http://console.test';
const SECRET = 'test-secret-0123456789abcdef';
const KEYS = { demo: 'demo-console-key', reception: 'reception-console-key' } as const;
type Company = keyof typeof KEYS;
const frameAssetsDir = mkdtempSync(path.join(tmpdir(), 'qrate-knowledge-'));

let server: Server;
let baseUrl: string;
let repos: Repositories;
const cookies = {} as Record<Company, string>;

beforeAll(async () => {
  repos = createRepositoriesFromSeeds(loadSeedFiles(), {
    consoleKeyHashes: { demo: hashConsoleKey(KEYS.demo), reception: hashConsoleKey(KEYS.reception) },
  });
  const app = createApp({ engine: new MockEngine(0), repos, publicOrigin: OWN_ORIGIN, frameAssetsDir, console: { secret: SECRET } });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  for (const company of Object.keys(KEYS) as Company[]) {
    const res = await fetch(`${baseUrl}/api/console/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
      body: JSON.stringify({ tenant: company, key: KEYS[company] }),
    });
    expect(res.status).toBe(200);
    cookies[company] = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      rmSync(frameAssetsDir, { recursive: true, force: true });
      server.close(() => resolve());
    }),
);

const url = (id?: string) => `${baseUrl}/api/console/knowledge${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;

async function list(company: Company): Promise<KnowledgeItemDto[]> {
  const res = await fetch(url(), { headers: { cookie: cookies[company] } });
  expect(res.status).toBe(200);
  return ((await res.json()) as KnowledgeListResponse).items;
}

function put(company: Company | null, id: string, body: unknown, origin: string | null = OWN_ORIGIN) {
  return fetch(url(id), {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(company ? { cookie: cookies[company] } : {}),
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

function remove(company: Company | null, id: string, origin: string | null = OWN_ORIGIN) {
  return fetch(url(id), {
    method: 'DELETE',
    headers: { ...(company ? { cookie: cookies[company] } : {}), ...(origin ? { origin } : {}) },
  });
}

const errorOf = async (res: Response): Promise<string> => ((await res.json()) as ApiErrorBody).error;
const input = (blocks: string[], title = '시험 질문', category = '시험'): KnowledgeInput => ({ title, category, blocks });

describe('FAQ 목록', () => {
  it('세션의 회사 FAQ만 id 순서로 돌려주고 다른 회사 것은 섞지 않는다. 회사 id는 싣지 않는다. 세션이 없으면 401', async () => {
    const demo = await list('demo');
    expect(demo).toHaveLength(27);
    const ids = demo.map((k) => k.id);
    expect(ids).toEqual([...ids].sort());
    expect(Object.keys(demo[0] ?? {}).sort()).toEqual(['blocks', 'category', 'id', 'title']);
    const unsupported = (items: KnowledgeItemDto[]) => items.find((k) => k.id === 'faq:unsupported-features')?.title;
    expect(unsupported(demo)).toBe('지원하지 않는 기능');
    expect(unsupported(await list('reception'))).toBe('지원하지 않는 것');

    const anonymous = await fetch(url());
    expect(anonymous.status).toBe(401);
    expect((await fetch(url(), { headers: { cookie: cookies.demo } })).headers.get('cache-control')).toBe('no-store');
  });
});

describe('FAQ 저장·지우기', () => {
  it('고친 FAQ는 다음 질문의 근거가 된다 — 목업 엔진은 id가 가장 앞선 항목의 첫 문단을 인용한다', async () => {
    const res = await put('demo', 'faq:annual-billing', input(['  연간 결제는 20% 할인됩니다.  ', '월 결제로 바꿀 수 있습니다.'], '연간 결제 할인', '요금·결제'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 'faq:annual-billing',
      title: '연간 결제 할인',
      category: '요금·결제',
      blocks: ['연간 결제는 20% 할인됩니다.', '월 결제로 바꿀 수 있습니다.'],
    });
    expect((await list('demo')).find((k) => k.id === 'faq:annual-billing')?.blocks[0]).toBe('연간 결제는 20% 할인됩니다.');

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
      body: JSON.stringify({ tenant: 'demo', message: '연간 결제하면 할인돼요?' }),
    });
    expect(chat.status).toBe(200);
    const stream = await chat.text();
    expect(stream).toContain('event: citation');
    expect(stream).toContain('"citedText":"연간 결제는 20% 할인됩니다."');
  });

  it('없는 id면 만들고(201) 같은 요청을 다시 보내면 바꾼다(200, 항목은 하나). 지우면 204, 이미 없어도 204', async () => {
    const before = (await list('reception')).length;
    const first = await put('reception', 'faq:c0ffee12', input(['로비 2층에 수유실이 있습니다.'], '수유실이 있나요?', '시설'));
    expect(first.status).toBe(201);
    const again = await put('reception', 'faq:c0ffee12', input(['로비 2층에 수유실이 있습니다.'], '수유실이 있나요?', '시설'));
    expect(again.status).toBe(200);
    expect((await list('reception')).filter((k) => k.id === 'faq:c0ffee12')).toHaveLength(1);
    expect(await list('reception')).toHaveLength(before + 1);

    expect((await remove('reception', 'faq:c0ffee12')).status).toBe(204);
    expect(await list('reception')).toHaveLength(before);
    expect((await remove('reception', 'faq:c0ffee12')).status).toBe(204);
  });

  it('모양이 틀리면 400 invalid_knowledge — id, 빈 질문·분류·문단, 문단 개수와 길이, 질문·분류 길이, 제어 문자. 깨진 JSON은 400 invalid_json', async () => {
    for (const id of ['plans', 'faq:Plans', 'faq:', 'faq:a b', 'faq:-a']) {
      const res = await put('demo', id, input(['x']));
      expect(res.status, id).toBe(400);
      expect(await errorOf(res)).toBe('invalid_knowledge');
    }
    const bodies: unknown[] = [
      input(['x'], ''),
      input(['x'], '   '),
      input(['x'], '질문', ''),
      input([]),
      input(['   ']),
      input(['x', '']),
      input(Array<string>(KNOWLEDGE_LIMITS.blocks + 1).fill('x')),
      input(['가'.repeat(KNOWLEDGE_LIMITS.blockChars + 1)]),
      input(['x'], '가'.repeat(KNOWLEDGE_LIMITS.titleChars + 1)),
      input(['x'], '질문', '가'.repeat(KNOWLEDGE_LIMITS.categoryChars + 1)),
      { title: '질문', category: '시험' },
      { title: '질문', category: '시험', blocks: 'x' },
      ['질문', '시험', ['x']],
      // 보이지 않는 제어 문자와 짝 없는 서로게이트. NUL은 Postgres text가 받지 못해 500이 됐었다
      input(['x'], '질문\u0000'),
      input(['x'], '질문', '시험\u001b'),
      input(['종\u0007소리']),
      input(['\ud800 짝 없는 서로게이트']),
    ];
    for (const body of bodies) {
      const res = await put('demo', 'faq:shape', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await errorOf(res)).toBe('invalid_knowledge');
    }
    // 상한 바로 아래는 받는다
    const edge = input(Array<string>(KNOWLEDGE_LIMITS.blocks).fill('가'.repeat(KNOWLEDGE_LIMITS.blockChars)), '가'.repeat(KNOWLEDGE_LIMITS.titleChars));
    expect((await put('demo', 'faq:shape', edge)).status).toBe(201);
    expect((await remove('demo', 'faq:shape')).status).toBe(204);
    // 글자는 코드 포인트로 센다. 이모지 1,000개(UTF-16로 2,000)는 받고 1,001개는 400. 문단 안의 줄바꿈·탭·세로 탭(붙여 넣은 줄바꿈)은 받는다
    expect((await put('demo', 'faq:shape', input(['😀'.repeat(KNOWLEDGE_LIMITS.blockChars)]))).status).toBe(201);
    expect((await put('demo', 'faq:shape', input(['😀'.repeat(KNOWLEDGE_LIMITS.blockChars + 1)]))).status).toBe(400);
    const lines = await put('demo', 'faq:shape', input(['첫 줄\n둘째 줄\t끝\v붙여 넣은 줄']));
    expect(lines.status).toBe(200);
    expect(((await lines.json()) as KnowledgeItemDto).blocks).toEqual(['첫 줄\n둘째 줄\t끝\v붙여 넣은 줄']);
    expect((await remove('demo', 'faq:shape')).status).toBe(204);

    expect((await remove('demo', 'BAD')).status).toBe(400);
    const broken = await fetch(url('faq:shape'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: OWN_ORIGIN, cookie: cookies.demo },
      body: '{"title":',
    });
    expect(broken.status).toBe(400);
    expect(await errorOf(broken)).toBe('invalid_json');
  });

  it('본문이 64kb를 넘으면 413 payload_too_large', async () => {
    const res = await put('demo', 'faq:huge', input(['x'.repeat(70_000)]));
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toBe('payload_too_large');
  });

  it('PUT·DELETE는 Origin 검사를 받는다(다른 오리진·Origin: null은 403). 세션이 없으면 401', async () => {
    // Origin이 아예 없는 요청은 브라우저 밖의 호출로 보고 통과시킨다(origin.ts의 isAllowedOrigin). 그때도 세션 쿠키는 있어야 한다.
    for (const origin of ['https://evil.example', 'null']) {
      const putRes = await put('demo', 'faq:annual-billing', input(['바뀌면 안 된다']), origin);
      expect(putRes.status).toBe(403);
      expect(await errorOf(putRes)).toBe('origin_not_allowed');
      expect((await remove('demo', 'faq:annual-billing', origin)).status).toBe(403);
    }
    expect((await put(null, 'faq:annual-billing', input(['바뀌면 안 된다']))).status).toBe(401);
    expect((await remove(null, 'faq:annual-billing')).status).toBe(401);
    expect((await list('demo')).find((k) => k.id === 'faq:annual-billing')?.blocks).not.toContain('바뀌면 안 된다');
  });
});

describe('회사 경계', () => {
  it('다른 회사의 FAQ는 바꾸거나 지울 수 없다 — 같은 id로 저장하면 내 회사 것이 따로 생기고, 지우기도 내 회사 것만', async () => {
    const demoBefore = (await list('demo')).find((k) => k.id === 'faq:unsupported-features');
    expect(demoBefore).toBeDefined();

    const res = await put('reception', 'faq:annual-billing', input(['하람바이오에는 연간 결제가 없습니다.']));
    expect(res.status).toBe(201);
    expect((await list('demo')).find((k) => k.id === 'faq:annual-billing')?.blocks[0]).not.toBe('하람바이오에는 연간 결제가 없습니다.');

    expect((await remove('reception', 'faq:unsupported-features')).status).toBe(204);
    expect((await list('reception')).some((k) => k.id === 'faq:unsupported-features')).toBe(false);
    expect((await list('demo')).find((k) => k.id === 'faq:unsupported-features')).toEqual(demoBefore);

    // 되돌린다
    expect((await remove('reception', 'faq:annual-billing')).status).toBe(204);
    expect((await put('reception', 'faq:unsupported-features', input(demoBefore?.blocks ?? ['x'], '지원하지 않는 것', '안내'))).status).toBe(201);
  });
});

describe('FAQ 상한', () => {
  // 상한 시험은 따로 연 저장소에서 한다. 앞의 시험이 쓰는 회사 FAQ를 건드리지 않게.
  let local: Repositories;
  let localUrl: string;
  let localServer: Server;
  let cookie: string;

  beforeAll(async () => {
    local = createRepositoriesFromSeeds(loadSeedFiles(), { consoleKeyHashes: { reception: hashConsoleKey(KEYS.reception) } });
    const app = createApp({ engine: new MockEngine(0), repos: local, publicOrigin: OWN_ORIGIN, frameAssetsDir, console: { secret: SECRET } });
    await new Promise<void>((resolve) => {
      localServer = app.listen(0, () => {
        localUrl = `http://127.0.0.1:${(localServer.address() as AddressInfo).port}/api/console`;
        resolve();
      });
    });
    const login = await fetch(`${localUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
      body: JSON.stringify({ tenant: 'reception', key: KEYS.reception }),
    });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  afterAll(() => new Promise<void>((resolve) => localServer.close(() => resolve())));

  const save = (id: string, body: KnowledgeInput) =>
    fetch(`${localUrl}/knowledge/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: OWN_ORIGIN, cookie },
      body: JSON.stringify(body),
    });
  const totalChars = async () => (await local.knowledge.listByTenant('reception')).reduce((sum, k) => sum + knowledgeChars(k), 0);

  it(`새 항목은 ${KNOWLEDGE_LIMITS.items}개에서 막히고(409 knowledge_limit) 있는 항목은 그대로 고친다`, async () => {
    const start = (await local.knowledge.listByTenant('reception')).length;
    for (let i = start; i < KNOWLEDGE_LIMITS.items; i++) expect((await save(`faq:fill-${i}`, input(['x']))).status).toBe(201);
    const over = await save('faq:one-more', input(['x']));
    expect(over.status).toBe(409);
    expect(await errorOf(over)).toBe('knowledge_limit');
    expect((await save('faq:fill-30', input(['고친 문단']))).status).toBe(200);

    for (let i = start; i < KNOWLEDGE_LIMITS.items; i++) await local.knowledge.remove('reception', `faq:fill-${i}`);
    expect(await local.knowledge.listByTenant('reception')).toHaveLength(start);
  });

  it(`제목·문단 글자 합이 ${KNOWLEDGE_LIMITS.totalChars.toLocaleString('ko-KR')}자를 넘는 저장은 409 knowledge_too_large, 이미 넘었으면 줄이는 수정만 받는다`, async () => {
    const { blocks: maxBlocks, blockChars } = KNOWLEDGE_LIMITS;
    // 제목 'T' 1자 + 문단으로 정확히 chars자인 항목(문단 하나는 blockChars자까지, 항목은 1 + maxBlocks × blockChars자까지)
    const sized = (chars: number) => {
      const body = chars - 1;
      const blocks = Array.from({ length: Math.ceil(body / blockChars) }, (_, i) => '가'.repeat(Math.min(blockChars, body - i * blockChars)));
      return input(blocks, 'T');
    };
    // 상한에 정확히 닿을 때까지 채운다. 상한과 같으면 받는다
    let room = KNOWLEDGE_LIMITS.totalChars - (await totalChars());
    for (let i = 0; room > 0; i++) {
      const size = Math.min(room, 1 + maxBlocks * blockChars);
      expect((await save(`faq:big-${i}`, sized(size))).status).toBe(201);
      room -= size;
    }
    expect(await totalChars()).toBe(KNOWLEDGE_LIMITS.totalChars);
    const over = await save('faq:one-more', sized(2));
    expect(over.status).toBe(409);
    expect(await errorOf(over)).toBe('knowledge_too_large');

    // 상한이 생기기 전의 자료처럼 저장소에 바로 넣어 상한을 넘긴 상태를 만든다
    await local.knowledge.put({ tenantId: 'reception', id: 'faq:legacy', ...sized(5_000) });
    expect((await save('faq:legacy', sized(4_000))).status).toBe(200);
    expect(await totalChars()).toBeGreaterThan(KNOWLEDGE_LIMITS.totalChars);
    const grow = await save('faq:legacy', sized(4_001));
    expect(grow.status).toBe(409);
    expect(await errorOf(grow)).toBe('knowledge_too_large');
  });
});
