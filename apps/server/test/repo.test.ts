import { describe, expect, it } from 'vitest';
import { MemoryConversationRepository } from '../src/repo/memory.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile, parseSeed } from '../src/repo/seed.js';

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

  it('대화: 만들고 → 메시지 추가 → 같은 테넌트로만 찾는다', async () => {
    const created = await repos.conversations.create('demo');
    await repos.conversations.appendMessage(created.id, { role: 'user', content: '환불되나요?' });
    await repos.conversations.appendMessage(created.id, { role: 'assistant', content: '7일 이내면 됩니다.' });

    const found = await repos.conversations.find(created.id, 'demo');
    expect(found?.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:환불되나요?',
      'assistant:7일 이내면 됩니다.',
    ]);
    expect(await repos.conversations.find(created.id, 'other-tenant')).toBeNull();
    expect(await repos.conversations.find('missing', 'demo')).toBeNull();
  });

  it('없는 대화에 메시지를 추가하면 실패한다', async () => {
    const repo = new MemoryConversationRepository();
    await expect(repo.appendMessage('missing', { role: 'user', content: 'x' })).rejects.toThrow(/not found/);
  });

  it('돌려준 객체를 바꿔도 저장소는 변하지 않는다', async () => {
    const first = await repos.knowledge.listByTenant('demo');
    first[0]?.blocks.push('oops');
    const second = await repos.knowledge.listByTenant('demo');
    expect(second[0]?.blocks).not.toContain('oops');

    const created = await repos.conversations.create('demo');
    created.messages.push({ role: 'user', content: 'ghost', createdAt: new Date() });
    expect((await repos.conversations.find(created.id, 'demo'))?.messages).toEqual([]);
  });
});
