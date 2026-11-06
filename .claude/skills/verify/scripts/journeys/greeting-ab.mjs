/* global URL, localStorage */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SERVER_ORIGIN, assert } from '../lib.mjs';
import { FRAME, finishedAnswers, loginApi, loginConsole, openWidget, send } from '../harness.mjs';

export const title = '인사말 A/B — 서버 배정 인사말 → 이 사이트 보존(v=) → 열림·첫 질문 사건의 변형 → 다른 변형·지금 실험에 없는 보존값 → 콘솔 변형별 노출·첫 질문 → server.log';

const QUESTION = '요금제가 뭐가 있나요?';
const EVENTS_URL = `${SERVER_ORIGIN}/api/events`;
const GREETING_URL = `${SERVER_ORIGIN}/api/greeting`;
const STALE_VARIANT = 'greet-old.z';

const tally = (events) =>
  events
    .map((e) => `${e.type} ${e.variant ?? '(없음)'}`)
    .sort()
    .join(', ');

export async function run(h) {
  const { expect } = h;
  const variantKey = `qrate.greeting.${h.tenant}`;
  const page = await h.newPage({ name: 'visitor' });
  const frame = page.frameLocator(FRAME);
  const events = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url() === EVENTS_URL) events.push(r.postDataJSON());
  });

  const stored = () => page.evaluate((key) => localStorage.getItem(key), variantKey);
  const store = (value) => page.evaluate(([key, v]) => localStorage.setItem(key, v), [variantKey, value]);
  const iframeVariant = async () => new URL((await page.locator(FRAME).getAttribute('src')) ?? '').searchParams.get('v');
  const openAndObserve = async () => {
    const greeting = page.waitForResponse((r) => r.url().startsWith(`${GREETING_URL}?`));
    const opened = page.waitForResponse((r) => r.url() === EVENTS_URL && r.request().postDataJSON()?.type === 'widget_open');
    await openWidget(h, page);
    const res = await greeting;
    const body = await res.json();
    assert(res.status() === 200 && body.greeting, `GET /api/greeting ${res.status()} ${JSON.stringify(body)}`);
    const open = await opened;
    assert(open.status() === 202, `widget_open ${open.status()}`);
    return { res, assigned: body.greeting, requested: new URL(res.url()).searchParams.get('variant'), open: open.request().postDataJSON() };
  };

  let first;
  await h.step('greeting-first-visit', '빈 브라우저로 위젯을 열면 서버가 배정한 인사말이 대화 맨 위에 보이고, 이 사이트가 그 변형을 보존하며, 열림 사건이 같은 변형을 싣는다', async () => {
    const { res, assigned, requested, open } = await openAndObserve();
    assert(res.headers()['cache-control'] === 'no-store', `cache-control: ${res.headers()['cache-control']}`);
    const v = await iframeVariant();
    assert(requested === null && v === null, `첫 방문인데 보존값을 실었다: iframe v=${v}, 요청 variant=${requested}`);
    await expect(frame.locator('.msgs > .msg').first()).toHaveClass(/\bgreeting\b/);
    await expect(frame.locator('.msg.greeting')).toHaveText(assigned.text);
    await expect(frame.locator('.title')).toHaveText('무엇을 도와드릴까요?');
    await expect.poll(stored).toBe(assigned.variant);
    assert(open.variant === assigned.variant, `열림 사건의 변형 ${open.variant} ≠ 배정 ${assigned.variant}`);
    first = assigned;
    return `배정 ${first.variant} "${first.text}" · iframe src에 v 없음 · localStorage ${variantKey}=${first.variant} · widget_open 202 변형 ${open.variant}`;
  });

  await h.step('greeting-sticky', '다시 로드하면 런처가 보존한 변형을 v=로 넘기고 같은 인사말을 본다', async () => {
    const { assigned, requested, open } = await openAndObserve();
    const v = await iframeVariant();
    assert(v === first.variant && requested === first.variant, `iframe v=${v}, 요청 variant=${requested} ≠ ${first.variant}`);
    assert(assigned.variant === first.variant && assigned.text === first.text, `다른 인사말: ${JSON.stringify(assigned)}`);
    await expect(frame.locator('.msg.greeting')).toHaveText(first.text);
    assert(open.variant === first.variant, `열림 사건의 변형 ${open.variant}`);
    return `iframe src v=${v} · GET /api/greeting?variant=${requested} → ${assigned.variant} · 같은 문구 · widget_open 변형 ${open.variant}`;
  });

  await h.step('greeting-question', `"${QUESTION}"를 보내면 first_question 사건이 같은 변형을 싣고, 답변은 인사말 아래에 붙는다`, async () => {
    const asked = page.waitForResponse((r) => r.url() === EVENTS_URL && r.request().postDataJSON()?.type === 'first_question');
    await send(frame, QUESTION);
    const res = await asked;
    const body = res.request().postDataJSON();
    assert(res.status() === 202 && body.variant === first.variant, `first_question ${res.status()} ${JSON.stringify(body)}`);
    await expect(finishedAnswers(frame)).toHaveCount(1);
    await expect(frame.locator('.msg.greeting')).toHaveCount(1);
    await expect(frame.locator('.msgs > .msg').first()).toHaveClass(/\bgreeting\b/);
    return `first_question 202 변형 ${body.variant} · 답변 완료 · 인사말은 맨 위에 하나`;
  });

  let variants = [];
  await h.step('greeting-other-variant', '다른 변형을 보존한 재방문자(이 사이트 localStorage에 그 id)는 그 변형의 인사말을 본다 — id·문구는 콘솔 지표 API에서 읽는다', async () => {
    await loginApi(h);
    const res = await h.api.get('/api/console/metrics');
    await h.evidence.saveApiResponse('console-metrics-variants.txt', res);
    variants = (await res.json()).greeting?.variants ?? [];
    const other = variants.find((v) => v.id !== first.variant);
    assert(other, `다른 변형이 없다: ${JSON.stringify(variants.map((v) => v.id))}`);
    await store(other.id);
    const { assigned, open } = await openAndObserve();
    const v = await iframeVariant();
    assert(v === other.id && assigned.variant === other.id && assigned.text === other.text, `iframe v=${v}, 배정 ${JSON.stringify(assigned)}`);
    await expect(frame.locator('.msg.greeting')).toHaveText(other.text);
    assert(open.variant === other.id, `열림 사건의 변형 ${open.variant}`);
    return `지금 실험의 변형 ${variants.map((x) => x.id).join('·')} · 보존값 ${other.id} → 인사말 "${other.text}" · widget_open 변형 ${open.variant}`;
  });

  await h.step('greeting-tampered', `지금 실험에 없는 보존값(${STALE_VARIANT})은 v=로 넘어가지만 서버가 새로 배정하고, 런처가 그 값으로 덮어쓴다`, async () => {
    await store(STALE_VARIANT);
    const { assigned, requested, open } = await openAndObserve();
    assert(requested === STALE_VARIANT, `요청 variant=${requested}`);
    assert(variants.some((v) => v.id === assigned.variant), `새 배정 ${assigned.variant}이 지금 실험에 없다`);
    await expect.poll(stored).toBe(assigned.variant);
    await expect(frame.locator('.msg.greeting')).toHaveText(assigned.text);
    assert(open.variant === assigned.variant, `열림 사건의 변형 ${open.variant}`);
    return `v=${requested} → 새 배정 ${assigned.variant} · localStorage 덮어씀 · widget_open 변형 ${open.variant}`;
  });

  const consolePage = await h.newPage({ name: 'console', ignoreConsole: /status of 401/ });
  await h.step('greeting-console', '콘솔 "지표"의 인사말 A/B 표: 변형별 노출·첫 질문 = 브라우저가 보낸 사건을 변형별로 센 값 = API, 실험 밖 0', async () => {
    const ids = variants.map((v) => v.id);
    assert(events.every((e) => ids.includes(e.variant)), `지금 실험의 변형이 없는 사건: ${tally(events)}`);
    const observed = (id, type) => events.filter((e) => e.type === type && e.variant === id).length;

    await consolePage.goto(`${SERVER_ORIGIN}/console/`);
    await loginConsole(h, consolePage);
    await expect(consolePage.getByTestId('tenant-name')).toHaveText(h.tenantName);
    await consolePage.getByTestId('nav-metrics').click();
    await expect(consolePage).toHaveURL(/#\/metrics$/);
    for (const v of variants) {
      await expect(consolePage.getByTestId(`metric-greeting-${v.id}`)).toContainText(v.label);
      await expect(consolePage.getByTestId(`metric-greeting-exposures-${v.id}`)).toHaveText(String(observed(v.id, 'widget_open')));
      await expect(consolePage.getByTestId(`metric-greeting-first-questions-${v.id}`)).toHaveText(String(observed(v.id, 'first_question')));
    }
    await expect(consolePage.getByTestId('metric-greeting-outside-opens')).toHaveText('0');
    await expect(consolePage.getByTestId('metric-greeting-outside-questions')).toHaveText('0');
    await expect(consolePage.getByTestId('metric-widget-opens')).toHaveText(String(events.filter((e) => e.type === 'widget_open').length));

    const res = await consolePage.request.get('/api/console/metrics');
    await h.evidence.saveApiResponse('console-metrics.txt', res);
    const { greeting } = await res.json();
    for (const v of greeting.variants) {
      const exposures = observed(v.id, 'widget_open');
      const firstQuestions = observed(v.id, 'first_question');
      const rate = exposures === 0 ? null : firstQuestions / exposures;
      assert(
        v.exposures === exposures && v.firstQuestions === firstQuestions && v.rate === rate,
        `API ${v.id} ${JSON.stringify(v)} ≠ 관찰 { exposures: ${exposures}, firstQuestions: ${firstQuestions}, rate: ${rate} }`,
      );
    }
    assert(JSON.stringify(greeting.outside) === JSON.stringify({ opens: 0, questions: 0 }), `API outside ${JSON.stringify(greeting.outside)}`);
    await consolePage.getByTestId('metric-greeting').scrollIntoViewIfNeeded();
    const rows = greeting.variants.map((v) => `${v.id} 노출 ${v.exposures}·첫 질문 ${v.firstQuestions}·비율 ${v.rate}`).join(' / ');
    return `화면 = API = 브라우저 사건: ${rows} · 실험 밖 0·0`;
  });

  await h.step('greeting-server-log', 'server.log의 widget_open·first_question 줄을 변형별로 센 값이 브라우저가 보낸 사건과 같다', async () => {
    const logPath = path.join(h.evidence.dir, 'server.log');
    let log;
    try {
      log = readFileSync(logPath, 'utf8');
    } catch {
      throw new Error(`${logPath} 없음 — launch.mjs greeting-ab로 새로 띄운 실행에서 돌린다`);
    }
    const logged = log
      .split('\n')
      .filter((line) => line.startsWith('{"type":'))
      .map((line) => JSON.parse(line))
      .filter((e) => e.type === 'widget_open' || e.type === 'first_question');
    assert(tally(logged) === tally(events), `server.log [${tally(logged)}] ≠ 브라우저 [${tally(events)}]`);
    return `server.log ${logged.length}줄 = 브라우저 사건 ${events.length}건: ${tally(logged)}`;
  });

  await h.step('greeting-no-errors', '방문자 페이지와 콘솔 페이지 모두 브라우저 콘솔 오류가 없다', async () => {
    const errors = [page, consolePage].flatMap((p) => h.errorsOf(p));
    assert(errors.length === 0, `콘솔 오류: ${errors.join(' | ')}`);
    return '0건(로그인 전 /me의 401 리소스 오류는 제외)';
  });
}
