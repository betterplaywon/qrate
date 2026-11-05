import type { PrismaClient } from './prisma/client.js';
import { PrismaConversationRepository } from './prisma/conversations.js';
import { PrismaCreditRepository } from './prisma/credits.js';
import { PrismaHandoffRepository } from './prisma/handoffs.js';
import { PrismaKnowledgeRepository } from './prisma/knowledge.js';
import { PrismaTenantRepository } from './prisma/tenants.js';
import { PrismaTopUpRepository } from './prisma/top-ups.js';
import type { Repositories } from './types.js';

// Prisma(Postgres) 구현 — 저장소 계약(types.ts)의 두 번째 구현. 메모리 구현과 같은 계약 테스트(test/repo-contract.ts)를 돈다.
// 계약의 저장소 하나가 prisma/ 아래 파일 하나다(tenants·knowledge·conversations·handoffs·credits·top-ups). 공용 조각은 client(연결)·cursor(키셋 조각)·seed.

export { applySeed } from './prisma/seed.js';
export { createPrismaClient } from './prisma/client.js';
export {
  PrismaConversationRepository,
  PrismaCreditRepository,
  PrismaHandoffRepository,
  PrismaKnowledgeRepository,
  PrismaTenantRepository,
  PrismaTopUpRepository,
};

export function createPrismaRepositories(prisma: PrismaClient): Repositories {
  return {
    tenants: new PrismaTenantRepository(prisma),
    knowledge: new PrismaKnowledgeRepository(prisma),
    conversations: new PrismaConversationRepository(prisma),
    handoffs: new PrismaHandoffRepository(prisma),
    credits: new PrismaCreditRepository(prisma),
    topUps: new PrismaTopUpRepository(prisma),
  };
}
