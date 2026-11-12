import type { PrismaClient } from '../../generated/prisma/client.js';
import { sortKnowledgeById } from '../knowledge-order.js';
import type { KnowledgeItem, KnowledgeRepository } from '../types.js';

export class PrismaKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByTenant(tenantId: string): Promise<KnowledgeItem[]> {
    const rows = await this.prisma.knowledgeItem.findMany({
      where: { tenantId },
      select: { id: true, tenantId: true, title: true, category: true, blocks: true },
    });
    // 정렬은 DB가 아니라 여기서(knowledge-order.ts) — 콜레이션과 무관하게 메모리 구현과 같은 순서.
    return sortKnowledgeById(rows);
  }

  async put({ tenantId, id, title, category, blocks }: KnowledgeItem): Promise<void> {
    await this.prisma.knowledgeItem.upsert({
      where: { tenantId_id: { tenantId, id } },
      create: { tenantId, id, title, category, blocks },
      update: { title, category, blocks },
    });
  }

  async remove(id: string, tenantId: string): Promise<boolean> {
    const { count } = await this.prisma.knowledgeItem.deleteMany({ where: { tenantId, id } });
    return count > 0;
  }
}
