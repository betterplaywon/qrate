import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Tenant, TenantRepository } from '../types.js';

function toTenant(t: Prisma.TenantGetPayload<object> | null): Tenant | null {
  return t ? { id: t.id, apiKey: t.apiKey, name: t.name, allowedOrigins: t.allowedOrigins, consoleKeyHash: t.consoleKeyHash } : null;
}

export class PrismaTenantRepository implements TenantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByKey(apiKey: string): Promise<Tenant | null> {
    return toTenant(await this.prisma.tenant.findUnique({ where: { apiKey } }));
  }

  async findById(id: string): Promise<Tenant | null> {
    return toTenant(await this.prisma.tenant.findUnique({ where: { id } }));
  }

  async setConsoleKeyHash(id: string, consoleKeyHash: string | null): Promise<boolean> {
    const { count } = await this.prisma.tenant.updateMany({ where: { id }, data: { consoleKeyHash } });
    return count === 1;
  }

  async setAllowedOrigins(id: string, allowedOrigins: string[]): Promise<boolean> {
    const { count } = await this.prisma.tenant.updateMany({ where: { id }, data: { allowedOrigins } });
    return count === 1;
  }
}
