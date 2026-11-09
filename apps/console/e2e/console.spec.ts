// 운영 콘솔 E2E — 실제 Chromium에서 로그인(쿠키 세션) → 대화 로그 → 미응답 큐 상태 변경 → 크레딧 잔액·원장 → 로그아웃,
// 그리고 충전(모의 결제 제공자): 끊긴 요청의 재시도 · 결제 결과 흉내 · 같은 이벤트 재배달 · 늦은 실패 · 웹훅 원문 재전송과 위조,
// 지표 화면(TTFT·자동 해결률·위젯 열림·인사말 A/B).
// 대화는 대화 API(POST /api/chat, 목업 엔진)로 만든다. 목업 훅 [[handoff]]가 모델 신호를 낸다(apps/server/src/engine/mock.ts).
// 단위 테스트가 못 보는 것만 본다: 브라우저가 HttpOnly 쿠키를 실어 주는지, CSP 아래에서 번들이 도는지, 화면 흐름.

import { expect, test as base, type Page } from '@playwright/test';
import { MOCK_SIGNATURE_HEADER, paymentWebhookPath, type ConsoleMetricsResponse, type TopUpListResponse } from '@qrate/contracts';
import { createHmac } from 'node:crypto';
import { CONSOLE_KEY, MOCK_PAYMENT_SECRET, SERVER_ORIGIN } from './servers';

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

test('틀린 키는 안내, 맞는 키는 셸 — 빈 큐·빈 로그 → 대화가 생기면 로그·상세·큐에 보이고 상태를 옮길 수 있다 → 크레딧 98 → 로그아웃', async ({
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

  // 크레딧: 시드 100에서 답이 있는 턴 둘이 빠져 98. 원장은 최근순 — 답변 -1, 답변 -1, 초기 지급 +100
  await page.getByTestId('nav-billing').click();
  await expect(page.getByTestId('credit-balance')).toHaveText('98');
  const entries = page.getByTestId('credit-entry');
  await expect(entries).toHaveCount(3);
  await expect(entries.first()).toContainText('답변');
  await expect(entries.first()).toContainText('-1');
  await expect(entries.last()).toContainText('초기 지급');
  await expect(entries.last()).toContainText('+100');

  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('button', { name: '로그인' })).toBeVisible();
  expect((await request.get('/api/console/me')).status()).toBe(401);

  expect(consoleErrors).toEqual([]);
});

function signWebhook(rawBody: string, secret = MOCK_PAYMENT_SECRET): string {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

test('충전: 끊긴 요청을 다시 눌러도 주문은 하나 → 결제 성공(테스트) +100 → 같은 이벤트 재배달·늦은 실패·웹훅 원문 재전송·위조는 잔액을 움직이지 않는다', async ({
  page,
  consoleErrors,
}) => {
  await page.goto('/console/#/billing');
  await login(page, CONSOLE_KEY);
  const balance = page.getByTestId('credit-balance');
  await expect(balance).toHaveText(/^\d+$/);
  const start = Number(await balance.textContent());

  // 첫 충전 요청은 서버가 처리한 뒤 응답만 끊는다(네트워크 재시도 상황).
  let dropped = false;
  await page.route('**/api/console/top-ups', async (route) => {
    if (route.request().method() !== 'POST' || dropped) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await expect(page.getByTestId('package-credits_100')).toBeChecked();
  await page.getByRole('button', { name: '충전 요청' }).click();
  await expect(page.getByTestId('top-up-error')).toContainText('같은 요청으로');
  const retried = page.waitForResponse((r) => r.url().endsWith('/api/console/top-ups') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '충전 요청' }).click();
  const retry = await retried;
  expect(retry.status()).toBe(201);
  expect(retry.headers()['idempotent-replayed']).toBe('true');
  const orders = page.getByTestId('top-up-item');
  await expect(orders).toHaveCount(1);
  await expect(orders.first().getByTestId('top-up-status')).toHaveText('결제 대기');
  await expect(balance).toHaveText(String(start));

  const result = page.getByTestId('simulate-result');
  await orders.first().getByRole('button', { name: '결제 성공(테스트)' }).click();
  await expect(result).toHaveText('100크레딧을 충전했어요.');
  await expect(balance).toHaveText(String(start + 100));
  await expect(orders.first().getByTestId('top-up-status')).toHaveText('결제 완료');
  await expect(page.getByTestId('credit-entry').first()).toContainText('충전');
  await expect(page.getByTestId('credit-entry').first()).toContainText('+100');

  await orders.first().getByRole('button', { name: '결제 성공(테스트)' }).click();
  await expect(result).toHaveText('같은 이벤트가 다시 왔어요. 처리 결과는 처음과 같고 잔액은 그대로예요.');
  await expect(balance).toHaveText(String(start + 100));

  await orders.first().getByRole('button', { name: '결제 실패(테스트)' }).click();
  await expect(result).toHaveText('이미 처리된 주문이라 상태가 바뀌지 않았어요.');
  await expect(orders.first().getByTestId('top-up-status')).toHaveText('결제 완료');

  const list = (await (await page.request.get('/api/console/top-ups')).json()) as TopUpListResponse;
  const order = list.items[0];
  if (!order) throw new Error('주문이 없다');
  const webhook = (rawBody: string, signature: string) =>
    page.request.post(paymentWebhookPath('mock'), {
      headers: { 'content-type': 'application/json', [MOCK_SIGNATURE_HEADER]: signature },
      data: rawBody,
    });
  const event = (id: string, amount = order.amount) =>
    JSON.stringify({ id, type: 'payment.paid', created: Math.floor(Date.now() / 1000), data: { orderId: order.id, amount } });

  const redelivered = event(`evt_${order.id}_paid`);
  const again = await webhook(redelivered, signWebhook(redelivered));
  expect(again.status()).toBe(200);
  expect(again.headers()['idempotent-replayed']).toBe('true');
  expect(await again.json()).toEqual({ outcome: 'applied' });

  const another = event(`evt-e2e-${order.id}`);
  const stale = await webhook(another, signWebhook(another));
  expect(stale.status()).toBe(200);
  expect(await stale.json()).toEqual({ outcome: 'stale' });

  const forged = await webhook(event(`evt-forged-${order.id}`, 1_000_000), signWebhook(another));
  expect(forged.status()).toBe(401);
  const wrongSecret = await webhook(another, signWebhook(another, 'attacker-secret-0123456789'));
  expect(wrongSecret.status()).toBe(401);

  await page.reload();
  await expect(balance).toHaveText(String(start + 100));
  await expect(page.getByTestId('credit-entry').filter({ hasText: '충전' })).toHaveCount(1);

  expect(consoleErrors.filter((e) => !/ERR_CONNECTION_RESET/.test(e))).toEqual([]);
});

// 결제창에서 돌아온 주소(토스 결제창이 붙이는 쿼리)를 모의 제공자 서버에서 연다. 이 서버에는 확정 경로가 없어 확정은 404다.
const CONFIRM_PATH = /^\/api\/console\/top-ups\/[^/]+\/confirm$/;
const isConfirm = (url: string, method: string) => method === 'POST' && CONFIRM_PATH.test(new URL(url).pathname);

test('결제창에서 돌아온 주소: 실패는 코드별 우리 문구만(주소의 message는 화면에 없음), 성공은 확정 요청 정확히 하나 → 결과가 정해지면 주소를 지운다', async ({
  page,
  consoleErrors,
}) => {
  const confirms: (string | null)[] = [];
  page.on('request', (r) => {
    if (isConfirm(r.url(), r.method())) confirms.push(r.postData());
  });

  const forged = '보안 점검 중입니다. 010-0000-0000으로 연락하세요';
  await page.goto(`/console/?toss=fail&code=PAY_PROCESS_CANCELED&message=${encodeURIComponent(forged)}&orderId=order-e2e-0001`);
  expect(new URL(page.url()).search).toBe('');
  expect(new URL(page.url()).hash).toBe('#/billing');
  await login(page, CONSOLE_KEY);
  await expect(page.getByTestId('toss-return')).toHaveText('결제를 취소했어요. 주문은 결제 대기로 남아요.');
  await expect(page.getByText(forged)).toHaveCount(0);

  await page.goto('/console/?toss=success&paymentType=NORMAL&amount=10000&orderId=order-e2e-0002&paymentKey=tgen_e2e_0001');
  await expect(page.getByTestId('toss-return')).toHaveText('이 결제는 이 서버에서 확인할 수 없어요. 다른 테넌트로 로그인했거나 결제 방법이 바뀌었어요.');
  expect(confirms).toEqual([JSON.stringify({ paymentKey: 'tgen_e2e_0001', amount: 10_000 })]);
  await expect.poll(() => new URL(page.url()).search).toBe('');
  expect(new URL(page.url()).hash).toBe('#/billing');

  await page.reload();
  await expect(page.getByTestId('credit-balance')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('toss-return')).toHaveCount(0);
  expect(confirms).toHaveLength(1);
  expect(consoleErrors.filter((e) => !/status of 404/.test(e))).toEqual([]);
});

test('확정 요청이 끊기면 주소의 쿼리를 남겨 두고, 다시 확인은 같은 결제로 다시 묻는다', async ({ page, consoleErrors }) => {
  const confirms: (string | null)[] = [];
  page.on('request', (r) => {
    if (isConfirm(r.url(), r.method())) confirms.push(r.postData());
  });
  let cut = true;
  await page.route('**/api/console/top-ups/*/confirm', (route) => (cut ? route.abort('connectionreset') : route.continue()));

  await page.goto('/console/?toss=success&paymentType=NORMAL&amount=10000&orderId=order-e2e-0003&paymentKey=tgen_e2e_0002');
  await login(page, CONSOLE_KEY);
  const notice = page.getByTestId('toss-return');
  await expect(notice).toContainText('토스에서 결제 완료를 아직 확인하지 못했어요.');
  expect(new URL(page.url()).search).toContain('paymentKey=tgen_e2e_0002');

  cut = false;
  await notice.getByRole('button', { name: '다시 확인' }).click();
  await expect(notice).toHaveText('이 결제는 이 서버에서 확인할 수 없어요. 다른 테넌트로 로그인했거나 결제 방법이 바뀌었어요.');
  expect(confirms).toHaveLength(2);
  expect(new Set(confirms).size).toBe(1);
  await expect.poll(() => new URL(page.url()).search).toBe('');
  expect(consoleErrors.filter((e) => !/ERR_CONNECTION_RESET|status of 404/.test(e))).toEqual([]);
});

test('지표: 답한 질문·위젯 열림·질문 없는 연결 요청이 하나씩 생기면 각 수가 하나씩 는다 — 연결만 요청한 대화는 해결률 분모가 아니라 따로 센다', async ({
  page,
  request,
  consoleErrors,
}) => {
  await page.goto('/console/');
  await login(page, CONSOLE_KEY);
  await page.getByTestId('nav-metrics').click();
  await expect(page).toHaveURL(/#\/metrics$/);
  await expect(page.getByTestId('metrics-window')).toContainText('최근 7일');

  const count = async (testId: string): Promise<number> => {
    const locator = page.getByTestId(testId);
    await expect(locator).toHaveText(/^\d+$/);
    return Number(await locator.textContent());
  };
  const read = async () => ({
    samples: await count('metric-ttft-samples'),
    conversations: await count('metric-resolution-conversations'),
    resolved: await count('metric-resolution-resolved'),
    handoffOnly: await count('metric-resolution-handoff-only'),
    opens: await count('metric-widget-opens'),
  });
  const before = await read();

  const chat = await request.post('/api/chat', {
    headers: { origin: SERVER_ORIGIN, 'content-type': 'application/json' },
    data: { tenant: 'demo', message: '환불 정책 알려줘' },
  });
  expect(await chat.text()).toContain('[DONE]');
  const opened = await request.post('/api/events', {
    headers: { origin: SERVER_ORIGIN, 'content-type': 'application/json' },
    data: { tenant: 'demo', type: 'widget_open' },
  });
  expect(opened.status()).toBe(202);
  const handoff = await request.post('/api/handoff', {
    headers: { origin: SERVER_ORIGIN, 'content-type': 'application/json' },
    data: { tenant: 'demo', contact: 'metrics@example.com' },
  });
  expect(handoff.status()).toBe(201);

  await page.reload();
  await expect(page.getByTestId('metric-ttft-samples')).toHaveText(String(before.samples + 1));
  expect(await read()).toEqual({
    samples: before.samples + 1,
    conversations: before.conversations + 1,
    resolved: before.resolved + 1,
    handoffOnly: before.handoffOnly + 1,
    opens: before.opens + 1,
  });
  await expect(page.getByTestId('metric-ttft-p50')).toHaveText(/^[\d,]+ms$/);
  await expect(page.getByTestId('metric-ttft-p95')).toHaveText(/^[\d,]+ms$/);
  await expect(page.getByTestId('metric-resolution-rate')).toHaveText(/^\d+(\.\d)?%$/);

  expect(consoleErrors).toEqual([]);
});

test('지표: 인사말 A/B — 변형 id를 실은 열림·첫 질문은 그 행의 노출·첫 질문을 하나씩 늘리고, 변형 없는 사건은 실험 밖 수를 늘린다', async ({
  page,
  request,
  consoleErrors,
}) => {
  await page.goto('/console/');
  await login(page, CONSOLE_KEY);
  await page.getByTestId('nav-metrics').click();
  await expect(page).toHaveURL(/#\/metrics$/);

  const { greeting } = (await (await page.request.get('/api/console/metrics')).json()) as ConsoleMetricsResponse;
  const variants = greeting?.variants ?? [];
  expect(variants.length).toBeGreaterThan(1);
  for (const v of variants) {
    await expect(page.getByTestId(`metric-greeting-${v.id}`)).toContainText(v.label);
    await expect(page.getByTestId(`metric-greeting-${v.id}`)).toContainText(v.text);
  }
  const target = variants[0]?.id ?? '';

  const count = async (testId: string): Promise<number> => {
    const locator = page.getByTestId(testId);
    await expect(locator).toHaveText(/^\d+$/);
    return Number(await locator.textContent());
  };
  const read = async () => ({
    exposures: await count(`metric-greeting-exposures-${target}`),
    firstQuestions: await count(`metric-greeting-first-questions-${target}`),
    outsideOpens: await count('metric-greeting-outside-opens'),
    outsideQuestions: await count('metric-greeting-outside-questions'),
  });
  const before = await read();

  for (const body of [
    { type: 'widget_open', variant: target },
    { type: 'first_question', variant: target },
    { type: 'widget_open' },
    { type: 'first_question' },
  ]) {
    const res = await request.post('/api/events', {
      headers: { origin: SERVER_ORIGIN, 'content-type': 'application/json' },
      data: { tenant: 'demo', ...body },
    });
    expect(res.status()).toBe(202);
  }

  await page.reload();
  await expect(page.getByTestId(`metric-greeting-exposures-${target}`)).toHaveText(String(before.exposures + 1));
  expect(await read()).toEqual({
    exposures: before.exposures + 1,
    firstQuestions: before.firstQuestions + 1,
    outsideOpens: before.outsideOpens + 1,
    outsideQuestions: before.outsideQuestions + 1,
  });
  await expect(page.getByTestId(`metric-greeting-rate-${target}`)).toHaveText(/^\d+(\.\d)?%$/);
  expect(consoleErrors).toEqual([]);
});
