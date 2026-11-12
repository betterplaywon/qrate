import { MAX_ALLOWED_ORIGINS, type ApiErrorBody, type InstallStatusResponse } from '@qrate/contracts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashConsoleKey } from '../src/console/key.js';
import { MockEngine } from '../src/engine/mock.js';
import { createRepositoriesFromSeeds, loadSeedFiles } from '../src/repo/seed.js';

// 콘솔 설치 안내(/api/console/install)와 서버가 주는 위젯 런처(/widget.js)를 실제 HTTP로 본다.
// 허용 사이트는 대화창(/frame)의 CSP frame-ancestors와 부모 오리진 검사에 그대로 쓰이므로, 바꾼 뒤 /frame의 답까지 확인한다.

const OWN_ORIGIN = 'http://console.test';
const SECRET = 'test-secret-0123456789abcdef';
const KEYS = { demo: 'demo-console-key', reception: 'reception-console-key' } as const;
type Company = keyof typeof KEYS;
const dir = mkdtempSync(path.join(tmpdir(), 'qrate-install-'));
const frameAssetsDir = path.join(dir, 'frame');
const widgetScript = path.join(dir, 'widget.js');
const WIDGET_SOURCE = '(()=>{/* launcher */})();\n';

let server: Server;
let baseUrl: string;
const cookies = {} as Record<Company, string>;

function serve(app: ReturnType<typeof createApp>): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
  });
}

beforeAll(async () => {
  writeFileSync(widgetScript, WIDGET_SOURCE);
  const repos = createRepositoriesFromSeeds(loadSeedFiles(), {
    consoleKeyHashes: { demo: hashConsoleKey(KEYS.demo), reception: hashConsoleKey(KEYS.reception) },
  });
  ({ server, url: baseUrl } = await serve(
    createApp({ engine: new MockEngine(0), repos, publicOrigin: OWN_ORIGIN, frameAssetsDir, widgetScript, console: { secret: SECRET } }),
  ));
  for (const company of Object.keys(KEYS) as Company[]) {
    const res = await fetch(`${baseUrl}/api/console/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
      body: JSON.stringify({ tenant: company, key: KEYS[company] }),
    });
    expect(res.status).toBe(200);
    cookies[company] = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      rmSync(dir, { recursive: true, force: true });
      server.close(() => resolve());
    }),
);

const installUrl = `/api/console/install`;

async function status(company: Company): Promise<InstallStatusResponse> {
  const res = await fetch(`${baseUrl}${installUrl}`, { headers: { cookie: cookies[company] } });
  expect(res.status).toBe(200);
  return (await res.json()) as InstallStatusResponse;
}

function putOrigins(company: Company | null, body: unknown, origin: string | null = OWN_ORIGIN) {
  return fetch(`${baseUrl}${installUrl}/origins`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(company ? { cookie: cookies[company] } : {}), ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

const frame = (tenant: string, parent: string) => fetch(`${baseUrl}/frame?t=${tenant}&o=${encodeURIComponent(parent)}`);
const errorOf = async (res: Response): Promise<string> => ((await res.json()) as ApiErrorBody).error;

describe('설치 안내 — GET /api/console/install', () => {
  it('세션의 회사 키·스크립트 주소·허용 사이트를 주고, 대화창이 열린 적 없으면 lastOpenedAt은 null. 세션이 없으면 401', async () => {
    expect(await status('demo')).toEqual({
      tenantKey: 'demo',
      scriptUrl: `${OWN_ORIGIN}/widget.js`,
      allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
      lastOpenedAt: null,
    });
    expect((await status('reception')).tenantKey).toBe('reception');
    expect((await fetch(`${baseUrl}${installUrl}`)).status).toBe(401);
    expect((await fetch(`${baseUrl}${installUrl}`, { headers: { cookie: cookies.demo } })).headers.get('cache-control')).toBe('no-store');
  });

  it('대화창이 열렸다는 사건(widget_open)이 오면 그 회사의 lastOpenedAt만 그 시각이 된다', async () => {
    const before = Date.now();
    const opened = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
      body: JSON.stringify({ tenant: 'demo', type: 'widget_open' }),
    });
    expect(opened.status).toBe(202);
    // 사건 기록은 응답을 기다리게 하지 않는다(events/sink.ts). 저장될 때까지 다시 묻는다.
    await expect.poll(async () => (await status('demo')).lastOpenedAt).not.toBeNull();
    const at = Date.parse((await status('demo')).lastOpenedAt ?? '');
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect((await status('reception')).lastOpenedAt).toBeNull();
  });
});

describe('허용 사이트 — PUT /api/console/install/origins', () => {
  it('목록을 통째로 바꾸고(같은 값은 한 번) 바로 다음 대화창 요청부터 그 사이트에서만 열린다. 다른 회사는 그대로다', async () => {
    const res = await putOrigins('reception', { origins: ['https://www.haram-bio.example', 'https://visit.haram-bio.example', 'https://www.haram-bio.example'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InstallStatusResponse;
    expect(body.allowedOrigins).toEqual(['https://www.haram-bio.example', 'https://visit.haram-bio.example']);
    expect((await status('reception')).allowedOrigins).toEqual(body.allowedOrigins);

    const allowed = await frame('reception', 'https://visit.haram-bio.example');
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-security-policy')).toContain('frame-ancestors https://www.haram-bio.example https://visit.haram-bio.example');
    expect((await frame('reception', 'http://localhost:5173')).status).toBe(403);
    expect((await frame('demo', 'http://localhost:5173')).status).toBe(200);
    expect((await status('demo')).allowedOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('빈 목록도 받는다. 그때는 어느 사이트에서도 대화창이 열리지 않는다', async () => {
    expect((await putOrigins('reception', { origins: [] })).status).toBe(200);
    const res = await frame('reception', 'https://www.haram-bio.example');
    expect(res.status).toBe(403);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect((await putOrigins('reception', { origins: ['http://localhost:5173', 'http://127.0.0.1:5173'] })).status).toBe(200);
  });

  it(`정규형 오리진이 아니거나 ${MAX_ALLOWED_ORIGINS}개를 넘으면 400 invalid_origins이고 목록은 그대로다`, async () => {
    const before = (await status('demo')).allowedOrigins;
    const bad: unknown[] = [
      { origins: ['https://Shop.example.com'] },
      { origins: ['https://shop.example.com/'] },
      { origins: ['https://shop.example.com/visit'] },
      { origins: ['shop.example.com'] },
      { origins: ['https://*.example.com'] },
      { origins: ['ftp://shop.example.com'] },
      { origins: ['javascript:alert(1)'] },
      { origins: ['https://shop.example.com:443'] },
      { origins: ['https://shop.example.com https://evil.example'] },
      // URL 파서가 그대로 두는 호스트 글자. frame-ancestors에 지시어가 끼어들어 등록한 사이트까지 막혔다
      { origins: ['https://a.com,b.com', 'https://www.haram-bio.example'] },
      { origins: ['https://example.com;sandbox'] },
      { origins: ["https://'self'"] },
      { origins: ['https://example.com.'] },
      { origins: ['https://[::1]:8443'] },
      { origins: [''] },
      { origins: [42] },
      { origins: 'https://shop.example.com' },
      {},
      { origins: Array.from({ length: MAX_ALLOWED_ORIGINS + 1 }, (_, i) => `https://s${i}.example.com`) },
    ];
    for (const body of bad) {
      const res = await putOrigins('demo', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await errorOf(res)).toBe('invalid_origins');
    }
    expect((await status('demo')).allowedOrigins).toEqual(before);
    const max = Array.from({ length: MAX_ALLOWED_ORIGINS }, (_, i) => `https://s${i}.example.com`);
    expect((await putOrigins('demo', { origins: max })).status).toBe(200);
    expect((await putOrigins('demo', { origins: before })).status).toBe(200);
  });

  it('다른 오리진·Origin: null에서 온 PUT은 403, 세션이 없으면 401이고 목록은 그대로다', async () => {
    const before = (await status('demo')).allowedOrigins;
    for (const origin of ['https://evil.example', 'null']) {
      const res = await putOrigins('demo', { origins: ['https://evil.example'] }, origin);
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe('origin_not_allowed');
    }
    expect((await putOrigins(null, { origins: ['https://evil.example'] })).status).toBe(401);
    expect((await status('demo')).allowedOrigins).toEqual(before);
  });
});

describe('위젯 런처 — GET /widget.js', () => {
  it('빌드한 런처 파일을 자바스크립트로 준다. 다른 사이트가 <script>로 읽게 CORP를 열고 5분 캐시한다', async () => {
    const res = await fetch(`${baseUrl}/widget.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^(text|application)\/javascript/);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(WIDGET_SOURCE);
  });

  it('런처 파일이 점으로 시작하는 폴더 아래에 있어도 준다(배포 경로의 .local·.cache 같은 폴더)', async () => {
    const hidden = path.join(dir, '.deploy', 'widget');
    mkdirSync(hidden, { recursive: true });
    writeFileSync(path.join(hidden, 'widget.js'), WIDGET_SOURCE);
    const repos = createRepositoriesFromSeeds(loadSeedFiles());
    const other = await serve(
      createApp({ engine: new MockEngine(0), repos, publicOrigin: OWN_ORIGIN, frameAssetsDir, widgetScript: path.join(hidden, 'widget.js') }),
    );
    try {
      const res = await fetch(`${other.url}/widget.js`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(WIDGET_SOURCE);
    } finally {
      await new Promise<void>((resolve) => other.server.close(() => resolve()));
    }
  });

  it('런처 파일을 넘기지 않았거나 파일이 없으면 404 JSON이다', async () => {
    const repos = createRepositoriesFromSeeds(loadSeedFiles());
    for (const options of [{}, { widgetScript: path.join(dir, 'missing.js') }]) {
      const other = await serve(createApp({ engine: new MockEngine(0), repos, publicOrigin: OWN_ORIGIN, frameAssetsDir, ...options }));
      try {
        const res = await fetch(`${other.url}/widget.js`);
        expect(res.status).toBe(404);
        expect(await errorOf(res)).toBe('not_found');
      } finally {
        await new Promise<void>((resolve) => other.server.close(() => resolve()));
      }
    }
  });
});
