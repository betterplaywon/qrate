import { defineConfig, devices } from '@playwright/test';
import { CONSOLE_KEY, SERVER_ORIGIN } from './e2e/servers';

// 콘솔 브라우저 E2E — 빌드 산출물로만 돈다: 서버 dist(목업 엔진·메모리 저장소)가 콘솔 dist를 /console/ 로 서빙한다.
// 먼저 루트에서 `pnpm build`. 브라우저는 위젯 E2E와 같은 Chromium(처음 한 번 `pnpm --filter @qrate/widget exec playwright install chromium`).
// 실행: 루트 `pnpm e2e`(위젯 → 콘솔 순서) 또는 이 패키지에서 `pnpm e2e`.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: SERVER_ORIGIN, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // node를 직접 실행한다(--env-file 없음) — apps/server/.env를 읽지 않는다. 엔진 목업·저장소 메모리·콘솔 키·세션 비밀은 여기서 고정.
    command: 'node ../server/dist/index.js',
    url: `${SERVER_ORIGIN}/healthz`,
    env: {
      QRATE_ENGINE: 'mock',
      QRATE_REPO: 'memory',
      PORT: '8788',
      QRATE_PUBLIC_ORIGIN: SERVER_ORIGIN,
      QRATE_DEMO_CONSOLE_KEY: CONSOLE_KEY,
      QRATE_CONSOLE_SECRET: 'e2e-session-secret-0123456789',
    },
    reuseExistingServer: false,
  },
});
