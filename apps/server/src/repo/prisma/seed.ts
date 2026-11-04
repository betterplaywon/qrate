import type { PrismaClient } from '../../generated/prisma/client.js';
import type { SeedFile } from '../seed.js';

/**
 * 시드 파일을 DB에 반영한다 — `prisma db seed`(prisma/seed.ts)와 Postgres 계약 테스트가 쓴다.
 * 몇 번을 돌려도 결과가 같다: 테넌트·지식은 upsert, 시드에서 빠진 지식은 지운다. 대화는 건드리지 않는다.
 */
export async function applySeed(
  prisma: PrismaClient,
  seed: SeedFile,
  // 콘솔 키 해시는 시드 파일 밖(환경변수)에서 온다. undefined면 DB의 값을 건드리지 않고, null이면 지운다(로그인 불가).
  { consoleKeyHash }: { consoleKeyHash?: string | null } = {},
): Promise<void> {
  const { tenant, knowledge } = seed;
  await prisma.$transaction(
    async (tx) => {
      const fields = { apiKey: tenant.apiKey, name: tenant.name, allowedOrigins: tenant.allowedOrigins };
      await tx.tenant.upsert({
        where: { id: tenant.id },
        create: { id: tenant.id, ...fields, consoleKeyHash: consoleKeyHash ?? null },
        update: { ...fields, ...(consoleKeyHash === undefined ? {} : { consoleKeyHash }) },
      });
      await tx.knowledgeItem.deleteMany({ where: { tenantId: tenant.id, id: { notIn: knowledge.map((k) => k.id) } } });
      for (const k of knowledge) {
        await tx.knowledgeItem.upsert({
          where: { tenantId_id: { tenantId: tenant.id, id: k.id } },
          create: { tenantId: tenant.id, id: k.id, title: k.title, category: k.category, blocks: k.blocks },
          update: { title: k.title, category: k.category, blocks: k.blocks },
        });
      }
    },
    // 항목 수만큼 문장이 나간다(26개면 28문장). 기본 5초는 느린 CI에서 빠듯할 수 있다.
    { timeout: 30_000 },
  );
}
