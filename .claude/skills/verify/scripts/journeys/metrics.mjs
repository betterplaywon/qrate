// 콘솔 지표 — 방문자 두 명의 행동이 운영자의 지표 화면 숫자가 되는 경로: 데모 페이지에서 위젯 열기(widget_open) → 질문 1건(답 끝까지) →
// 닫고 다시 열기(열림은 그대로 1건) → 다른 페이지 로드에서 질문 없이 상담원 연결만 → 콘솔 #/metrics의 표본·백분위·해결률·열림 수 →
// server.log의 사건 JSON 줄과 대조. 새 launch라 메모리 저장소가 비어 있어 절대값으로 본다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SERVER_ORIGIN, assert } from '../lib.mjs';
import { LAUNCHER, finishedAnswers, loginConsole, openWidget, send } from '../harness.mjs';

export const title = '콘솔 지표 — 위젯 열림·답한 질문·연결만 요청한 대화 → #/metrics 값 → server.log 사건 줄';

const QUESTION = '요금제가 뭐가 있나요?';
const EVENTS_URL = `${SERVER_ORIGIN}/api/events`;

/** "1,234ms" → 1234 */
const msOf = (text) => Number(text.replace(/[,ms]/g, ''));

export async function run(h) {
  const { expect } = h;
  const eventPosts = [];
  const watchEvents = (page, name) =>
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url() === EVENTS_URL) eventPosts.push({ page: name, frame: r.frame().url(), body: r.postDataJSON() });
    });

  const first = await h.newPage({ name: 'visitor-1' });
  watchEvents(first, 'visitor-1');
  let frame;
  await h.step('metrics-widget-open', '데모 페이지에서 위젯을 열면 대화창 문서가 widget_open 사건을 한 번 보내고 202를 받는다', async () => {
    const accepted = first.waitForResponse((r) => r.url() === EVENTS_URL);
    frame = await openWidget(h, first);
    const res = await accepted;
    assert(res.status() === 202, `POST /api/events ${res.status()}`);
    assert(eventPosts.length === 1, `열림 사건 ${eventPosts.length}건`);
    const [sent] = eventPosts;
    assert(sent.frame.startsWith(`${SERVER_ORIGIN}/frame?`), `사건을 보낸 문서: ${sent.frame}`);
    assert(JSON.stringify(sent.body) === JSON.stringify({ tenant: h.tenant, type: 'widget_open' }), `본문: ${JSON.stringify(sent.body)}`);
    return `POST /api/events 202 · 본문 ${JSON.stringify(sent.body)} · 보낸 문서 /frame`;
  });

  await h.step('metrics-answer', `"${QUESTION}"를 보내 답을 끝까지 받는다(상담원 연결 신호 없음)`, async () => {
    await send(frame, QUESTION);
    await expect(finishedAnswers(frame)).toHaveCount(1);
    await expect(frame.locator('.msg.notice')).toHaveCount(0);
    return `답변 완료 (conversationId=${h.chat.responses.at(-1)?.conversationId})`;
  });

  await h.step('metrics-reopen', '닫았다 다시 열면 대화창이 다시 보이고 열림 사건은 더 나가지 않는다', async () => {
    const launcher = first.locator(LAUNCHER);
    await frame.locator('.close').click();
    await expect(launcher).toHaveAttribute('aria-expanded', 'false');
    await launcher.click();
    await expect(launcher).toHaveAttribute('aria-expanded', 'true');
    await expect(frame.locator('#qrate-input')).toBeFocused();
    assert(eventPosts.length === 1, `다시 연 뒤 열림 사건 ${eventPosts.length}건`);
    return '다시 열림(입력창 포커스) · 열림 사건 1건 그대로';
  });

  const second = await h.newPage({ name: 'visitor-2' });
  watchEvents(second, 'visitor-2');
  await h.step('metrics-handoff-only', '다른 페이지 로드에서 위젯을 열고 질문 없이 머리글 "상담원 연결"로 연락처만 남긴다', async () => {
    const accepted = second.waitForResponse((r) => r.url() === EVENTS_URL);
    const other = await openWidget(h, second);
    assert((await accepted).status() === 202, '두 번째 페이지 로드의 열림 사건이 202가 아니다');
    await other.locator('.handoff').click();
    await other.locator('#qrate-contact').fill('metrics@example.com');
    const created = second.waitForResponse((r) => r.url() === `${SERVER_ORIGIN}/api/handoff` && r.request().method() === 'POST');
    await other.locator('.handoff-form button[type="submit"]').click();
    assert((await created).status() === 201, '연결 요청이 201이 아니다');
    await expect(other.locator('.msg.notice').last()).toContainText('접수됐어요');
    return `열림 사건 202 · 연결 요청 201 · 질문 0건 · 열림 사건 누계 ${eventPosts.length}건`;
  });

  const consolePage = await h.newPage({ name: 'console', ignoreConsole: /status of 401/ }); // 로그인 전 /me의 401은 정상
  let p50 = 0;
  await h.step('metrics-console', '콘솔 "지표" 화면: TTFT 표본 1건(p50 = p95), 자동 해결 1/2건 = 50.0%, 위젯 열림 2회', async () => {
    await consolePage.goto(`${SERVER_ORIGIN}/console/`);
    await loginConsole(h, consolePage);
    await expect(consolePage.getByTestId('tenant-name')).toHaveText(h.tenantName);
    await consolePage.getByTestId('nav-metrics').click();
    await expect(consolePage).toHaveURL(/#\/metrics$/);
    await expect(consolePage.getByTestId('metrics-window')).toContainText('최근 7일');
    await expect(consolePage.getByTestId('metric-ttft-samples')).toHaveText('1');
    const p50Text = (await consolePage.getByTestId('metric-ttft-p50').textContent()) ?? '';
    assert(/^[\d,]+ms$/.test(p50Text), `p50 표시: "${p50Text}"`);
    await expect(consolePage.getByTestId('metric-ttft-p95')).toHaveText(p50Text);
    await expect(consolePage.getByTestId('metric-resolution-resolved')).toHaveText('1');
    await expect(consolePage.getByTestId('metric-resolution-conversations')).toHaveText('2');
    await expect(consolePage.getByTestId('metric-resolution-rate')).toHaveText('50.0%');
    await expect(consolePage.getByTestId('metric-widget-opens')).toHaveText('2');
    p50 = msOf(p50Text);

    const res = await consolePage.request.get('/api/console/metrics');
    await h.evidence.saveApiResponse('console-metrics.txt', res);
    const body = await res.json();
    assert(res.headers()['cache-control'] === 'no-store', `cache-control: ${res.headers()['cache-control']}`);
    assert(
      body.ttft.samples === 1 && body.ttft.p50Ms === p50 && body.ttft.p95Ms === p50,
      `API ttft ${JSON.stringify(body.ttft)} ≠ 화면 ${p50}ms`,
    );
    assert(
      JSON.stringify(body.autoResolution) === JSON.stringify({ conversations: 2, resolved: 1, rate: 0.5 }) && body.widget.opens === 2,
      `API ${JSON.stringify({ autoResolution: body.autoResolution, widget: body.widget })}`,
    );
    return `화면: p50 = p95 = ${p50Text}, 표본 1 · 해결 1/2 = 50.0% · 열림 2 — API 응답과 같음`;
  });

  await h.step('metrics-server-log', 'server.log에 사건 JSON 줄: chat_request 1줄(ttftMs = 화면 p50, 질문 원문 없음), widget_open 2줄', async () => {
    const logPath = path.join(h.evidence.dir, 'server.log');
    let log;
    try {
      log = readFileSync(logPath, 'utf8');
    } catch {
      throw new Error(`${logPath} 없음 — launch.mjs metrics로 새로 띄운 실행에서 돌린다`);
    }
    const events = log
      .split('\n')
      .filter((line) => line.startsWith('{"type":'))
      .map((line) => JSON.parse(line));
    const chats = events.filter((e) => e.type === 'chat_request');
    const opens = events.filter((e) => e.type === 'widget_open');
    assert(chats.length === 1, `chat_request ${chats.length}줄`);
    const [chat] = chats;
    assert(chat.payload.outcome === 'done' && chat.ttftMs === p50, `chat_request ${JSON.stringify({ outcome: chat.payload.outcome, ttftMs: chat.ttftMs })} · 화면 p50 ${p50}`);
    assert(opens.length === 2, `widget_open ${opens.length}줄`);
    assert(!log.includes(QUESTION), 'server.log에 질문 원문이 있다');
    assert(eventPosts.length === 2, `브라우저가 보낸 열림 사건 ${eventPosts.length}건`);
    return `chat_request 1줄(outcome done, ttftMs ${chat.ttftMs}) · widget_open 2줄 · 질문 원문 없음 · 브라우저 열림 사건 2건`;
  });

  await h.step('metrics-no-errors', '세 페이지 모두 브라우저 콘솔 오류가 없다', async () => {
    const errors = [first, second, consolePage].flatMap((p) => h.errorsOf(p));
    assert(errors.length === 0, `콘솔 오류: ${errors.join(' | ')}`);
    return '0건(로그인 전 /me의 401 리소스 오류는 제외)';
  });
}
