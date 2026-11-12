import { generateConsoleKey, hashConsoleKey } from '../console/key.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { applySeed } from '../repo/prisma.js';
import type { SeedFile } from '../repo/seed.js';
import type { Tenant, TenantRepository } from '../repo/types.js';

// 플랫폼 운영자가 고객사를 받는 일: 회사 등록, 콘솔 키 발급·회수, 목록. 인터넷에 열린 입구는 없고,
// DB에 접속할 수 있는 운영자가 서버 명령(admin/cli.ts)으로만 한다. 회사 파일은 데모 시드와 같은 형식이다.

/** 운영자가 고칠 수 있는 입력 문제. 명령은 이 메시지만 보여 주고 1로 끝난다. */
export class AdminError extends Error {}

/** created: 파일의 FAQ와 초기 크레딧까지 넣었다. updated: 이름·허용 사이트만 바꿨고 knowledge는 그대로 둔 지금의 FAQ 개수다. */
export type AddedTenant =
  | { created: true; tenant: SeedFile['tenant']; knowledge: number; initialCredits: number }
  | { created: false; tenant: SeedFile['tenant']; knowledge: number };

/**
 * 회사 파일 하나를 DB에 넣는다. 다른 회사가 쓰는 키는 받지 않고, 콘솔 키는 건드리지 않는다.
 * 이미 있는 회사는 update일 때 이름과 허용 사이트만 바꾼다. FAQ는 그 회사 담당자가 콘솔에서 고치므로 파일로 덮어쓰지 않는다.
 */
export async function addTenant(prisma: PrismaClient, seed: SeedFile, { update = false }: { update?: boolean } = {}): Promise<AddedTenant> {
  const existing = await prisma.tenant.findUnique({ where: { id: seed.tenant.id } });
  if (existing && !update) throw new AdminError(`이미 있는 회사다(id ${seed.tenant.id}). 이름과 허용 사이트를 파일대로 바꾸려면 --update를 붙인다`);
  // 회사 키는 고객 사이트에 이미 붙인 설치 스니펫에 들어 있다. 바꾸면 그 사이트의 위젯이 조용히 멈춘다.
  if (existing && existing.apiKey !== seed.tenant.apiKey) {
    throw new AdminError(`회사 키는 바꿀 수 없다(지금 ${existing.apiKey}, 파일 ${seed.tenant.apiKey}). 설치한 사이트의 위젯이 멈춘다`);
  }
  const keyOwner = await prisma.tenant.findUnique({ where: { apiKey: seed.tenant.apiKey } });
  if (keyOwner && keyOwner.id !== seed.tenant.id) {
    throw new AdminError(`회사 키 ${seed.tenant.apiKey}는 다른 회사(id ${keyOwner.id})가 쓰고 있다`);
  }
  if (existing) {
    await prisma.tenant.update({ where: { id: existing.id }, data: { name: seed.tenant.name, allowedOrigins: seed.tenant.allowedOrigins } });
    return { created: false, tenant: seed.tenant, knowledge: await prisma.knowledgeItem.count({ where: { tenantId: existing.id } }) };
  }
  await applySeed(prisma, seed);
  return { created: true, tenant: seed.tenant, knowledge: seed.knowledge.length, initialCredits: seed.initialCredits };
}

/** 찾은 뒤 저장하기 전에 회사가 지워졌으면 "발급했다"고 말하지 않는다. */
async function saveConsoleKeyHash(tenants: TenantRepository, tenant: Tenant, hash: string | null): Promise<void> {
  if (!(await tenants.setConsoleKeyHash(tenant.id, hash))) throw new AdminError(`회사(id ${tenant.id})가 그사이 사라졌다`);
}

async function tenantByKey(tenants: TenantRepository, apiKey: string): Promise<Tenant> {
  const tenant = await tenants.findByKey(apiKey);
  if (!tenant) throw new AdminError(`모르는 회사 키: ${apiKey}`);
  return tenant;
}

/**
 * 새 콘솔 키를 만들어 해시만 저장하고 키 원문을 한 번 돌려준다. 원문은 어디에도 남지 않는다.
 * 해시가 바뀌므로 이전 키와, 이전 키로 받은 로그인 세션은 바로 쓸 수 없다(requireSession의 지문 대조).
 */
export async function issueConsoleKey(
  tenants: TenantRepository,
  apiKey: string,
  generate: () => string = generateConsoleKey,
): Promise<{ tenant: Tenant; key: string }> {
  const tenant = await tenantByKey(tenants, apiKey);
  const key = generate();
  await saveConsoleKeyHash(tenants, tenant, hashConsoleKey(key));
  return { tenant, key };
}

/** 콘솔 키를 지운다. 그 회사는 콘솔에 로그인할 수 없고, 열려 있던 세션도 바로 끝난다. */
export async function revokeConsoleKey(tenants: TenantRepository, apiKey: string): Promise<Tenant> {
  const tenant = await tenantByKey(tenants, apiKey);
  await saveConsoleKeyHash(tenants, tenant, null);
  return tenant;
}

export interface TenantRow {
  id: string;
  apiKey: string;
  name: string;
  knowledge: number;
  conversations: number;
  consoleKey: boolean;
  credits: number;
  createdAt: Date;
}

/** 등록 순서대로. 잔액은 콘솔과 같은 원장 합계다. */
export async function listTenants(prisma: PrismaClient): Promise<TenantRow[]> {
  const [tenants, balances] = await Promise.all([
    prisma.tenant.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { knowledge: true, conversations: true } } },
    }),
    prisma.creditLedger.groupBy({ by: ['tenantId'], _sum: { delta: true } }),
  ]);
  const balanceOf = new Map(balances.map((b) => [b.tenantId, b._sum.delta ?? 0]));
  return tenants.map((t) => ({
    id: t.id,
    apiKey: t.apiKey,
    name: t.name,
    knowledge: t._count.knowledge,
    conversations: t._count.conversations,
    consoleKey: t.consoleKeyHash !== null,
    credits: balanceOf.get(t.id) ?? 0,
    createdAt: t.createdAt,
  }));
}
