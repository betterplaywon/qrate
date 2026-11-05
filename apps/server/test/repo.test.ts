import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile, parseSeed } from '../src/repo/seed.js';
import { describeRepositoryContract } from './repo-contract.js';

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
    const knowledge = [{ id: 'a', title: 'A', category: 'c', blocks: ['x'] }];
    expect(() => parseSeed({ tenant, knowledge, initialCredits: -1 })).toThrow(/initialCredits/);
    expect(() => parseSeed({ tenant, knowledge, initialCredits: 1.5 })).toThrow(/initialCredits/);
    expect(parseSeed({ tenant, knowledge }).initialCredits).toBe(0); // 없으면 지급 없음
    expect(parseSeed({ tenant, knowledge, initialCredits: 100 }).initialCredits).toBe(100);
  });

  it('데모 시드는 초기 크레딧을 지급하고, 메모리 저장소는 시작 때 원장에 한 줄로 올린다', async () => {
    const seed = loadSeedFile(DEFAULT_SEED_PATH);
    expect(seed.initialCredits).toBeGreaterThan(0);
    const repos = createRepositoriesFromSeed(seed);
    expect(await repos.credits.balance(seed.tenant.id)).toBe(seed.initialCredits);
    expect((await repos.credits.list(seed.tenant.id, { limit: 10 })).items.map((e) => e.reason)).toEqual(['seed']);
  });

  it('allowedOrigins는 정규형 오리진만 — CSP 헤더에 그대로 들어가므로', () => {
    const knowledge = [{ id: 'a', title: 'A', category: 'c', blocks: ['x'] }];
    const tenant = { id: 't', apiKey: 'k', name: '테스트', allowedOrigins: ['https://shop.example.com/'] };
    expect(() => parseSeed({ tenant, knowledge })).toThrow(/allowedOrigins\[0\]/);
    expect(() => parseSeed({ tenant: { ...tenant, allowedOrigins: ['https://shop.example.com'] }, knowledge })).not.toThrow();
  });
});

describe('메모리 저장소의 콘솔 키', () => {
  it('시드 파일에는 키가 없고, 시작 때 받은 해시를 테넌트에 붙인다. 없으면 null(콘솔 로그인 불가)', async () => {
    const seed = loadSeedFile(DEFAULT_SEED_PATH);
    expect((await createRepositoriesFromSeed(seed).tenants.findByKey('demo'))?.consoleKeyHash).toBeNull();
    const repos = createRepositoriesFromSeed(seed, { consoleKeyHash: 'scrypt$salt$hash' });
    expect((await repos.tenants.findByKey('demo'))?.consoleKeyHash).toBe('scrypt$salt$hash');
  });
});

// 메모리 구현은 테넌트의 존재를 확인하지 않으므로(FK 없음) 다른 테넌트 id는 아무 문자열이어도 된다.
describeRepositoryContract('메모리', async () => {
  const seed = loadSeedFile(DEFAULT_SEED_PATH);
  return { repos: createRepositoriesFromSeed(seed), tenantId: seed.tenant.id, otherTenantId: 'other-tenant' };
});
