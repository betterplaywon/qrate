// 운영 콘솔 E2E — 실제 Chromium에서 로그인(쿠키 세션) → 대화 로그 → 미응답 큐 상태 변경 → 로그아웃.
// 대화는 대화 API(POST /api/chat, 목업 엔진)로 만든다. 목업 훅 [[handoff]]가 모델 신호를 낸다(apps/server/src/engine/mock.ts).
// 단위 테스트가 못 보는 것만 본다: 브라우저가 HttpOnly 쿠키를 실어 주는지, CSP 아래에서 번들이 도는지, 화면 흐름.

import { expect, test as base, type Page } from '@playwright/test';
import { CONSOLE_KEY, SERVER_ORIGIN } from './servers';

// 브라우저는 4xx 응답도 콘솔 오류로 찍는다. 세션 확인(/me)과 틀린 키의 401은 이 흐름에서 정상이라 그 한 줄만 거른다.
const EXPECTED_401 = /status of 401/;

const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !EXPECTED_401.test(m.text())) errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    await use(errors);
  },
});

async function login(page: Page, key: string): Promise<void> {
  await page.locator('#tenant').fill('demo');
  await page.locator('#key').fill(key);
  await page.getByRole('button', { name: '로그인' }).click();
}

test('콘솔 문서는 CSP와 함께 내려오고, 로그인 전 API는 401', async ({ request }) => {
  const doc = await request.get('/console/');
  expect(doc.status()).toBe(200);
  expect(doc.headers()['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  expect(doc.headers()['cache-control']).toBe('no-cache');
  expect((await request.get('/api/console/me')).status()).toBe(401);
});

test('틀린 키는 안내, 맞는 키는 셸 — 빈 큐·빈 로그 → 대화가 생기면 로그·상세·큐에 보이고 상태를 옮길 수 있다 → 로그아웃', async ({
  page,
  request,
  consoleErrors,
}) => {
  await page.goto('/console/');
  await login(page, 'wrong-key');
  await expect(page.getByRole('alert')).toContainText('맞지 않아요');

  await login(page, CONSOLE_KEY);
  await expect(page.getByTestId('tenant-name')).toHaveText('마루인보이스');
  await expect(page.getByTestId('queue-empty')).toBeVisible();
  await page.goto('/console/#/conversations');
  await expect(page.getByTestId('conversations-empty')).toBeVisible();

  // 위젯이 보낼 것과 같은 요청을 API로 보낸다 — 두 대화, 둘째는 모델의 연결 신호
  for (const message of ['요금제가 어떻게 되나요?', '[[handoff]] 카카오톡으로 알림 받을 수 있나요?']) {
    const res = await request.post('/api/chat', {
      headers: { origin: SERVER_ORIGIN, 'content-type': 'application/json' },
      data: { tenant: 'demo', message },
    });
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('[DONE]');
  }

  await page.reload();
  const items = page.getByTestId('conversation-item');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText('카카오톡으로 알림');
  await expect(items.first()).toContainText('연결 요청 1');
  await items.first().click();
  await expect(page.getByTestId('messages').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('detail-handoffs')).toContainText('모델 신호');

  await page.goto('/console/#/queue/open');
  const queued = page.getByTestId('queue-item');
  await expect(queued).toHaveCount(1);
  await expect(queued.first()).toContainText('카카오톡으로 알림');
  await queued.first().getByTestId('move-in_progress').click();
  // 열림 탭에서 빠지고 처리 중 탭에 보인다
  await expect(page.getByTestId('queue-empty')).toBeVisible();
  await page.getByTestId('tab-in_progress').click();
  await expect(page.getByTestId('queue-item')).toHaveCount(1);
  await expect(page.getByTestId('status')).toHaveText('처리 중');

  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('button', { name: '로그인' })).toBeVisible();
  expect((await request.get('/api/console/me')).status()).toBe(401);

  expect(consoleErrors).toEqual([]);
});
