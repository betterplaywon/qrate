/* global URL, getComputedStyle */
// 위젯 대화 — 방문자 경로: 데모 페이지 → 런처(Shadow DOM) → 대화창(서버 오리진 iframe) → 질문 → 스트리밍 답변·출처 인용 →
// 두 번째 질문이 같은 대화로 이어짐 → 콘솔 대화 로그에 남음(부수 효과). 기대값은 packages/widget/e2e/widget.spec.ts와 같다.
import { DEMO_ORIGIN, SERVER_ORIGIN, assert } from '../lib.mjs';
import { FRAME, HOST, LAUNCHER, LOADING, finishedAnswers, loginApi, loginConsole, send } from '../harness.mjs';

export const title = '위젯 대화 — 런처 → 대화창 iframe → 스트리밍 답변·출처 1건 → 대화 이어 가기 → 콘솔 대화 로그';

const QUESTION = '요금제가 뭐가 있나요?';
const FOLLOW_UP = '추가 인원 비용은요?';
// 목업은 "그 질문에 맞게 고른 지식"의 첫 항목 첫 블록을 인용한다 — 어느 항목인지는 지식 선택 순서에 달려 있으니 제목을 고정하지 않고
// 답변 본문에 적힌 제목과 출처 접기의 제목이 같은지로 본다.
const ANSWER_PATTERN = /^목업 응답입니다\. 자료 "([^"]+)"에 따르면: (.+)$/s;

export async function run(h) {
  const { expect } = h;
  const page = await h.newPage({ name: 'demo' });
  const launcher = page.locator(LAUNCHER);
  const frame = page.frameLocator(FRAME);
  const serverRequests = [];
  page.on('request', (r) => {
    if (r.url().startsWith(SERVER_ORIGIN)) serverRequests.push(r.url());
  });

  await h.step('chat-launcher', '데모 페이지를 열면 런처만 보이고, 열기 전에는 서버에 아무 요청도 가지 않는다', async () => {
    await page.goto(`${DEMO_ORIGIN}/demo.html`);
    await expect(launcher).toBeVisible();
    await expect(launcher).toHaveAttribute('aria-label', '상담 열기');
    // demo.html의 전역 CSS(`* { font-family: serif !important; color: red }`)가 shadow root 안에는 닿지 않아야 한다
    const style = await launcher.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, fontFamily: cs.fontFamily };
    });
    assert(style.color !== 'rgb(255, 0, 0)' && style.fontFamily.includes('system-ui'), `호스트 CSS가 런처에 새어 들어갔다: ${JSON.stringify(style)}`);
    await expect(page.locator(`${HOST} iframe`)).toHaveCount(0);
    assert(serverRequests.length === 0, `열기 전 서버 요청 ${serverRequests.length}건: ${serverRequests.join(', ')}`);
    return `런처 표시(색 ${style.color}, 글꼴 system-ui), iframe 0개, 서버 요청 0건`;
  });

  await h.step('chat-open', '런처를 누르면 서버 오리진의 /frame iframe이 열리고(CSP frame-ancestors), 대화창이 ready를 보내 로딩 문구가 사라진다', async () => {
    const frameResponse = page.waitForResponse((r) => r.url().startsWith(`${SERVER_ORIGIN}/frame?`));
    await launcher.click();
    const res = await frameResponse;
    const src = new URL((await page.locator(FRAME).getAttribute('src')) ?? '');
    assert(src.origin === SERVER_ORIGIN && src.pathname === '/frame', `iframe src가 서버 오리진의 /frame이 아니다: ${src.href}`);
    assert(src.searchParams.get('t') === 'demo' && src.searchParams.get('o') === DEMO_ORIGIN, `iframe 쿼리: ${src.search}`);
    assert(res.status() === 200, `/frame 응답 ${res.status()}`);
    const csp = res.headers()['content-security-policy'] ?? '';
    assert(csp.includes(`frame-ancestors ${DEMO_ORIGIN}`), `CSP에 frame-ancestors ${DEMO_ORIGIN}가 없다: "${csp}"`);
    assert(res.headers()['cache-control'] === 'no-store', `cache-control: ${res.headers()['cache-control']}`);
    await expect(page.locator(LOADING)).toHaveCount(0);
    await expect(launcher).toHaveAttribute('aria-expanded', 'true');
    await expect(frame.locator('.title')).toHaveText('무엇을 도와드릴까요?');
    return `iframe ${src.pathname}${src.search} · /frame 200 · CSP "${csp}" · ready 수신(로딩 문구 제거)`;
  });

  let citedTitle = '';
  await h.step('chat-stream', `"${QUESTION}"를 보내면 답변이 한 글자씩 흘러오고, 끝나면 출처 1건이 붙는다(답변에 적힌 자료 제목 = 출처 제목, 인용문 = 답변의 근거 문장)`, async () => {
    await send(frame, QUESTION);
    await expect(frame.locator('.msg.user')).toHaveText(QUESTION);
    const bubble = frame.locator('.msg.bot').first();
    await expect(bubble).toHaveAttribute('aria-busy', 'true');
    await expect(bubble.locator('.text')).toContainText('목업 응답');
    await expect(finishedAnswers(frame)).toHaveCount(1);
    const text = (await bubble.locator('.text').textContent()) ?? '';
    const match = ANSWER_PATTERN.exec(text);
    assert(match, `답변 본문이 목업의 인용 형식이 아니다: "${text.slice(0, 80)}"`);
    citedTitle = match[1];
    await expect(bubble.locator('.sources summary')).toHaveText('출처 1건');
    await expect(bubble.locator('.source-title')).toHaveText(citedTitle);
    await expect(bubble.locator('.quote q')).toHaveCount(1);
    // 출처 접기를 펼쳐 스크린샷에 인용문이 보이게 한다
    await bubble.locator('.sources summary').click();
    await expect(bubble.locator('.quote q')).toBeVisible();
    await expect(bubble.locator('.quote q')).toHaveText(match[2]);
    return `스트리밍(aria-busy) 뒤 완료, 출처 1건 "${citedTitle}", 인용문이 답변의 근거 문장과 일치`;
  });

  await h.step('chat-continue', `"${FOLLOW_UP}"는 첫 응답의 X-Conversation-Id를 싣고 같은 대화로 이어진다. 두 요청 모두 iframe 문서에서만 나간다`, async () => {
    await send(frame, FOLLOW_UP);
    await expect(finishedAnswers(frame)).toHaveCount(2);
    const reqs = h.chat.requests;
    const ress = h.chat.responses;
    assert(reqs.length === 2 && ress.length === 2, `대화 API 요청 ${reqs.length}건 / 응답 ${ress.length}건 (2/2 기대)`);
    for (const r of reqs) assert(r.frameUrl.startsWith(`${SERVER_ORIGIN}/frame?`), `호스트 문서가 /api/chat을 불렀다: ${r.frameUrl}`);
    assert(reqs[0].body.conversationId == null, `첫 요청에 conversationId가 있다: ${reqs[0].body.conversationId}`);
    assert(ress[0].conversationId, '첫 응답에 X-Conversation-Id가 없다');
    assert(reqs[1].body.conversationId === ress[0].conversationId, `둘째 요청 conversationId=${reqs[1].body.conversationId} ≠ 첫 응답 ${ress[0].conversationId}`);
    return `conversationId=${ress[0].conversationId} · 요청 출처 ${reqs.map((r) => new URL(r.frameUrl).pathname).join(', ')}`;
  });

  const conversationId = h.chat.responses[0].conversationId;

  await h.step('chat-logged', '콘솔 API의 대화 로그에 그 대화가 메시지 4건(방문자 2·AI 2)으로 저장돼 있다(부수 효과)', async () => {
    await loginApi(h);
    const list = await h.api.get('/api/console/conversations');
    await h.evidence.saveApiResponse('console-conversations.txt', list);
    assert(list.status() === 200, `GET /api/console/conversations ${list.status()}`);
    const { items } = await list.json();
    const conv = items.find((c) => c.id === conversationId);
    assert(conv, `대화 로그에 ${conversationId}가 없다 (${items.length}건)`);
    assert(conv.messageCount === 4, `messageCount=${conv.messageCount} (4 기대)`);
    assert(conv.preview.includes(QUESTION), `preview="${conv.preview}"`);
    const detail = await h.api.get(`/api/console/conversations/${conversationId}`);
    await h.evidence.saveApiResponse('console-conversation-detail.txt', detail);
    const { messages } = await detail.json();
    const roles = messages.map((m) => m.role).join(',');
    assert(roles === 'user,assistant,user,assistant', `roles=${roles}`);
    assert(messages[0].content === QUESTION && messages[2].content === FOLLOW_UP, '저장된 질문이 보낸 것과 다르다');
    assert(messages[1].content.includes(`자료 "${citedTitle}"에 따르면`), `저장된 답변이 화면과 다르다: ${messages[1].content.slice(0, 60)}`);
    return `대화 ${conversationId}: messageCount=4, roles ${roles}`;
  });

  const consolePage = await h.newPage({ name: 'console', ignoreConsole: /status of 401/ }); // 로그인 전 /me의 401은 정상
  await h.step('chat-console-ui', '운영 콘솔에 로그인하면 대화 로그에 그 대화가 보이고, 열면 메시지 4건이 있다', async () => {
    await consolePage.goto(`${SERVER_ORIGIN}/console/`);
    await loginConsole(h, consolePage);
    await expect(consolePage.getByTestId('tenant-name')).toHaveText(h.tenantName);
    await consolePage.goto(`${SERVER_ORIGIN}/console/#/conversations`);
    const items = consolePage.getByTestId('conversation-item');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText(QUESTION);
    await expect(items.first()).toContainText('메시지 4');
    await items.first().click();
    await expect(consolePage.getByTestId('messages').locator('li')).toHaveCount(4);
    return `콘솔 대화 로그 1건 "${QUESTION}" · 상세 메시지 4건`;
  });

  await h.step('chat-no-errors', '정상 흐름에서 브라우저 콘솔 오류가 없다', async () => {
    const demoErrors = h.errorsOf(page);
    const consoleErrors = h.errorsOf(consolePage);
    assert(demoErrors.length === 0, `데모 페이지 콘솔 오류: ${demoErrors.join(' | ')}`);
    assert(consoleErrors.length === 0, `콘솔 페이지 콘솔 오류: ${consoleErrors.join(' | ')}`);
    return '데모·콘솔 페이지 모두 0건';
  });
}
