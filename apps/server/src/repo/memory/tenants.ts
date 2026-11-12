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
    const tenant = [...this.byKey.values()].find((t) => t.id === id);
    if (!tenant) return false;
    this.byKey.set(tenant.apiKey, { ...tenant, consoleKeyHash });
    return true;
  }
}
