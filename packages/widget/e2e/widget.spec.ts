// 위젯 브라우저 E2E — 런처(Shadow DOM) + 대화창(서버 오리진 iframe) + 목업 서버를 실제 Chromium에서 돌린다.
//
// 단위 테스트가 못 보는 것만 본다: 호스트 CSS와의 격리, 오리진 격리(호스트가 대화 DOM에 손댈 수 없음),
// CSP frame-ancestors와 `o` 대조, postMessage 왕복(ready·close·unread·greeting), 대화 API 요청이 어느 문서에서 나가는지, 재시도 정책,
// 인사말 A/B(서버 배정 → 화면 → 이 사이트 localStorage 보존 → 다음 페이지 로드의 v= → 사건의 변형).
// 첫 방문의 변형은 무작위라 어느 테스트도 특정 변형을 기대하지 않는다. 배정을 관찰해서 단언하고, 특정 변형이 필요하면 방문자 브라우저의
// localStorage를 만든다(변형 id·문구는 콘솔 지표 API에서 읽는다).
// 선택자는 런처(src/loader.ts)와 화면(src/frame/view.ts)의 클래스·id다. Playwright 로케이터는 열린 shadow root를 뚫는다.
// 목업 훅([[fail:429]] 등)은 apps/server/src/engine/mock.ts.

import type { ConsoleMetricsResponse, GreetingResponse, WidgetEventBody } from '@qrate/contracts';
import { expect, test as base, type APIRequestContext, type FrameLocator, type Page, type Response } from '@playwright/test';
import { CONSOLE_KEY, DEMO_ORIGIN, NOT_ALLOWED_DEMO_ORIGIN, SERVER_ORIGIN } from './servers';

const HOST = '#qrate-host';
const LAUNCHER = `${HOST} .launcher`;
const FRAME = `${HOST} iframe.frame`;
const CHAT_URL = `${SERVER_ORIGIN}/api/chat`;
const EVENTS_URL = `${SERVER_ORIGIN}/api/events`;
const GREETING_URL = `${SERVER_ORIGIN}/api/greeting`;
const VARIANT_KEY = 'qrate.greeting.demo';

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

/** 런처를 누르기 전에 기다리기 시작한다. */
const greetingResponse = (page: Page) => page.waitForResponse((r) => r.url().startsWith(`${GREETING_URL}?`));

async function assignedGreeting(res: Response): Promise<NonNullable<GreetingResponse['greeting']>> {
  const { greeting } = (await res.json()) as GreetingResponse;
  expect(greeting).not.toBeNull();
  return greeting as NonNullable<GreetingResponse['greeting']>;
}

function watchEvents(page: Page): WidgetEventBody[] {
  const sent: WidgetEventBody[] = [];
  page.on('request', (r) => {
    if (r.url() === EVENTS_URL && r.method() === 'POST') sent.push(r.postDataJSON() as WidgetEventBody);
  });
  return sent;
}

const storedVariant = (page: Page) => page.evaluate((key) => localStorage.getItem(key), VARIANT_KEY);

async function iframeVariant(page: Page): Promise<string | null> {
  return new URL((await page.locator(FRAME).getAttribute('src')) ?? '').searchParams.get('v');
}

/** 다음 페이지 로드부터 이 사이트의 localStorage에 그 값이 들어 있게 한다 — 그 값을 보존한 재방문자의 브라우저. */
async function storeBeforeLoad(page: Page, value: string): Promise<void> {
  await page.addInitScript(([key, v]) => localStorage.setItem(key, v), [VARIANT_KEY, value] as const);
}

async function currentVariants(request: APIRequestContext): Promise<{ id: string; text: string }[]> {
  const login = await request.post(`${SERVER_ORIGIN}/api/console/login`, { headers: { origin: SERVER_ORIGIN }, data: { tenant: 'demo', key: CONSOLE_KEY } });
  expect(login.status()).toBe(200);
  const { greeting } = (await (await request.get(`${SERVER_ORIGIN}/api/console/metrics`)).json()) as ConsoleMetricsResponse;
  expect(greeting?.variants.length).toBeGreaterThan(1);
  return greeting?.variants ?? [];
}

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

  // 입력창은 메시지가 없어도 패널 바닥에 붙는다
  const panel = await iframe.boundingBox();
  const composer = await page.frameLocator(FRAME).locator('.composer').boundingBox();
  expect(panel && composer && Math.abs(composer.y + composer.height - (panel.y + panel.height))).toBeLessThanOrEqual(1);
  expect(consoleErrors).toEqual([]);
});

test('처음 열면 대화창 문서가 widget_open 사건을 한 번 보내고, 닫았다 다시 열어도 더 보내지 않는다', async ({ page, consoleErrors }) => {
  const sent: { frameUrl: string; body: WidgetEventBody }[] = [];
  page.on('request', (r) => {
    if (r.url() === EVENTS_URL && r.method() === 'POST') sent.push({ frameUrl: r.frame().url(), body: r.postDataJSON() as WidgetEventBody });
  });

  const greeting = greetingResponse(page);
  const accepted = page.waitForResponse((r) => r.url() === EVENTS_URL);
  const frame = await openWidget(page);
  const { variant } = await assignedGreeting(await greeting);
  expect((await accepted).status()).toBe(202);
  expect(sent).toEqual([{ frameUrl: expect.stringMatching(`^${SERVER_ORIGIN}/frame\\?`), body: { tenant: 'demo', type: 'widget_open', variant } }]);

  const launcher = page.locator(LAUNCHER);
  await frame.locator('.close').click();
  await expect(launcher).toHaveAttribute('aria-expanded', 'false');
  await launcher.click();
  await expect(launcher).toHaveAttribute('aria-expanded', 'true');
  await send(frame, '환불되나요?');
  await expect(finishedAnswers(frame)).toHaveCount(1);
  expect(sent.map((s) => s.body.type)).toEqual(['widget_open', 'first_question']);
  expect(consoleErrors).toEqual([]);
});

test('두 번째 데모 고객사 페이지(reception.html)는 같은 서버에서 자기 테넌트의 FAQ로만 답한다', async ({ page, consoleErrors }) => {
  const tenants: string[] = [];
  page.on('request', (r) => {
    if (r.url() === CHAT_URL) tenants.push((JSON.parse(r.postData() ?? '{}') as { tenant?: string }).tenant ?? '');
  });
  await page.goto('/reception.html');
  await page.locator(LAUNCHER).click();
  await expect(page.locator(`${HOST} .loading`)).toHaveCount(0);
  const frame = page.frameLocator(FRAME);
  await send(frame, '주차는 몇 시간 무료인가요?');
  await expect(finishedAnswers(frame)).toHaveCount(1);
  // 목업은 그 테넌트의 첫 지식 항목(id 순)을 인용한다. 데모 테넌트(demo.html)였다면 "연간 결제 할인"이다.
  await expect(frame.locator('.msg.bot .text').first()).toContainText('자료 "장애인 편의 시설"');
  expect(tenants).toEqual(['reception']);
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

test('서버가 Retry-After로 기다리라고 하면 그동안 입력창과 전송 버튼도 잠기고, 풀리면 입력창에 초점이 돌아온다', async ({
  page,
  consoleErrors,
}) => {
  // 서버의 요율 제한(IP당 20회/분)을 실제로 채우면 같은 서버를 쓰는 뒤 테스트가 그 창에 걸린다. 대화 요청 하나만 서버의 429 모양으로 대신 답한다
  await page.route(
    CHAT_URL,
    (route) =>
      route.fulfill({
        status: 429,
        headers: { 'Retry-After': '3' },
        contentType: 'application/json',
        body: JSON.stringify({ error: 'too_many_requests' }),
      }),
    { times: 1 },
  );
  const frame = await openWidget(page);
  const input = frame.locator('#qrate-input');
  const sendButton = frame.locator('.send');

  await send(frame, '요금제가 뭐가 있나요?');
  const notice = frame.locator('.msg.notice').last();
  await expect(notice).toContainText('요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.');
  await expect(input).toBeDisabled();
  const lockedAt = Date.now();
  await expect(input).toHaveAttribute('placeholder', '잠시 뒤 다시 보낼 수 있어요.');
  await expect(sendButton).toBeDisabled();
  await expect(notice.locator('.notice-action')).toBeDisabled();
  // 기다리라는 말을 들은 방문자도 사람에게는 연결할 수 있다
  await expect(frame.locator('.handoff')).toBeEnabled();

  // Retry-After(3초)가 지나면 "다시 보내기"와 입력창이 함께 풀린다
  await expect(input).toBeEnabled();
  expect(Date.now() - lockedAt).toBeGreaterThan(2000);
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('placeholder', '메시지를 입력하세요');
  await expect(notice.locator('.notice-action')).toBeEnabled();

  // 가로채기는 한 번뿐이라 다음 질문은 서버로 가서 답을 받는다
  await send(frame, '환불되나요?');
  await expect(finishedAnswers(frame)).toHaveCount(1);
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

test('인사말 A/B: 처음 방문하면 서버가 배정한 인사말이 대화 맨 위에 보이고, 이 사이트가 그 변형을 보존하며, 열림·첫 질문 사건이 같은 변형을 싣는다', async ({
  page,
  consoleErrors,
}) => {
  const sent = watchEvents(page);
  const greeting = greetingResponse(page);
  const frame = await openWidget(page);
  const res = await greeting;
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('no-store');
  expect(new URL(res.url()).searchParams.has('variant')).toBe(false);
  expect(await iframeVariant(page)).toBeNull();
  const assigned = await assignedGreeting(res);

  await expect(frame.locator('.msgs > .msg').first()).toHaveClass(/\bgreeting\b/);
  await expect(frame.locator('.msg.greeting')).toHaveText(assigned.text);
  await expect(frame.locator('.title')).toHaveText('무엇을 도와드릴까요?');
  await expect.poll(() => storedVariant(page)).toBe(assigned.variant);

  await send(frame, '환불되나요?');
  await expect(finishedAnswers(frame)).toHaveCount(1);
  await expect(frame.locator('.msg.greeting')).toHaveCount(1);
  expect(sent).toEqual([
    { tenant: 'demo', type: 'widget_open', variant: assigned.variant },
    { tenant: 'demo', type: 'first_question', variant: assigned.variant },
  ]);
  expect(consoleErrors).toEqual([]);
});

test('인사말 A/B: 다시 로드하면 런처가 보존한 변형을 v=로 넘기고 같은 인사말을 본다', async ({ page, consoleErrors }) => {
  const sent = watchEvents(page);
  const first = greetingResponse(page);
  await openWidget(page);
  const assigned = await assignedGreeting(await first);
  await expect.poll(() => storedVariant(page)).toBe(assigned.variant);

  const again = greetingResponse(page);
  const frame = await openWidget(page);
  const res = await again;
  expect(await iframeVariant(page)).toBe(assigned.variant);
  expect(new URL(res.url()).searchParams.get('variant')).toBe(assigned.variant);
  expect(await assignedGreeting(res)).toEqual(assigned);
  await expect(frame.locator('.msg.greeting')).toHaveText(assigned.text);
  await expect.poll(() => sent.length).toBe(2);
  expect(sent.map((b) => b.variant)).toEqual([assigned.variant, assigned.variant]);
  expect(consoleErrors).toEqual([]);
});

test('인사말 A/B: 다른 변형을 보존한 재방문자는 그 변형의 인사말을 본다', async ({ page, request, consoleErrors }) => {
  for (const { id, text } of await currentVariants(request)) {
    await storeBeforeLoad(page, id);
    const greeting = greetingResponse(page);
    const frame = await openWidget(page);
    expect(await iframeVariant(page)).toBe(id);
    expect(await assignedGreeting(await greeting)).toEqual({ variant: id, text });
    await expect(frame.locator('.msg.greeting')).toHaveText(text);
  }
  expect(consoleErrors).toEqual([]);
});

test('인사말 A/B: 보존값이 지금 실험에 없으면 서버가 새로 배정해 런처가 덮어쓰고, 형식이 틀린 값은 URL에 싣지 않는다', async ({
  page,
  request,
  context,
  consoleErrors,
}) => {
  const ids = (await currentVariants(request)).map((v) => v.id);

  // 옛 실험의 값(형식은 맞다) → v=로 넘어가지만 서버가 무시하고 새로 배정한다
  await storeBeforeLoad(page, 'greet-old.z');
  const greeting = greetingResponse(page);
  await openWidget(page);
  expect(await iframeVariant(page)).toBe('greet-old.z');
  const assigned = await assignedGreeting(await greeting);
  expect(ids).toContain(assigned.variant);
  await expect.poll(() => storedVariant(page)).toBe(assigned.variant);

  // 호스트 스크립트가 형식이 틀린 값을 넣었다 → 런처가 싣지 않는다
  const other = await context.newPage();
  await storeBeforeLoad(other, 'not a variant!');
  const reassigned = greetingResponse(other);
  await openWidget(other);
  expect(await iframeVariant(other)).toBeNull();
  expect(ids).toContain((await assignedGreeting(await reassigned)).variant);
  expect(consoleErrors).toEqual([]);
});

test('인사말 A/B: 이 사이트의 저장소가 막힌 브라우저에서도 대화창은 인사말과 함께 뜨고, 보존만 빠진다', async ({ page, consoleErrors }) => {
  await page.addInitScript((origin) => {
    if (location.origin !== origin) return;
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
  }, DEMO_ORIGIN);

  for (let load = 0; load < 2; load += 1) {
    const greeting = greetingResponse(page);
    const frame = await openWidget(page);
    expect(await iframeVariant(page)).toBeNull();
    await expect(frame.locator('.msg.greeting')).toHaveText((await assignedGreeting(await greeting)).text);
  }
  expect(consoleErrors).toEqual([]);
});

test('인사말 A/B: 인사말이 오기 전에 닫으면 열림은 변형 없이 세고, 그 페이지 로드는 실험 밖이다', async ({ page, consoleErrors }) => {
  await page.route(`${GREETING_URL}?**`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });
  const sent = watchEvents(page);
  const greeting = greetingResponse(page);
  const frame = await openWidget(page);
  const launcher = page.locator(LAUNCHER);
  const opened = page.waitForRequest((r) => r.url() === EVENTS_URL && r.method() === 'POST');
  await launcher.click();
  await expect(launcher).toHaveAttribute('aria-expanded', 'false');
  await assignedGreeting(await greeting);
  await opened;
  expect(sent).toEqual([{ tenant: 'demo', type: 'widget_open' }]);

  await launcher.click();
  await send(frame, '환불되나요?');
  await expect(finishedAnswers(frame)).toHaveCount(1);
  expect(sent).toEqual([
    { tenant: 'demo', type: 'widget_open' },
    { tenant: 'demo', type: 'first_question' },
  ]);
  expect(consoleErrors).toEqual([]);
});

test('인사말 A/B: 인사말 요청이 실패하면 기다리지 않고 변형 없이 열림 사건을 보내고, 인사말 없이 대화창이 뜬다', async ({ page, consoleErrors }) => {
  await page.route(`${GREETING_URL}?**`, (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error' }) }),
  );
  const sent = watchEvents(page);
  await page.goto('/demo.html');
  const opened = page.waitForRequest((r) => r.url() === EVENTS_URL && r.method() === 'POST');
  const clickedAt = Date.now();
  await page.locator(LAUNCHER).click();
  await opened;
  // 인사말을 기다리는 상한(3초)까지 가지 않는다
  expect(Date.now() - clickedAt).toBeLessThan(2_500);
  expect(sent).toEqual([{ tenant: 'demo', type: 'widget_open' }]);

  const frame = page.frameLocator(FRAME);
  await expect(frame.locator('#qrate-input')).toBeVisible();
  await expect(frame.locator('.msg.greeting')).toHaveCount(0);
  expect(await storedVariant(page)).toBeNull();
  expect(consoleErrors.filter((e) => !e.startsWith('Failed to load resource'))).toEqual([]);
});
