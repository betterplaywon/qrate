import type { ConsoleSessionResponse } from '@qrate/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminError, addTenant, issueConsoleKey, listTenants } from '../src/admin/tenants.js';
import { createApp } from '../src/app.js';
import { MockEngine } from '../src/engine/mock.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createPrismaClient, createPrismaRepositories } from '../src/repo/prisma.js';
import type { SeedFile } from '../src/repo/seed.js';

// 회사가 늘어나는 장면: 플랫폼 운영자가 세 번째 회사를 파일 하나로 등록하고, 콘솔 키를 발급하고, 그 회사 담당자가 로그인한다.
// Postgres 전용(회사 등록과 키 발급은 DB를 쓰는 서버의 일이다). QRATE_TEST_DATABASE_URL이 없으면 건너뛴다(repo-postgres.test.ts 머리말).

const url = process.env.QRATE_TEST_DATABASE_URL;
const OWN_ORIGIN = 'http://console.test';
const SECRET = 'test-secret-0123456789abcdef';
const ACME = 'admin-test-acme';

const acme = (blocks: string[]): SeedFile => ({
  tenant: { id: ACME, apiKey: ACME, name: '시험용 세 번째 회사', allowedOrigins: ['https://shop.acme.example'] },
  knowledge: [{ id: 'faq:hours', title: '운영 시간', category: '안내', blocks }],
  initialCredits: 50,
});

async function removeAcme(prisma: PrismaClient): Promise<void> {
  await prisma.knowledgeItem.deleteMany({ where: { tenantId: ACME } });
  await prisma.creditLedger.deleteMany({ where: { tenantId: ACME } });
  await prisma.tenant.deleteMany({ where: { id: ACME } });
}

describe.skipIf(!url)('회사 등록과 콘솔 키 발급 — Postgres', () => {
  let prisma: PrismaClient;
  const frameAssetsDir = mkdtempSync(path.join(tmpdir(), 'qrate-admin-pg-'));

  beforeAll(async () => {
    prisma = createPrismaClient(url as string);
    await removeAcme(prisma);
  });

  afterAll(async () => {
    await removeAcme(prisma);
    await prisma.$disconnect();
    rmSync(frameAssetsDir, { recursive: true, force: true });
  });

  it('파일 하나로 세 번째 회사를 등록하면 목록에 FAQ·크레딧과 함께 나오고, 콘솔 키는 아직 없다', async () => {
    const added = await addTenant(prisma, acme(['평일 9시부터 6시까지 운영합니다.']));
    expect(added).toMatchObject({ created: true, knowledge: 1, initialCredits: 50 });
    const row = (await listTenants(prisma)).find((r) => r.id === ACME);
    expect(row).toMatchObject({ apiKey: ACME, name: '시험용 세 번째 회사', knowledge: 1, conversations: 0, consoleKey: false, credits: 50 });
  });

  it('이미 있는 회사는 --update일 때만 이름·허용 사이트를 바꾸고 FAQ와 크레딧은 그대로 둔다(FAQ는 콘솔에서 고친다). 다른 회사의 키는 받지 않는다', async () => {
    await expect(addTenant(prisma, acme(['바뀐 문장']))).rejects.toBeInstanceOf(AdminError);
    const renamed: SeedFile = {
      ...acme(['파일에 새로 쓴 문장']),
      tenant: { ...acme(['x']).tenant, name: '이름을 바꾼 회사', allowedOrigins: ['https://www.acme.example'] },
      initialCredits: 999,
    };
    expect(await addTenant(prisma, renamed, { update: true })).toEqual({ created: false, tenant: renamed.tenant, knowledge: 1 });
    const repos = createPrismaRepositories(prisma);
    expect((await repos.knowledge.listByTenant(ACME)).map((k) => k.blocks)).toEqual([['평일 9시부터 6시까지 운영합니다.']]);
    expect(await repos.tenants.findById(ACME)).toMatchObject({ name: '이름을 바꾼 회사', allowedOrigins: ['https://www.acme.example'] });
    expect(await repos.credits.balance(ACME)).toBe(50);
    await addTenant(prisma, acme(['x']), { update: true }); // 다음 시험이 보는 이름으로 되돌린다

    const stealsDemoKey: SeedFile = { ...acme(['x']), tenant: { ...acme(['x']).tenant, id: 'admin-test-other', apiKey: 'demo' } };
    await expect(addTenant(prisma, stealsDemoKey)).rejects.toThrow(/다른 회사\(id demo\)/);

    // 설치한 사이트의 스니펫에 든 회사 키는 --update로도 바꾸지 않는다
    const renamedKey: SeedFile = { ...acme(['x']), tenant: { ...acme(['x']).tenant, apiKey: 'admin-test-acme-2' } };
    await expect(addTenant(prisma, renamedKey, { update: true })).rejects.toThrow(/회사 키는 바꿀 수 없다/);
    expect((await repos.tenants.findById(ACME))?.apiKey).toBe(ACME);
  });

  it('발급한 키로 그 회사 담당자가 로그인하고, 다시 발급하면 이전 세션이 끝난다', async () => {
    const repos = createPrismaRepositories(prisma);
    const app = createApp({ engine: new MockEngine(0), repos, publicOrigin: OWN_ORIGIN, frameAssetsDir, console: { secret: SECRET } });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console`;
    const login = (key: string) =>
      fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
        body: JSON.stringify({ tenant: ACME, key }),
      });
    try {
      const first = await issueConsoleKey(repos.tenants, ACME);
      const res = await login(first.key);
      expect(res.status).toBe(200);
      const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const me = await fetch(`${base}/me`, { headers: { cookie } });
      expect(((await me.json()) as ConsoleSessionResponse).tenant).toEqual({ id: ACME, name: '시험용 세 번째 회사' });
      expect((await listTenants(prisma)).find((r) => r.id === ACME)?.consoleKey).toBe(true);

      await issueConsoleKey(repos.tenants, ACME);
      expect((await fetch(`${base}/me`, { headers: { cookie } })).status).toBe(401);
      expect((await login(first.key)).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
