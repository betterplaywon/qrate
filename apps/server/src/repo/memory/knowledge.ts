import { sortKnowledgeById } from '../knowledge-order.js';
import type { KnowledgeItem, KnowledgeRepository } from '../types.js';

export class MemoryKnowledgeRepository implements KnowledgeRepository {
  private readonly items: KnowledgeItem[];

  constructor(items: KnowledgeItem[]) {
    this.items = sortKnowledgeById(items);
  }

  async listByTenant(tenantId: string): Promise<KnowledgeItem[]> {
    return this.items.filter((k) => k.tenantId === tenantId).map((k) => ({ ...k, blocks: [...k.blocks] }));
  }
}
