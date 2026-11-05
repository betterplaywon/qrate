// 위젯 브라우저 E2E — 런처(Shadow DOM) + 대화창(서버 오리진 iframe) + 목업 서버를 실제 Chromium에서 돌린다.
//
// 단위 테스트가 못 보는 것만 본다: 호스트 CSS와의 격리, 오리진 격리(호스트가 대화 DOM에 손댈 수 없음),
// CSP frame-ancestors와 `o` 대조, postMessage 왕복(ready·close·unread), 대화 API 요청이 어느 문서에서 나가는지, 재시도 정책.
// 선택자는 런처(src/loader.ts)와 화면(src/frame/view.ts)의 클래스·id다. Playwright 로케이터는 열린 shadow root를 뚫는다.
// 목업 훅([[fail:429]] 등)은 apps/server/src/engine/mock.ts.

import { expect, test as base, type FrameLocator, type Page } from '@playwright/test';
import { CONSOLE_KEY, DEMO_ORIGIN, NOT_ALLOWED_DEMO_ORIGIN, SERVER_ORIGIN } from './servers';

const HOST = '#qrate-host';
const LAUNCHER = `${HOST} .launcher`;
const FRAME = `${HOST} iframe.frame`;
const CHAT_URL = `${SERVER_ORIGIN}/api/chat`;
const EVENTS_URL = `${SERVER_ORIGIN}/api/events`;

// 페이지(모든 프레임)의 콘솔 오류와 예외를 모은다. 정상 흐름에서는 0건이어야 한다.
const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    await use(errors);
  },
});

/** 데모 페이지를 열고 런처를 눌러 대화창이 준비(ready postMessage → 로딩 문구 제거)될 때까지 기다린다. */
async function openWidget(page: Page): Promise<FrameLocator> {
  await page.goto('/demo.html');
  await page.locator(LAUNCHER).click();
  await expect(page.locator(`${HOST} .loading`)).toHaveCount(0);
  return page.frameLocator(FRAME);
}

async function send(frame: FrameLocator, message: string): Promise<void> {
  await frame.locator('#qrate-input').fill(message);
  await frame.locator('.send').click();
}

/** 끝난(스트리밍이 닫힌) 답변 말풍선. */
const finishedAnswers = (frame: FrameLocator) => frame.locator('.msg.bot:not([aria-busy])');

test('런처는 Shadow DOM에 격리되고, 열기 전에는 서버에 아무 요청도 보내지 않는다', async ({ page, consoleErrors }) => {
  const serverRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(SERVER_ORIGIN)) serverRequests.push(r.url());
  });

  await page.goto('/demo.html');
  const launcher = page.locator(LAUNCHER);
  await expect(launcher).toBeVisible();

  // demo.html의 전역 CSS(`* { font-family: serif !important; color: red }`)가 shadow root 안의 런처에는 닿지 않는다
  const style = await launcher.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { color: cs.color, fontFamily: cs.fontFamily };
  });
  expect(style.color).not.toBe('rgb(255, 0, 0)');
  expect(style.fontFamily).toContain('system-ui');

  // 대화창 iframe은 처음 열 때 만든다 — 열지 않은 방문자의 브라우저는 위젯 서버를 부르지 않는다
  await expect(page.locator(`${HOST} iframe`)).toHaveCount(0);
  expect(serverRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('열면 서버 오리진의 iframe이 뜨고, 호스트 문서는 대화 DOM에 손댈 수 없다', async ({ page, consoleErrors }) => {
  await page.goto('/demo.html');
  const frameResponse = page.waitForResponse((r) => r.url().startsWith(`${SERVER_ORIGIN}/frame?`));
  await page.locator(LAUNCHER).click();

  // iframe 주소: 서버 오리진의 /frame, t=테넌트, o=이 사이트의 오리진
  const iframe = page.locator(FRAME);
  const src = new URL((await iframe.getAttribute('src')) ?? '');
  expect(src.origin).toBe(SERVER_ORIGIN);
  expect(src.pathname).toBe('/frame');
  expect(src.searchParams.get('t')).toBe('demo');
  expect(src.searchParams.get('o')).toBe(DEMO_ORIGIN);

  // 서버는 허용 사이트 목록을 CSP frame-ancestors로 내려주고, 그 응답을 캐시에 남기지 않는다
  const res = await frameResponse;
  expect(res.status()).toBe(200);
  expect(res.headers()['content-security-policy']).toContain(`frame-ancestors ${DEMO_ORIGIN}`);
  expect(res.headers()['cache-control']).toBe('no-store');

  // 다른 오리진의 문서라 호스트 스크립트에서 contentDocument는 null이다(동일 출처 정책)
  expect(await iframe.evaluate((el) => (el as HTMLIFrameElement).contentDocument === null)).toBe(true);

  // 대화창 앱이 ready를 postMessage로 보내면 런처가 로딩 문구를 지운다
  await expect(page.locator(`${HOST} .loading`)).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test('처음 열면 대화창 문서가 widget_open 사건을 한 번 보내고, 닫았다 다시 열어도 더 보내지 않는다', async ({ page, consoleErrors }) => {
  const sent: { frameUrl: string; body: unknown }[] = [];
  page.on('request', (r) => {
    if (r.url() === EVENTS_URL && r.method() === 'POST') sent.push({ frameUrl: r.frame().url(), body: r.postDataJSON() });
  });

  const accepted = page.waitForResponse((r) => r.url() === EVENTS_URL);
  const frame = await openWidget(page);
  expect((await accepted).status()).toBe(202);
  expect(sent).toEqual([{ frameUrl: expect.stringMatching(`^${SERVER_ORIGIN}/frame\\?`), body: { tenant: 'demo', type: 'widget_open' } }]);

  const launcher = page.locator(LAUNCHER);
  await frame.locator('.close').click();
  await expect(launcher).toHaveAttribute('aria-expanded', 'false');
  await launcher.click();
  await expect(launcher).toHaveAttribute('aria-expanded', 'true');
  await send(frame, '환불되나요?');
  await expect(finishedAnswers(frame)).toHaveCount(1);
  expect(sent).toHaveLength(1);
  expect(consoleErrors).toEqual([]);
});

test('대화 API는 iframe 문서에서만 부르고, 답변 스트리밍·출처·대화 이어 가기가 동작한다', async ({ page, consoleErrors }) => {
  const requests: { frameUrl: string; conversationId: string | null }[] = [];
  const responseIds: string[] = [];
  page.on('request', (r) => {
    if (r.url() !== CHAT_URL) return;
    const body = JSON.parse(r.postData() ?? '{}') as { conversationId?: string | null };
    requests.push({ frameUrl: r.frame().url(), conversationId: body.conversationId ?? null });
  });
  page.on('response', (r) => {
    if (r.url() === CHAT_URL) responseIds.push(r.headers()['x-conversation-id'] ?? '');
  });

  const frame = await openWidget(page);
  await send(frame, '요금제가 뭐가 있나요?');
  await expect(finishedAnswers(frame)).toHaveCount(1);
  const first = frame.locator('.msg.bot').first();
  await expect(first.locator('.text')).toContainText('목업 응답');
  // 목업은 첫 지식 항목의 첫 블록을 인용한다 — 출처 접기 안에 제목과 인용문 하나
  await expect(first.locator('.sources summary')).toHaveText('출처 1건');
  await expect(first.locator('.quote q')).toHaveCount(1);

  await send(frame, '추가 인원 비용은요?');
  await expect(finishedAnswers(frame)).toHaveCount(2);

  // 두 요청 모두 서버 오리진의 iframe 문서에서 나갔다(호스트 페이지는 /api/chat을 부르지 않는다)
  expect(requests).toHaveLength(2);
  for (const r of requests) expect(r.frameUrl.startsWith(`${SERVER_ORIGIN}/frame?`)).toBe(true);
  // 첫 요청은 대화 id가 없고, 두 번째는 첫 응답의 X-Conversation-Id를 돌려보낸다
  expect(requests[0]?.conversationId).toBeNull();
  expect(responseIds[0]).toBeTruthy();
  expect(requests[1]?.conversationId).toBe(responseIds[0]);
  expect(consoleErrors).toEqual([]);
});

test('서버가 재시도 가능하다고 한 실패에만 "다시 보내기"가 보이고, 재시도는 질문을 중복하지 않는다', async ({
  page,
  consoleErrors,
}) => {
  const frame = await openWidget(page);
  const notices = frame.locator('.msg.notice');

  // [[fail:429]] → 첫 이벤트 전 503 + Retry-After: 2 → 재시도 가능. 버튼은 Retry-After 동안 잠겼다가 풀린다
  await send(frame, '[[fail:429]] 요금제가 뭐가 있나요?');
  const retry = notices.first().locator('.notice-action');
  await expect(retry).toHaveText('다시 보내기');
  await expect(retry).toBeDisabled();
  await expect(retry).toBeEnabled();
  await retry.click();
  // 같은 메시지를 다시 보내므로 또 실패한다 — 안내는 하나 더 붙지만 사용자 말풍선은 그대로 하나
  await expect(notices).toHaveCount(2);
  await expect(frame.locator('.msg.user')).toHaveCount(1);

  // [[fail:401]] → 502, 재시도 불가 → 상태 코드만 보이고 버튼이 없다
  await send(frame, '[[fail:401]] 요금제가 뭐가 있나요?');
  await expect(notices).toHaveCount(3);
  await expect(notices.last()).toContainText('(502)');
  await expect(notices.last().locator('.notice-action')).toHaveCount(0);

  // 5xx 응답마다 브라우저가 "Failed to load resource"를 콘솔 오류로 남긴다. 그 밖의 오류는 없어야 한다
  expect(consoleErrors.filter((e) => !e.startsWith('Failed to load resource'))).toEqual([]);
});

test('모델이 자료에 없는 질문이라고 신호하면 안내 답변 뒤에 상담원 연결 제안이 붙고, 연락처를 보내면 콘솔 큐에 들어간다', async ({
  page,
  request,
  consoleErrors,
}) => {
  const frame = await openWidget(page);
  // [[handoff]] → 목업이 안내 문장만 답하고(인용 없음) event: handoff를 보낸다
  await send(frame, '[[handoff]] 카카오톡으로 청구서 알림을 보낼 수 있나요?');
  await expect(finishedAnswers(frame)).toHaveCount(1);
  const answer = frame.locator('.msg.bot').first();
  await expect(answer.locator('.text')).toContainText('안내 자료에 없어요');
  await expect(answer.locator('.sources')).toHaveCount(0);

  // 신호를 받은 대화창은 연결 제안 안내와 버튼을 붙인다. 누르면 연락처 폼이 열리고, 보내면 접수 안내가 남는다
  const offer = frame.locator('.msg.notice').last();
  await expect(offer).toContainText('상담원에게 연결해 드릴까요?');
  await offer.locator('.notice-action').click();
  const form = frame.locator('.handoff-form');
  await expect(form).toBeVisible();
  await form.locator('#qrate-contact').fill('visitor@example.com');
  await form.locator('#qrate-handoff-message').fill('전화 주세요');
  await form.locator('button[type="submit"]').click();
  await expect(frame.locator('.msg.notice').last()).toContainText('접수됐어요');
  await expect(form).toHaveCount(0);

  // 접수는 콘솔의 미응답 큐에 방문자 항목으로 들어간다 — 콘솔 API로 확인(로그인은 시드 테넌트 키 + 콘솔 키)
  const login = await request.post(`${SERVER_ORIGIN}/api/console/login`, {
    headers: { origin: SERVER_ORIGIN },
    data: { tenant: 'demo', key: CONSOLE_KEY },
  });
  expect(login.status()).toBe(200);
  const queue = (await (await request.get(`${SERVER_ORIGIN}/api/console/handoffs?status=open`)).json()) as {
    items: { source: string; contact: string | null; summary: string | null; preview: string }[];
  };
  const visitor = queue.items.find((h) => h.source === 'visitor');
  expect(visitor).toMatchObject({ contact: 'visitor@example.com', summary: '전화 주세요' });
  expect(visitor?.preview).toContain('카카오톡');
  expect(consoleErrors).toEqual([]);
});

test('머리글의 "상담원 연결"은 질문 전에도 접수되고, 그 뒤의 질문은 같은 대화로 이어진다. 취소하면 폼이 사라진다', async ({
  page,
  consoleErrors,
}) => {
  const frame = await openWidget(page);
  await frame.locator('.handoff').click();
  const form = frame.locator('.handoff-form');
  await expect(form).toBeVisible();
  await form.locator('.cancel').click();
  await expect(form).toHaveCount(0);

  await frame.locator('.handoff').click();
  await frame.locator('#qrate-contact').fill('early@example.com');
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url() === `${SERVER_ORIGIN}/api/handoff` && r.request().method() === 'POST'),
    frame.locator('.handoff-form button[type="submit"]').click(),
  ]);
  expect(created.status()).toBe(201);
  const { conversationId } = (await created.json()) as { conversationId: string };
  await expect(frame.locator('.msg.notice').last()).toContainText('접수됐어요');

  // 이어지는 질문은 서버가 만든 그 대화 id로 간다
  const [chat] = await Promise.all([
    page.waitForRequest((r) => r.url() === CHAT_URL && r.method() === 'POST'),
    send(frame, '환불되나요?'),
  ]);
  expect(chat.postDataJSON()).toMatchObject({ conversationId });
  await expect(finishedAnswers(frame)).toHaveCount(1);
  expect(consoleErrors).toEqual([]);
});

test('닫기는 postMessage로 런처에 전해지고, 닫힌 동안 끝난 답변은 배지로 센다', async ({ page, consoleErrors }) => {
  const frame = await openWidget(page);
  const launcher = page.locator(LAUNCHER);
  const panel = page.locator(`${HOST} .panel`);
  const badge = page.locator(`${HOST} .badge`);
  await expect(launcher).toHaveAttribute('aria-expanded', 'true');

  // 질문을 보내 두고 답변이 흐르는 동안 대화창의 ✕를 누른다 → 런처가 close를 받아 패널을 닫는다
  await send(frame, '환불되나요?');
  await frame.locator('.close').click();
  await expect(launcher).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeHidden();

  // 닫힌 채로 답변이 끝나면 대화창이 unread를 보내고, 런처가 배지와 접근성 라벨에 반영한다
  await expect(badge).toHaveText('1');
  await expect(badge).toBeVisible();
  await expect(launcher).toHaveAttribute('aria-label', '상담 열기 — 새 답변 1건');
  await expect(finishedAnswers(frame)).toHaveCount(1);

  // 다시 열면 0
  await launcher.click();
  await expect(panel).toBeVisible();
  await expect(badge).toBeHidden();
  await expect(launcher).toHaveAttribute('aria-label', '상담 열기');
  expect(consoleErrors).toEqual([]);
});

test('허용 목록 밖의 사이트에서는 서버가 대화창을 내려주지 않고, 브라우저도 프레임을 거부한다', async ({
  page,
  request,
  consoleErrors,
}) => {
  // 서버 쪽: o가 허용 목록 밖이거나 없으면 403 안내 문서. CSP는 그대로 내려간다(frame-ancestors가 곧 허용 목록)
  const denied = await request.get(`${SERVER_ORIGIN}/frame?t=demo&o=${encodeURIComponent(NOT_ALLOWED_DEMO_ORIGIN)}`);
  expect(denied.status()).toBe(403);
  expect(denied.headers()['content-security-policy']).toContain(`frame-ancestors ${DEMO_ORIGIN}`);
  const html = await denied.text();
  expect(html).toContain('이 사이트에서는 상담 창을 열 수 없어요');
  expect(html).not.toContain('app.js');
  expect((await request.get(`${SERVER_ORIGIN}/frame?t=demo`)).status()).toBe(403);

  // 브라우저 쪽: 허용 목록에 없는 포트의 데모 페이지. 런처는 자기 오리진을 o로 적어 보낸다
  const frameResponse = page.waitForResponse((r) => r.url().startsWith(`${SERVER_ORIGIN}/frame?`));
  await page.goto(`${NOT_ALLOWED_DEMO_ORIGIN}/demo.html`);
  await page.locator(LAUNCHER).click();
  const src = new URL((await page.locator(FRAME).getAttribute('src')) ?? '');
  expect(src.searchParams.get('o')).toBe(NOT_ALLOWED_DEMO_ORIGIN);
  expect((await frameResponse).status()).toBe(403);

  // 브라우저도 CSP frame-ancestors 위반으로 프레임 표시를 거부한다 → ready가 오지 않아 로딩 문구가 남는다
  await expect.poll(() => consoleErrors.some((e) => e.includes('frame-ancestors'))).toBe(true);
  await expect(page.locator(`${HOST} .loading`)).toBeVisible();
});
