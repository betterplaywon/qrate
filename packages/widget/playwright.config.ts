import { defineConfig, devices } from '@playwright/test';
import { DEMO_ORIGIN, NOT_ALLOWED_DEMO_ORIGIN, SERVER_ORIGIN } from './e2e/servers';

// 브라우저 E2E 설정 — 빌드 산출물로만 돈다: 서버 dist(목업 엔진) + 위젯 dist(widget.js, frame/app.js·css) + 데모 정적 서버.
// 먼저 루트에서 `pnpm build`. 브라우저는 처음 한 번 `pnpm --filter @qrate/widget exec playwright install chromium`.
// 실행: `pnpm e2e`(루트) 또는 이 패키지에서 `pnpm e2e`. CI는 같은 명령을 build 뒤에 돌린다(.github/workflows/ci.yml).
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // 목업은 한 글자에 20ms씩 흘려보내므로(apps/server/src/engine/mock.ts) 답변 하나가 몇 초 걸린다.
  expect: { timeout: 10_000 },
  // 서버 하나를 공유한다. 대화는 conversationId로 나뉘지만 순차 실행이 단순하고 실행 시간도 짧다.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: DEMO_ORIGIN, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // node를 직접 실행한다(--env-file 없음)— apps/server/.env의 API 키를 읽지 않는다. 엔진은 목업으로 고정.
      // reuseExistingServer: false — 8787에 이미 서버가 떠 있으면(예: pnpm dev, 실제 모델일 수 있음) 그걸 쓰지 않고 실패한다.
      command: 'node ../../apps/server/dist/index.js',
      url: `${SERVER_ORIGIN}/healthz`,
      env: { QRATE_ENGINE: 'mock', PORT: '8787', QRATE_PUBLIC_ORIGIN: SERVER_ORIGIN },
      reuseExistingServer: false,
    },
    {
      command: 'node demo.mjs',
      url: `${DEMO_ORIGIN}/demo.html`,
      env: { PORT: '5173' },
      reuseExistingServer: false,
    },
    {
      // 허용 목록(시드 allowedOrigins)에 없는 오리진 — 같은 데모를 다른 포트에서 (e2e/servers.ts)
      command: 'node demo.mjs',
      url: `${NOT_ALLOWED_DEMO_ORIGIN}/demo.html`,
      env: { PORT: '5174' },
      reuseExistingServer: false,
    },
  ],
});
