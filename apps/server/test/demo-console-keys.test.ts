import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRepositories } from '../src/repo/create.js';
import { startApp } from './helpers/app.js';

// 메모리 저장소(서버 시작)가 데모 회사마다의 콘솔 키 환경변수를 그 회사에만 붙이는지, 실제 로그인으로 본다.
// Postgres의 db:seed(prisma/seed.ts)도 같은 readDemoConsoleKeys를 쓴다.

const OWN_ORIGIN = 'http://console.test';
const closers: (() => Promise<void>)[] = [];

afterAll(() => Promise.all(closers.map((close) => close())));

async function serve(env: NodeJS.ProcessEnv): Promise<{ login: (tenant: string, key: string) => Promise<number>; description: string }> {
  const storage = await createRepositories(loadConfig({ QRATE_REPO: 'memory', ...env }));
  const { url, close } = await startApp({ repos: storage.repos, publicOrigin: OWN_ORIGIN, console: { secret: 'test-secret-0123456789abcdef' } });
  closers.push(close);
  const login = async (tenant: string, key: string) =>
    (
      await fetch(`${url}/api/console/login`, {
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
