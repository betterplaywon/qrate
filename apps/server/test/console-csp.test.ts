import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockProvider } from '../src/billing/mock.js';
import type { PaymentProvider } from '../src/billing/provider.js';
import { createTossProvider, parseTossKeys } from '../src/billing/toss.js';
import { MockEngine } from '../src/engine/mock.js';
import { consoleCsp } from '../src/http/console/static.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from '../src/repo/seed.js';

// 콘솔 문서 CSP는 사람이 머지하는 보안 경계라 글자 그대로 고정한다. 토스 호스트는 결제창형 SDK를 실제로 띄워 위반 0을 확인한 목록이다.

const BASE = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const TOSS =
  "default-src 'self'; script-src 'self' https://js.tosspayments.com; " +
  "connect-src 'self' https://api.tosspayments.com https://apigw-sandbox.tosspayments.com https://event.tosspayments.com https://log.tosspayments.com; " +
  "frame-src 'self' https://payment-widget.tosspayments.com https://payment-gateway-sandbox.tosspayments.com https://toss.im; " +
  "frame-ancestors 'none'; base-uri 'none'";

const seed = loadSeedFile(DEFAULT_SEED_PATH);
const scratch = mkdtempSync(path.join(tmpdir(), 'qrate-console-csp-'));
const consoleAssetsDir = path.join(scratch, 'console');
mkdirSync(path.join(consoleAssetsDir, 'assets'), { recursive: true });
writeFileSync(path.join(consoleAssetsDir, 'index.html'), '<!doctype html><div id="root"></div>');
writeFileSync(path.join(consoleAssetsDir, 'assets', 'app.js'), 'export {};');
const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  rmSync(scratch, { recursive: true, force: true });
});

async function serve(payments: PaymentProvider | null): Promise<string> {
  const app = createApp({
    engine: new MockEngine(0),
    repos: createRepositoriesFromSeed(seed),
    publicOrigin: 'http://console.test',
    frameAssetsDir: scratch,
    consoleAssetsDir,
    payments,
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('콘솔 문서 CSP — 켜진 결제 방법이 여는 출처만 더한다', () => {
  it('모의 제공자와 제공자 없음은 지금 문자열과 글자 그대로 같다', () => {
    expect(consoleCsp('mock')).toBe(BASE);
    expect(consoleCsp(null)).toBe(BASE);
  });

  it('토스는 측정한 호스트만 더하고, 더한 지시문 앞에 self를 둔다. 와일드카드·unsafe 키워드는 없다', () => {
    expect(consoleCsp('toss')).toBe(TOSS);
    for (const provider of ['mock', 'toss', null] as const) expect(consoleCsp(provider)).not.toMatch(/\*|unsafe-|data:|blob:/);
  });

  it('켜진 제공자에 맞는 CSP가 index.html에만 붙는다', async () => {
    const keys = parseTossKeys({ clientKey: 'test_gck_fake0001', secretKey: 'test_gsk_fake0001' });
    const toss = await serve(createTossProvider({ ...keys, fetch: () => Promise.reject(new Error('콘솔 문서는 토스를 부르지 않는다')) }));
    const mock = await serve(createMockProvider('mock-secret-0123456789abcdef'));
    const none = await serve(null);

    for (const [origin, csp] of [
      [toss, TOSS],
      [mock, BASE],
      [none, BASE],
    ] as const) {
      const doc = await fetch(`${origin}/console/`);
      expect(doc.status).toBe(200);
      expect(doc.headers.get('content-security-policy')).toBe(csp);
    }
    const asset = await fetch(`${toss}/console/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-security-policy')).toBeNull();
  });
});
