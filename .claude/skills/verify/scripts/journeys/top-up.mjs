// 크레딧 충전 — 운영자 경로: 콘솔 #/billing → 충전 요청 → 결제 성공(테스트) → 같은 버튼 다시(재배달) → 결제 실패(테스트)(늦게 온 이벤트).
// 그다음 제공자 쪽 역할로 서명한 웹훅을 HTTP로 직접 보내 재배달·다른 이벤트 id·위조·만료를 재현하고, 원장에 충전 한 줄만 있는지 다시 읽는다.
// 기대값은 apps/console/e2e/console.spec.ts의 충전 시나리오와 apps/server/test/billing-api.test.ts와 같다.
import { createHmac, randomUUID } from 'node:crypto';
import { MOCK_PAYMENT_SECRET, SERVER_ORIGIN, assert } from '../lib.mjs';
import { loginConsole } from '../harness.mjs';

export const title = '크레딧 충전 — 충전 요청 → 결제 성공 → 재배달 → 늦은 실패 → 서명 웹훅 재전송·위조';

const WEBHOOK_PATH = '/api/payments/mock/webhook';
const SIGNATURE_HEADER = 'qrate-mock-signature';
const SEED_BALANCE = 100;

function signedWebhook({ orderId, amount, result, eventId, secret = MOCK_PAYMENT_SECRET, t = Math.floor(Date.now() / 1000) }) {
  const body = JSON.stringify({ id: eventId, type: `payment.${result}`, created: t, data: { orderId, amount } });
  const v1 = createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
  return { body, headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: `t=${t},v1=${v1}` } };
}

export async function run(h) {
  const { expect } = h;
  const page = await h.newPage({ name: 'console' });
  const balance = page.getByTestId('credit-balance');
  const result = page.getByTestId('simulate-result');
  let order;

  const credits = async () => {
    const res = await page.request.get('/api/console/credits');
    assert(res.status() === 200, `GET /api/console/credits ${res.status()}`);
    return res.json();
  };

  await h.step('top-up-open', '로그인 뒤 #/billing에 잔액 100과 충전 폼(모의 제공자)이 보인다', async () => {
    await page.goto(`${SERVER_ORIGIN}/console/`);
    await loginConsole(h, page);
    await page.goto(`${SERVER_ORIGIN}/console/#/billing`);
    await expect(balance).toHaveText(String(SEED_BALANCE));
    await expect(page.getByRole('button', { name: '충전 요청' })).toBeVisible();
    const list = await (await page.request.get('/api/console/top-ups')).json();
    assert(list.provider === 'mock', `provider=${list.provider}`);
    return `잔액 ${SEED_BALANCE} · 충전 폼 보임 · GET /api/console/top-ups provider=mock`;
  });

  await h.step('top-up-request', '100크레딧을 고르고 "충전 요청"을 누르면 201과 함께 "결제 대기" 주문이 생긴다', async () => {
    await page.getByTestId('package-credits_100').check();
    const created = page.waitForResponse((r) => r.url().endsWith('/api/console/top-ups') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '충전 요청' }).click();
    const res = await created;
    order = await res.json();
    await h.evidence.save('top-up-request.json.txt', `${res.status()} ${res.url()}\n\n${JSON.stringify(order, null, 2)}\n`);
    assert(res.status() === 201, `POST /api/console/top-ups ${res.status()}`);
    await expect(page.getByTestId('top-up-item').filter({ hasText: order.id }).getByTestId('top-up-status')).toHaveText('결제 대기');
    return `201 주문 ${order.id} · ${order.credits}크레딧 ${order.amount}원 · 결제 대기`;
  });

  const row = () => page.getByTestId('top-up-item').filter({ hasText: order.id });

  await h.step('top-up-pay', '"결제 성공(테스트)"를 누르면 충전 안내가 뜨고 상태가 "결제 완료", 잔액이 200이 된다', async () => {
    await row().getByRole('button', { name: '결제 성공(테스트)' }).click();
    await expect(result).toHaveText('100크레딧을 충전했어요.');
    await expect(row().getByTestId('top-up-status')).toHaveText('결제 완료');
    await expect(balance).toHaveText(String(SEED_BALANCE + 100));
    return '안내 "100크레딧을 충전했어요." · 결제 완료 · 잔액 200';
  });

  await h.step('top-up-redelivery', '같은 버튼을 다시 누르면(같은 이벤트 id = 재배달) 재배달 안내가 뜨고 잔액은 그대로다', async () => {
    const simulated = page.waitForResponse((r) => r.url().endsWith('/simulate'));
    await row().getByRole('button', { name: '결제 성공(테스트)' }).click();
    const body = await (await simulated).json();
    assert(body.replayed === true && body.outcome === 'applied', `simulate 응답 ${JSON.stringify(body)}`);
    await expect(result).toHaveText('같은 이벤트가 다시 왔어요. 처리 결과는 처음과 같고 잔액은 그대로예요.');
    await expect(balance).toHaveText(String(SEED_BALANCE + 100));
    return 'simulate {outcome: applied, replayed: true} · 재배달 안내 · 잔액 200';
  });

  await h.step('top-up-late-failure', '"결제 실패(테스트)"(완료 뒤 늦게 온 실패)는 상태를 바꾸지 않는다', async () => {
    const simulated = page.waitForResponse((r) => r.url().endsWith('/simulate'));
    await row().getByRole('button', { name: '결제 실패(테스트)' }).click();
    const body = await (await simulated).json();
    assert(body.outcome === 'stale' && body.replayed === false, `simulate 응답 ${JSON.stringify(body)}`);
    await expect(result).toHaveText('이미 처리된 주문이라 상태가 바뀌지 않았어요.');
    await expect(row().getByTestId('top-up-status')).toHaveText('결제 완료');
    await expect(balance).toHaveText(String(SEED_BALANCE + 100));
    return 'simulate {outcome: stale} · 결제 완료 유지 · 잔액 200';
  });

  await h.step('top-up-request-replay', '같은 Idempotency-Key로 충전 요청을 다시 보내면 같은 201·본문 + Idempotent-Replayed, 다른 상품이면 422', async () => {
    const key = randomUUID();
    const post = (packageId) =>
      page.request.post('/api/console/top-ups', {
        headers: { origin: SERVER_ORIGIN, 'idempotency-key': key },
        data: { packageId },
      });
    const first = await post('credits_500');
    const again = await post('credits_500');
    const other = await post('credits_100');
    await h.evidence.saveApiResponse('top-up-request-first.txt', first);
    await h.evidence.saveApiResponse('top-up-request-replay.txt', again);
    await h.evidence.saveApiResponse('top-up-request-other-package.txt', other);
    const [a, b] = [await first.json(), await again.json()];
    assert(first.status() === 201 && again.status() === 201, `상태 ${first.status()} / ${again.status()}`);
    assert(JSON.stringify(a) === JSON.stringify(b), '재요청 본문이 첫 응답과 다르다');
    assert(first.headers()['idempotent-replayed'] === undefined, '첫 응답에 Idempotent-Replayed가 있다');
    assert(again.headers()['idempotent-replayed'] === 'true', `재요청 헤더 ${again.headers()['idempotent-replayed']}`);
    assert(other.status() === 422 && (await other.json()).error === 'idempotency_key_reused', `다른 상품 ${other.status()}`);
    return `201 주문 ${a.id} → 재요청 201 같은 본문 + Idempotent-Replayed: true → 다른 상품 422 idempotency_key_reused`;
  });

  await h.step('top-up-webhook', '제공자 쪽으로 서명한 웹훅을 HTTP로 보낸다: 재배달은 같은 outcome + 헤더, 다른 이벤트 id는 stale, 변조·다른 비밀·만료는 401', async () => {
    const send = (w) => h.api.post(WEBHOOK_PATH, { headers: w.headers, data: w.body });
    const base = { orderId: order.id, amount: order.amount, result: 'paid' };
    const replay = await send(signedWebhook({ ...base, eventId: `evt_${order.id}_paid` }));
    const otherEvent = await send(signedWebhook({ ...base, eventId: `evt_verify_${randomUUID()}` }));
    const signed = signedWebhook({ ...base, eventId: `evt_verify_${randomUUID()}` });
    const tampered = await send({ ...signed, body: signed.body.replace(`"amount":${order.amount}`, `"amount":${order.amount + 1}`) });
    const wrongSecret = await send(signedWebhook({ ...base, eventId: `evt_verify_${randomUUID()}`, secret: 'not-the-secret-0123456' }));
    const expired = await send(signedWebhook({ ...base, eventId: `evt_verify_${randomUUID()}`, t: Math.floor(Date.now() / 1000) - 301 }));
    for (const [name, res] of Object.entries({ replay, otherEvent, tampered, wrongSecret, expired })) {
      await h.evidence.saveApiResponse(`webhook-${name}.txt`, res);
    }
    assert(replay.status() === 200 && (await replay.json()).outcome === 'applied', `재배달 ${replay.status()}`);
    assert(replay.headers()['idempotent-replayed'] === 'true', `재배달 헤더 ${replay.headers()['idempotent-replayed']}`);
    assert(otherEvent.status() === 200 && (await otherEvent.json()).outcome === 'stale', `다른 이벤트 id ${otherEvent.status()}`);
    for (const [name, res] of Object.entries({ tampered, wrongSecret, expired })) {
      assert(res.status() === 401 && (await res.json()).error === 'invalid_signature', `${name} ${res.status()}`);
    }
    return '재배달 200 applied + Idempotent-Replayed · 다른 이벤트 id 200 stale · 변조·다른 비밀·만료 모두 401 invalid_signature';
  });

  await h.step('top-up-ledger', '원장을 다시 읽으면 충전은 topup:<주문 id> 한 줄이고 잔액은 200이다', async () => {
    const ledger = await credits();
    await h.evidence.saveJson('console-credits.json', ledger);
    const topups = ledger.items.filter((e) => e.idempotencyKey === `topup:${order.id}`);
    assert(ledger.balance === SEED_BALANCE + 100, `잔액 ${ledger.balance}`);
    assert(topups.length === 1 && topups[0].delta === 100, `충전 항목 ${JSON.stringify(topups)}`);
    await page.reload();
    await expect(balance).toHaveText(String(SEED_BALANCE + 100));
    return `잔액 ${ledger.balance} · topup:${order.id} 한 줄(+100) · 원장 ${ledger.items.length}줄`;
  });
}
