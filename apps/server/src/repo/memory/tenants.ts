import type { Tenant, TenantRepository } from '../types.js';

function copyTenant(t: Tenant | undefined): Tenant | null {
  return t ? { ...t, allowedOrigins: [...t.allowedOrigins] } : null;
}

export class MemoryTenantRepository implements TenantRepository {
  private readonly byKey = new Map<string, Tenant>();

  constructor(tenants: Tenant[]) {
    for (const t of tenants) this.byKey.set(t.apiKey, t);
  }

  async findByKey(apiKey: string): Promise<Tenant | null> {
    return copyTenant(this.byKey.get(apiKey));
  }

  async findById(id: string): Promise<Tenant | null> {
    return copyTenant([...this.byKey.values()].find((t) => t.id === id));
  }

  async setConsoleKeyHash(id: string, consoleKeyHash: string | null): Promise<boolean> {
    return this.update(id, { consoleKeyHash });
  }

  async setAllowedOrigins(id: string, allowedOrigins: string[]): Promise<boolean> {
    return this.update(id, { allowedOrigins: [...allowedOrigins] });
  }

  private update(id: string, fields: Partial<Pick<Tenant, 'consoleKeyHash' | 'allowedOrigins'>>): boolean {
    const tenant = [...this.byKey.values()].find((t) => t.id === id);
    if (!tenant) return false;
    this.byKey.set(tenant.apiKey, { ...tenant, ...fields });
    return true;
  }
}
