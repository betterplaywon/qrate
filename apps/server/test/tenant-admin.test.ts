import type { ConsoleSessionResponse } from '@qrate/contracts';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminError, issueConsoleKey, revokeConsoleKey } from '../src/admin/tenants.js';
import { CONSOLE_KEY_PREFIX, consoleKeyFingerprint, generateConsoleKey, hashConsoleKey, verifyConsoleKey } from '../src/console/key.js';
import { createRepositoriesFromSeeds, loadSeedFiles } from '../src/repo/seed.js';
import type { Repositories, TenantRepository } from '../src/repo/types.js';
import { startApp } from './helpers/app.js';

// 플랫폼 운영자의 회사·콘솔 키 관리(admin/tenants.ts)와, 키를 바꾸거나 회수했을 때 콘솔 세션이 바로 끝나는지를 실제 HTTP로 본다.
// 저장소는 데모 시드 둘(demo, reception)을 올린 메모리. Postgres에서의 회사 등록은 tenant-admin-postgres.test.ts가 본다.

const OWN_ORIGIN = 'http://console.test';
const SECRET = 'test-secret-0123456789abcdef';
const DEMO_KEY = 'demo-console-key';

let baseUrl: string;
let repos: Repositories;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  repos = createRepositoriesFromSeeds(loadSeedFiles(), { consoleKeyHashes: { demo: hashConsoleKey(DEMO_KEY) } });
  ({ url: baseUrl, close: closeApp } = await startApp({ repos, publicOrigin: OWN_ORIGIN, console: { secret: SECRET } }));
});

afterAll(() => closeApp());

const api = (p: string) => `${baseUrl}/api/console${p}`;

function login(tenant: string, key: string) {
  return fetch(api('/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
    body: JSON.stringify({ tenant, key }),
  });
}

/** 로그인해서 세션 쿠키(이름=값)를 돌려준다. */
async function sessionOf(tenant: string, key: string): Promise<string> {
  const res = await login(tenant, key);
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

const me = (cookie: string) => fetch(api('/me'), { headers: { cookie } });

describe('콘솔 키 만들기', () => {
  it('발급 키는 앞머리 qrc_와 무작위 32바이트(base64url 43자)이고 매번 다르다', () => {
    const a = generateConsoleKey();
    const b = generateConsoleKey();
    expect(a.startsWith(CONSOLE_KEY_PREFIX)).toBe(true);
    expect(a).toMatch(/^qrc_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('같은 키도 해시할 때마다 소금이 달라 지문이 바뀐다 — 다시 발급하면 그 전 세션이 끝나는 이유', () => {
    const key = generateConsoleKey();
    expect(consoleKeyFingerprint(hashConsoleKey(key))).not.toBe(consoleKeyFingerprint(hashConsoleKey(key)));
  });
});

describe('회사 콘솔 키 발급·회수 — 메모리 저장소와 실제 HTTP', () => {
  it('발급한 키로만 그 회사 콘솔에 들어가고, 원문은 저장되지 않는다', async () => {
    expect((await login('reception', 'anything')).status).toBe(401);
    const { tenant, key } = await issueConsoleKey(repos.tenants, 'reception');
    expect(tenant.name).toBe('하람바이오');
    const stored = (await repos.tenants.findByKey('reception'))?.consoleKeyHash ?? null;
    expect(stored).not.toBeNull();
    expect(stored).not.toContain(key);
    expect(await verifyConsoleKey(key, stored)).toBe(true);

    const cookie = await sessionOf('reception', key);
    const res = await me(cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ConsoleSessionResponse).tenant).toEqual({ id: 'reception', name: '하람바이오' });
  });

  it('다시 발급하면 이전 키로는 못 들어오고, 이전 키로 열어 둔 세션도 다음 요청부터 401이다. 다른 회사 세션은 그대로다', async () => {
    const first = await issueConsoleKey(repos.tenants, 'reception');
    const receptionSession = await sessionOf('reception', first.key);
    const demoSession = await sessionOf('demo', DEMO_KEY);
    expect((await me(receptionSession)).status).toBe(200);

    const second = await issueConsoleKey(repos.tenants, 'reception');
    expect((await me(receptionSession)).status).toBe(401);
    expect((await login('reception', first.key)).status).toBe(401);
    expect((await me(await sessionOf('reception', second.key))).status).toBe(200);
    expect((await me(demoSession)).status).toBe(200);
  });

  it('회수하면 그 회사는 로그인할 수 없고 열려 있던 세션도 끝난다', async () => {
    const { key } = await issueConsoleKey(repos.tenants, 'reception');
    const cookie = await sessionOf('reception', key);
    await revokeConsoleKey(repos.tenants, 'reception');
    expect((await repos.tenants.findByKey('reception'))?.consoleKeyHash).toBeNull();
    expect((await me(cookie)).status).toBe(401);
    expect((await login('reception', key)).status).toBe(401);
  });

  it('모르는 회사 키는 발급·회수 모두 운영자가 읽을 오류로 거절한다', async () => {
    await expect(issueConsoleKey(repos.tenants, 'nope')).rejects.toBeInstanceOf(AdminError);
    await expect(revokeConsoleKey(repos.tenants, 'nope')).rejects.toThrow(/모르는 회사 키: nope/);
  });
});

describe('관리 명령의 실수 안내', () => {
  const cli = path.join(import.meta.dirname, '..', 'src', 'admin', 'cli.ts');
  const runCli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--conditions=source', '--import', 'tsx', cli, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
    });

  it('모르는 옵션, DATABASE_URL 없음, 없는 회사 파일은 스택 없이 [admin] 안내와 1로 끝난다', () => {
    const unknownOption = runCli(['tenant:list', '--nope']);
    expect(unknownOption.status).toBe(1);
    expect(unknownOption.stderr).toMatch(/^\[admin\] .*nope/m);
    expect(unknownOption.stderr).not.toMatch(/\n\s+at /);

    const noDb = runCli(['tenant:list']);
    expect(noDb.status).toBe(1);
    expect(noDb.stderr).toContain('DATABASE_URL이 필요하다');

    // 파일을 먼저 읽으므로 DB에 닿기 전에 끝난다(주소는 연결되지 않는 값이어도 된다)
    const noFile = runCli(['tenant:add', '/no/such/company.json'], { DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none' });
    expect(noFile.status).toBe(1);
    expect(noFile.stderr).toContain('회사 파일을 읽지 못했다: /no/such/company.json');
    expect(noFile.stderr).not.toMatch(/\n\s+at /);
  });

  it('찾은 뒤 저장 전에 회사가 사라지면 발급했다고 하지 않는다', async () => {
    const tenant = { id: 'gone', apiKey: 'gone', name: '사라진 회사', allowedOrigins: [], consoleKeyHash: null };
    const vanishing: TenantRepository = {
      findByKey: async () => tenant,
      findById: async () => tenant,
      setConsoleKeyHash: async () => false,
      setAllowedOrigins: async () => false,
    };
    await expect(issueConsoleKey(vanishing, 'gone')).rejects.toThrow(/그사이 사라졌다/);
    await expect(revokeConsoleKey(vanishing, 'gone')).rejects.toThrow(/그사이 사라졌다/);
  });
});
