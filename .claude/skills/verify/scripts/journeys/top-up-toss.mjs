/* global URL, window, document */
// 토스 테스트 결제 — 운영자 경로: 콘솔 #/billing → 결제하기 → 토스 결제창(진짜 SDK, 테스트 키) → 결제창에서 돌아온 주소.
// 결제는 끝내지 않는다. 결제창의 인증은 사람이 한다. 승인 성공은 사용자가 본인 키로 한 번 직접 하고, 그 결과는 이 여정이 아니라 PR에 적는다.
// 이 여정이 증명하는 것: 토스일 때만 콘솔 CSP가 측정한 토스 호스트를 연다, 결제하기 전에는 토스로 나가는 요청이 없다,
// 결제창이 CSP 위반 없이 뜬다, 토스가 모르는 결제 키로 돌아오면 서버가 승인·조회를 물은 뒤 "확인하지 못함"으로 답하고 원장은 그대로다,
// 실패 주소의 문장(message)은 화면에 쓰지 않는다.
// 실제 토스 호출은 결제창 1회, 승인 1회, 조회 1회다. 키는 launch가 실행 환경의 QRATE_VERIFY_TOSS_*에서만 받고, 레포와 증거에는 남기지 않는다.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SERVER_ORIGIN, assert } from '../lib.mjs';
import { loginConsole } from '../harness.mjs';

export const title = '토스 테스트 결제 — 콘솔 CSP·결제창(진짜 SDK)·모르는 결제 키로 돌아옴·실패 주소·원장 그대로';

const SEED_BALANCE = 100;
const TOSS_HOST = /(^|\.)(tosspayments\.com|toss\.im)$/;
// apps/server/src/http/console/static.ts의 CHECKOUT_SOURCES.toss와 같은 값. 서버가 실제로 내는 헤더와 대조한다.
const EXPECTED_CSP_PARTS = [
  "script-src 'self' https://js.tosspayments.com",
  "connect-src 'self' https://api.tosspayments.com https://apigw-sandbox.tosspayments.com https://event.tosspayments.com https://log.tosspayments.com",
  "frame-src 'self' https://payment-widget.tosspayments.com https://payment-gateway-sandbox.tosspayments.com https://toss.im",
  "frame-ancestors 'none'",
];

const masked = (key) => (typeof key === 'string' ? `${key.slice(0, 9)}…(${key.length}자)` : key);

export async function run(h) {
  const { expect } = h;
  const page = await h.newPage({ name: 'console', ignoreConsole: /401|Unauthorized/ });
  // 위반은 문서가 생기자마자 모은다. 토스 결제창 iframe 안의 위반은 토스 문서의 것이라 여기 잡히지 않는다(우리 정책과 무관).
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile });
    });
  });
  const tossRequests = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (TOSS_HOST.test(url.hostname)) tossRequests.push({ at: new Date().toISOString(), method: r.method(), host: url.hostname, path: url.pathname });
  });
  const balance = page.getByTestId('credit-balance');
  const notice = page.getByTestId('toss-return');
  let order;

  const credits = async () => {
    const res = await page.request.get('/api/console/credits');
    assert(res.status() === 200, `GET /api/console/credits ${res.status()}`);
    return res.json();
  };
  const topUps = async () => {
    const res = await page.request.get('/api/console/top-ups');
    assert(res.status() === 200, `GET /api/console/top-ups ${res.status()}`);
    return res.json();
  };

  await h.step('toss-csp', '토스일 때 콘솔 문서 CSP가 측정한 토스 호스트만 연다', async () => {
    const res = await h.api.get('/console/');
    const csp = res.headers()['content-security-policy'] ?? '';
    h.evidence.save('console-csp.txt', `${res.status()} ${res.url()}\ncontent-security-policy: ${csp}\n`);
    assert(res.status() === 200, `GET /console/ ${res.status()}`);
    for (const part of EXPECTED_CSP_PARTS) assert(csp.includes(part), `CSP에 "${part}"가 없다: ${csp}`);
    assert(!csp.includes('*'), `CSP에 와일드카드가 있다: ${csp}`);
    return `CSP ${csp.split(';').length}개 지시문 · 토스 호스트 8개 · 와일드카드 없음`;
  });

  await h.step('toss-open', '로그인 뒤 #/billing에 "결제하기"가 보이고, 이때까지 토스로 나간 요청은 없다', async () => {
    await page.goto(`${SERVER_ORIGIN}/console/`);
    await loginConsole(h, page);
    await page.goto(`${SERVER_ORIGIN}/console/#/billing`);
    await expect(balance).toHaveText(String(SEED_BALANCE));
    await expect(page.getByRole('button', { name: '결제하기' })).toBeVisible();
    const list = await topUps();
    assert(list.provider === 'toss', `provider=${list.provider}`);
    assert(typeof list.clientKey === 'string' && list.clientKey.startsWith('test_gck_'), `clientKey=${masked(list.clientKey)}`);
    h.evidence.saveJson('top-ups-before.json', { ...list, clientKey: masked(list.clientKey) });
    assert(tossRequests.length === 0, `결제하기 전에 토스 요청 ${tossRequests.length}건: ${JSON.stringify(tossRequests)}`);
    return `잔액 ${SEED_BALANCE} · provider=toss · clientKey ${masked(list.clientKey)} · 토스 요청 0건`;
  });

  await h.step('toss-window', '100크레딧으로 "결제하기"를 누르면 대기 주문이 생기고 토스 결제창이 CSP 위반 없이 뜬다', async () => {
    await page.getByTestId('package-credits_100').check();
    const created = page.waitForResponse((r) => r.url().endsWith('/api/console/top-ups') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '결제하기' }).click();
    const res = await created;
    order = await res.json();
    assert(res.status() === 201, `POST /api/console/top-ups ${res.status()}`);
    assert(order.provider === 'toss' && order.status === 'pending', `주문 ${JSON.stringify(order)}`);
    const widgetFrame = () => page.frames().find((f) => f.url().startsWith('https://payment-widget.tosspayments.com'));
    await expect.poll(() => Boolean(widgetFrame()), { timeout: 20_000, message: '토스 결제창 iframe(payment-widget.tosspayments.com)' }).toBe(true);
    // 결제창이 결제수단 목록을 그릴 시간을 준다(스크린샷용). 판정은 iframe의 존재와 위반 수로 한다.
    await page.waitForTimeout(4_000);
    const violations = await page.evaluate(() => window.__cspViolations);
    h.evidence.saveJson('csp-violations.json', violations);
    h.evidence.saveJson('toss-requests.json', tossRequests);
    assert(violations.length === 0, `CSP 위반 ${violations.length}건: ${JSON.stringify(violations)}`);
    const hosts = [...new Set(tossRequests.map((r) => r.host))].sort();
    return `주문 ${order.id} 결제 대기 · 결제창 iframe ${new URL(widgetFrame().url()).hostname} · CSP 위반 0 · 토스 호스트 ${hosts.join(', ')}`;
  });

  await h.step('toss-unknown-payment', '토스가 모르는 결제 키로 돌아오면 서버가 승인·조회를 묻고 "확인하지 못함"과 "다시 확인"을 보인다', async () => {
    const fakeKey = `tgen_verify_${randomBytes(8).toString('hex')}`;
    const confirmed = page.waitForResponse((r) => r.url().endsWith(`/api/console/top-ups/${order.id}/confirm`));
    const returnUrl = `${SERVER_ORIGIN}/console/?toss=success&paymentType=NORMAL&orderId=${order.id}&paymentKey=${fakeKey}&amount=${order.amount}`;
    await page.goto(returnUrl);
    const res = await confirmed;
    const body = await res.json();
    h.evidence.save('confirm-unknown-payment.json.txt', `${res.status()} ${res.url()}\n\n${JSON.stringify(body, null, 2)}\n`);
    assert(res.status() === 200 && body.outcome === 'unconfirmed', `확정 응답 ${res.status()} ${JSON.stringify(body)}`);
    await expect(notice).toContainText('토스에서 결제 완료를 아직 확인하지 못했어요.');
    await expect(notice.getByRole('button', { name: '다시 확인' })).toBeVisible();
    const url = new URL(page.url());
    assert(url.search.includes('toss=success') && url.hash === '#/billing', `주소 ${page.url()}`);
    const log = readFileSync(path.join(h.evidence.dir, 'server.log'), 'utf8');
    const line = log.split('\n').find((l) => l.includes('"where":"billing.confirm"') && l.includes(order.id));
    assert(line, 'server.log에 billing.confirm 보고 줄이 없다');
    assert(line.includes('confirm 404') && line.includes('lookup 404'), `보고 줄이 토스의 승인·조회 답을 담지 않았다: ${line}`);
    return `200 unconfirmed · 쿼리 남김(#/billing) · server.log ${line.match(/"detail":"[^"]*"/)?.[0] ?? '(detail 없음)'}`;
  });

  await h.step('toss-fail-return', '실패 주소로 돌아오면 코드별 우리 문구만 보이고 주소의 문장은 화면에 없다', async () => {
    const injected = '위조 안내 — 지금 다른 계좌로 송금하세요';
    await page.goto(`${SERVER_ORIGIN}/console/?toss=fail&code=PAY_PROCESS_CANCELED&message=${encodeURIComponent(injected)}&orderId=${order.id}`);
    await expect(notice).toHaveText('결제를 취소했어요. 주문은 결제 대기로 남아요.');
    assert(!(await page.content()).includes(injected), '실패 주소의 message가 화면에 있다');
    assert(page.url() === `${SERVER_ORIGIN}/console/#/billing`, `주소가 정리되지 않았다: ${page.url()}`);
    return `"결제를 취소했어요." · message 미표시 · 주소 ${page.url()}`;
  });

  await h.step('toss-ledger', '원장과 주문은 그대로다(잔액 100, 주문은 결제 대기)', async () => {
    const after = await credits();
    h.evidence.saveJson('console-credits.json', after);
    assert(after.balance === SEED_BALANCE, `잔액 ${after.balance}`);
    const list = await topUps();
    h.evidence.saveJson('top-ups-after.json', { ...list, clientKey: masked(list.clientKey) });
    const mine = list.items.find((t) => t.id === order.id);
    assert(mine?.status === 'pending', `주문 상태 ${mine?.status}`);
    await page.reload();
    await expect(balance).toHaveText(String(SEED_BALANCE));
    return `잔액 ${after.balance} · 주문 ${order.id} 결제 대기 · 토스 요청 합계 ${tossRequests.length}건`;
  });
}
