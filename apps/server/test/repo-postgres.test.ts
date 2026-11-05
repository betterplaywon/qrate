import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import type { HandoffReason } from '../src/engine/types.js';
import { applySeed, createPrismaClient, createPrismaRepositories } from '../src/repo/prisma.js';
import { DEFAULT_SEED_PATH, loadSeedFile } from '../src/repo/seed.js';
import { describeRepositoryContract, turn } from './repo-contract.js';

// Postgres(Prisma) 저장소 — 메모리와 같은 계약 테스트 + DB에서만 뜻이 있는 케이스.
// 전용 테스트 DB가 필요하다: QRATE_TEST_DATABASE_URL(.env의 QRATE_TEST_* 만 vitest.config.ts가 올린다).
//   docker compose up -d db                       → qrate_test DB가 함께 만들어진다(docker/db-init)
//   DATABASE_URL=<테스트 DB> pnpm --filter @qrate/server db:deploy   → 마이그레이션 적용
// 변수가 없으면 건너뛴다(로컬). CI는 항상 설정한다(.github/workflows/ci.yml의 서비스 컨테이너).
// 개발 DB(DATABASE_URL)는 일부러 쓰지 않는다 — 테스트 대화가 콘솔에 섞이면 안 된다.

const url = process.env.QRATE_TEST_DATABASE_URL;
if (!url) {
  console.warn('[test] QRATE_TEST_DATABASE_URL 없음 — Postgres 저장소 테스트를 건너뛴다 (apps/server/test/repo-postgres.test.ts 머리말)');
}

const OTHER_TENANT = { id: 'contract-other', apiKey: 'contract-other', name: '계약 테스트용 다른 테넌트' };
const seed = loadSeedFile(DEFAULT_SEED_PATH);

describe.skipIf(!url)('Postgres 저장소', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createPrismaClient(url as string);
    // 전용 테스트 DB다 — 지난 실행의 대화를 비운다. 마이그레이션이 없으면 여기서 "relation ... does not exist"로 실패한다.
    await prisma.handoff.deleteMany();
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
    await applySeed(prisma, seed);
    await prisma.knowledgeItem.deleteMany({ where: { tenantId: OTHER_TENANT.id } });
    // 계약 테스트의 크레딧 검증은 0에서 시작하고 고정 멱등 키를 쓴다 — 지난 실행의 원장 행을 비운다(테스트 DB는 실행 사이에 남는다)
    await prisma.creditLedger.deleteMany({ where: { tenantId: OTHER_TENANT.id } });
    await prisma.tenant.upsert({ where: { id: OTHER_TENANT.id }, create: { ...OTHER_TENANT, allowedOrigins: [] }, update: {} });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describeRepositoryContract('Postgres', async () => ({
    repos: createPrismaRepositories(prisma),
    tenantId: seed.tenant.id,
    otherTenantId: OTHER_TENANT.id,
  }));

  describe('DB에서만 뜻이 있는 것', () => {
    it('없는 테넌트로는 대화를 만들 수 없다 (FK) — 메모리 구현은 이걸 잡지 못한다', async () => {
      const repos = createPrismaRepositories(prisma);
      const id = randomUUID();
      await expect(repos.conversations.appendTurn(id, 'no-such-tenant', turn('x', 'y'))).rejects.toThrow();
      expect(await prisma.conversation.findUnique({ where: { id } })).toBeNull();
    });

    it('턴은 한 트랜잭션 — 핸드오프 저장이 실패하면 대화·질문·답변도 남지 않는다', async () => {
      const repos = createPrismaRepositories(prisma);
      const id = randomUUID();
      // enum에 없는 값은 Prisma가 거부한다. 대화 upsert와 메시지 insert 뒤에 터지므로 되돌리기가 실제로 일어나는지 본다.
      const bogus = turn('q', 'a', { reason: 'bogus' as HandoffReason, summary: null });
      await expect(repos.conversations.appendTurn(id, seed.tenant.id, bogus)).rejects.toThrow();
      expect(await repos.conversations.find(id, seed.tenant.id)).toBeNull();
      expect(await prisma.message.count({ where: { conversationId: id } })).toBe(0);
    });

    it('다른 클라이언트(프로세스)에서도 같은 대화가 보인다 — 메모리와 다른 점', async () => {
      const id = randomUUID();
      await createPrismaRepositories(prisma).conversations.appendTurn(id, seed.tenant.id, turn('q', 'a'));
      const other = createPrismaClient(url as string);
      try {
        const found = await createPrismaRepositories(other).conversations.find(id, seed.tenant.id);
        expect(found?.messages.map((m) => m.content)).toEqual(['q', 'a']);
      } finally {
        await other.$disconnect();
      }
    });

    it('지식 순서는 DB 콜레이션과 무관하다 — 코드 단위 비교로 고정', async () => {
      // 구두점이 섞인 id. 로캘 콜레이션(en_US 등)은 구두점을 뒤로 미루거나 무시할 수 있어 ORDER BY id와 다를 수 있다.
      const ids = ['ab', 'a:b', 'a-b', 'a_b'];
      await prisma.knowledgeItem.createMany({
        data: ids.map((id) => ({ tenantId: OTHER_TENANT.id, id, title: id, category: 'c', blocks: ['x'] })),
      });
      try {
        const items = await createPrismaRepositories(prisma).knowledge.listByTenant(OTHER_TENANT.id);
        expect(items.map((k) => k.id)).toEqual([...ids].sort());
      } finally {
        await prisma.knowledgeItem.deleteMany({ where: { tenantId: OTHER_TENANT.id } });
      }
    });

    it('콘솔 키 해시: 시드가 넘기면 저장, 안 넘기면 그대로, null이면 지움 — 시드 파일에는 비밀이 없다', async () => {
      const key = () => createPrismaRepositories(prisma).tenants.findByKey(seed.tenant.apiKey).then((t) => t?.consoleKeyHash);
      await applySeed(prisma, seed, { consoleKeyHash: 'scrypt$salt$hash' });
      expect(await key()).toBe('scrypt$salt$hash');
      await applySeed(prisma, seed);
      expect(await key()).toBe('scrypt$salt$hash');
      await applySeed(prisma, seed, { consoleKeyHash: null });
      expect(await key()).toBeNull();
    });

    it('같은 멱등 키로 동시에 다섯 번 넣어도 원장에는 한 줄 — UNIQUE 제약 + skipDuplicates', async () => {
      const repos = createPrismaRepositories(prisma);
      const key = `adj:${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 5 }, () => repos.credits.append(OTHER_TENANT.id, { delta: 3, reason: 'adjustment', idempotencyKey: key })),
      );
      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(new Set(results.map((r) => r.entry.id)).size).toBe(1);
      expect(await prisma.creditLedger.count({ where: { tenantId: OTHER_TENANT.id, idempotencyKey: key } })).toBe(1);
    });

    it('시드의 초기 크레딧은 한 번만 — 다시 시드해도, 숫자를 바꿔도 원장은 그대로', async () => {
      await applySeed(prisma, seed);
      const before = await createPrismaRepositories(prisma).credits.balance(seed.tenant.id);
      await applySeed(prisma, { ...seed, initialCredits: 999 });
      expect(await createPrismaRepositories(prisma).credits.balance(seed.tenant.id)).toBe(before);
      expect(await prisma.creditLedger.count({ where: { tenantId: seed.tenant.id, reason: 'seed' } })).toBe(1);
    });

    it('시드는 몇 번을 넣어도 같다 — 바뀐 항목은 덮어쓰고, 빠진 항목은 지운다', async () => {
      const count = () => prisma.knowledgeItem.count({ where: { tenantId: seed.tenant.id } });
      await applySeed(prisma, seed);
      expect(await count()).toBe(seed.knowledge.length);

      const [first, ...rest] = seed.knowledge;
      if (!first) throw new Error('시드가 비어 있다');
      await applySeed(prisma, { ...seed, knowledge: [{ ...first, title: '바뀐 제목' }, ...rest.slice(1)] });
      expect(await count()).toBe(seed.knowledge.length - 1);
      const changed = await prisma.knowledgeItem.findUnique({ where: { tenantId_id: { tenantId: seed.tenant.id, id: first.id } } });
      expect(changed?.title).toBe('바뀐 제목');

      await applySeed(prisma, seed);
      expect(await count()).toBe(seed.knowledge.length);
      expect((await createPrismaRepositories(prisma).tenants.findByKey(seed.tenant.apiKey))?.name).toBe(seed.tenant.name);
    });
  });
});
