import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryConversationRepository } from '../src/repo/memory.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile, parseSeed } from '../src/repo/seed.js';
import type { NewTurn } from '../src/repo/types.js';

describe('시드 로더', () => {
  it('데모 시드를 읽고 검증한다 — 테넌트 demo, FAQ 20개 이상, id 중복 없음, 빈 블록 없음', () => {
    const seed = loadSeedFile(DEFAULT_SEED_PATH);
    expect(seed.tenant.apiKey).toBe('demo');
    expect(seed.knowledge.length).toBeGreaterThanOrEqual(20);
    expect(new Set(seed.knowledge.map((k) => k.id)).size).toBe(seed.knowledge.length);
    expect(seed.knowledge.every((k) => k.blocks.length > 0 && k.blocks.every((b) => b.trim().length > 0))).toBe(
      true,
    );
  });

  it('모양이 틀린 시드는 서버 시작 전에 거부한다', () => {
    const tenant = { id: 't', apiKey: 'k', name: '테스트', allowedOrigins: [] };
    expect(() => parseSeed({ tenant, knowledge: [] })).toThrow(/knowledge/);
    expect(() =>
      parseSeed({
        tenant,
        knowledge: [
          { id: 'a', title: 'A', category: 'c', blocks: ['x'] },
          { id: 'a', title: 'B', category: 'c', blocks: ['y'] },
        ],
      }),
    ).toThrow(/중복/);
    expect(() => parseSeed({ tenant, knowledge: [{ id: 'a', title: 'A', category: 'c', blocks: [''] }] })).toThrow(
      /blocks\[0\]/,
    );
    expect(() => parseSeed({ tenant: { ...tenant, apiKey: '' }, knowledge: [] })).toThrow(/apiKey/);
  });

  it('allowedOrigins는 정규형 오리진만 — CSP 헤더에 그대로 들어가므로', () => {
    const knowledge = [{ id: 'a', title: 'A', category: 'c', blocks: ['x'] }];
    const tenant = { id: 't', apiKey: 'k', name: '테스트', allowedOrigins: ['https://shop.example.com/'] };
    expect(() => parseSeed({ tenant, knowledge })).toThrow(/allowedOrigins\[0\]/);
    expect(() => parseSeed({ tenant: { ...tenant, allowedOrigins: ['https://shop.example.com'] }, knowledge })).not.toThrow();
  });
});

const turn = (question: string, answer: string | null, handoff: NewTurn['handoff'] = null): NewTurn => ({
  question: { role: 'user', content: question },
  answer: answer === null ? null : { role: 'assistant', content: answer },
  handoff,
});

describe('메모리 저장소 — 계약 (W3의 Postgres 구현에도 같은 테스트를 돌린다)', () => {
  const repos = createRepositoriesFromSeed(loadSeedFile(DEFAULT_SEED_PATH));

  it('테넌트: 키로 찾고, 모르는 키는 null', async () => {
    expect((await repos.tenants.findByKey('demo'))?.name).toBeTruthy();
    expect(await repos.tenants.findByKey('nope')).toBeNull();
  });

  it('지식: 테넌트별로, id 오름차순 고정 (프롬프트 캐시 접두사가 요청마다 같아야 한다)', async () => {
    const items = await repos.knowledge.listByTenant('demo');
    const ids = items.map((k) => k.id);
    expect(ids).toEqual([...ids].sort());
    expect(items.every((k) => k.tenantId === 'demo')).toBe(true);
    expect(await repos.knowledge.listByTenant('other')).toEqual([]);
  });

  it('대화: 첫 턴 저장으로 생긴다 → 질문 시각은 넘긴 값, 답변은 저장 시각 → 같은 테넌트로만 찾는다', async () => {
    const id = randomUUID();
    expect(await repos.conversations.find(id, 'demo')).toBeNull(); // 아직 없다 — 대화는 첫 턴과 함께 생긴다

    const asked = new Date('2026-11-03T12:00:00Z');
    await repos.conversations.appendTurn(id, 'demo', {
      question: { role: 'user', content: '환불되나요?', createdAt: asked },
      answer: { role: 'assistant', content: '7일 이내면 됩니다.' },
      handoff: null,
    });

    const found = await repos.conversations.find(id, 'demo');
    expect(found?.tenantId).toBe('demo');
    expect(found?.createdAt).toEqual(asked);
    expect(found?.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:환불되나요?',
      'assistant:7일 이내면 됩니다.',
    ]);
    expect(found?.messages[0]?.createdAt).toEqual(asked);
    expect(found?.messages[1]?.createdAt.getTime()).toBeGreaterThanOrEqual(asked.getTime());
    expect(found?.handoffs).toEqual([]);
    expect(await repos.conversations.find(id, 'other-tenant')).toBeNull();
    expect(await repos.conversations.find('missing', 'demo')).toBeNull();
  });

  it('턴: 답이 없으면(거절) 질문만, 핸드오프 신호는 handoffs에 시각과 함께', async () => {
    const id = randomUUID();
    await repos.conversations.appendTurn(id, 'demo', turn('거절될 질문', null));
    await repos.conversations.appendTurn(
      id,
      'demo',
      turn('카카오톡 알림 되나요?', '자료에 없어요.', { reason: 'not_in_knowledge', summary: '카카오톡 알림 문의' }),
    );

    const found = await repos.conversations.find(id, 'demo');
    expect(found?.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
    expect(found?.handoffs).toHaveLength(1);
    expect(found?.handoffs[0]).toMatchObject({ reason: 'not_in_knowledge', summary: '카카오톡 알림 문의' });
    expect(found?.handoffs[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('find의 lastMessages는 최근 n개만 싣는다 — 프롬프트 문맥용. 없으면 전부', async () => {
    const id = randomUUID();
    for (let i = 0; i < 3; i += 1) await repos.conversations.appendTurn(id, 'demo', turn(`q${i}`, `a${i}`));
    const last = await repos.conversations.find(id, 'demo', { lastMessages: 2 });
    expect(last?.messages.map((m) => m.content)).toEqual(['q2', 'a2']);
    expect((await repos.conversations.find(id, 'demo'))?.messages).toHaveLength(6);
  });

  it('다른 테넌트의 대화 id로는 쓸 수 없다 — 테넌트 경계는 쓰기에서도', async () => {
    const repo = new MemoryConversationRepository();
    await repo.appendTurn('c1', 'tenant-a', turn('x', null));
    await expect(repo.appendTurn('c1', 'tenant-b', turn('y', null))).rejects.toThrow(/another tenant/);
    expect(await repo.find('c1', 'tenant-b')).toBeNull();
    expect((await repo.find('c1', 'tenant-a'))?.messages).toHaveLength(1);
  });

  it('돌려준 객체를 바꿔도 저장소는 변하지 않는다', async () => {
    const first = await repos.knowledge.listByTenant('demo');
    first[0]?.blocks.push('oops');
    const second = await repos.knowledge.listByTenant('demo');
    expect(second[0]?.blocks).not.toContain('oops');

    const id = randomUUID();
    await repos.conversations.appendTurn(id, 'demo', turn('q', 'a'));
    const found = await repos.conversations.find(id, 'demo');
    found?.messages.push({ role: 'user', content: 'ghost', createdAt: new Date() });
    found?.handoffs.push({ reason: 'other', summary: null, createdAt: new Date() });
    const again = await repos.conversations.find(id, 'demo');
    expect(again?.messages).toHaveLength(2);
    expect(again?.handoffs).toEqual([]);
  });
});
