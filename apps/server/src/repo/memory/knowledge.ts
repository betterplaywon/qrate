import { sortKnowledgeById } from '../knowledge-order.js';
import type { KnowledgeItem, KnowledgeRepository } from '../types.js';

const copy = (k: KnowledgeItem): KnowledgeItem => ({ ...k, blocks: [...k.blocks] });
const same = (k: KnowledgeItem, tenantId: string, id: string): boolean => k.tenantId === tenantId && k.id === id;

export class MemoryKnowledgeRepository implements KnowledgeRepository {
  private items: KnowledgeItem[];

  constructor(items: KnowledgeItem[]) {
    this.items = sortKnowledgeById(items.map(copy));
  }

  async listByTenant(tenantId: string): Promise<KnowledgeItem[]> {
    return this.items.filter((k) => k.tenantId === tenantId).map(copy);
  }

  async put(item: KnowledgeItem): Promise<void> {
    this.items = sortKnowledgeById([...this.items.filter((k) => !same(k, item.tenantId, item.id)), copy(item)]);
  }

  async remove(id: string, tenantId: string): Promise<boolean> {
    const before = this.items.length;
    this.items = this.items.filter((k) => !same(k, tenantId, id));
    return this.items.length < before;
  }
}
