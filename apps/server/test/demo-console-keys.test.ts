import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MockEngine } from '../src/engine/mock.js';
import { createRepositories } from '../src/repo/create.js';

// 메모리 저장소(서버 시작)가 데모 회사마다의 콘솔 키 환경변수를 그 회사에만 붙이는지, 실제 로그인으로 본다.
// Postgres의 db:seed(prisma/seed.ts)도 같은 readDemoConsoleKeys를 쓴다.

const OWN_ORIGIN = 'http://console.test';
const frameAssetsDir = mkdtempSync(path.join(tmpdir(), 'qrate-demo-keys-'));
const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  rmSync(frameAssetsDir, { recursive: true, force: true });
});

async function serve(env: NodeJS.ProcessEnv): Promise<{ login: (tenant: string, key: string) => Promise<number>; description: string }> {
  const storage = await createRepositories(loadConfig({ QRATE_REPO: 'memory', ...env }));
  const app = createApp({ engine: new MockEngine(0), repos: storage.repos, publicOrigin: OWN_ORIGIN, frameAssetsDir, console: { secret: 'test-secret-0123456789abcdef' } });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (tenant: string, key: string) =>
    (
      await fetch(`${base}/api/console/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
        body: JSON.stringify({ tenant, key }),
      })
    ).status;
  return { login, description: storage.description };
}

describe('데모 회사 콘솔 키 — 메모리 저장소', () => {
  it('두 키가 있으면 두 회사가 각자 자기 키로만 들어간다. 남의 키로는 401', async () => {
    const { login, description } = await serve({ QRATE_DEMO_CONSOLE_KEY: 'key-for-demo', QRATE_RECEPTION_CONSOLE_KEY: 'key-for-reception' });
    expect(description).toContain('console=on(demo,reception)');
    expect(await login('demo', 'key-for-demo')).toBe(200);
    expect(await login('reception', 'key-for-reception')).toBe(200);
    expect(await login('reception', 'key-for-demo')).toBe(401);
    expect(await login('demo', 'key-for-reception')).toBe(401);
  });

  it('하람바이오 키가 없으면 하람바이오만 들어갈 수 없다. 둘 다 없으면 시작 로그가 두 환경변수 이름을 알린다', async () => {
    const demoOnly = await serve({ QRATE_DEMO_CONSOLE_KEY: 'key-for-demo' });
    expect(demoOnly.description).toContain('console=on(demo)');
    expect(await demoOnly.login('demo', 'key-for-demo')).toBe(200);
    expect(await demoOnly.login('reception', 'key-for-demo')).toBe(401);

    const none = await serve({});
    expect(none.description).toContain('console=off (QRATE_DEMO_CONSOLE_KEY·QRATE_RECEPTION_CONSOLE_KEY 없음)');
  });
});
