// 운영 콘솔 — 운영자 경로: /console/ 문서(CSP) → 로그인(틀린 키·맞는 키) → 빈 큐·빈 로그 → 위젯에서 대화가 생기면 로그·상세·큐에
// 보임 → 큐 상태를 "처리 중"으로 옮김 → 로그아웃. 기대값은 apps/console/e2e/console.spec.ts와 같다(대화는 API 대신 실제 위젯으로 만든다).
import { SERVER_ORIGIN, assert } from '../lib.mjs';
import { finishedAnswers, loginConsole, openWidget, send } from '../harness.mjs';

export const title = '운영 콘솔 — 로그인 → 대화 로그·상세 → 미응답 큐 상태 변경 → 로그아웃';

const CONSOLE_CSP = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const PLAIN_QUESTION = '요금제가 어떻게 되나요?';
const SIGNAL_QUESTION = '[[handoff]] 카카오톡으로 알림 받을 수 있나요?';

export async function run(h) {
  const { expect } = h;

  await h.step('console-document', '/console/ 문서는 CSP와 함께 내려오고, 로그인 전 콘솔 API는 401이다', async () => {
    const doc = await h.api.get('/console/');
    await h.evidence.saveApiResponse('console-document.txt', doc);
    assert(doc.status() === 200, `GET /console/ ${doc.status()}`);
    assert(doc.headers()['content-security-policy'] === CONSOLE_CSP, `CSP: ${doc.headers()['content-security-policy']}`);
    assert(doc.headers()['cache-control'] === 'no-cache', `cache-control: ${doc.headers()['cache-control']}`);
    const me = await h.api.get('/api/console/me');
    assert(me.status() === 401, `로그인 전 GET /api/console/me ${me.status()}`);
    return `200 + CSP "${CONSOLE_CSP}" · /api/console/me 401`;
  });

  const page = await h.newPage({ name: 'console', ignoreConsole: /status of 401/ }); // 로그인 전 /me와 틀린 키의 401은 이 흐름에서 정상
  await h.step('console-login-wrong', '틀린 콘솔 키는 "맞지 않아요" 안내를 보인다', async () => {
    await page.goto(`${SERVER_ORIGIN}/console/`);
    await loginConsole(h, page, 'wrong-key');
    await expect(page.getByRole('alert')).toContainText('맞지 않아요');
    return '로그인 폼 유지 + 경고 "테넌트 키 또는 콘솔 키가 맞지 않아요."';
  });

  await h.step('console-login', '맞는 키로 로그인하면 테넌트 이름이 보이고, 큐와 대화 로그는 비어 있다. 브라우저의 세션 쿠키로 /me가 200이다', async () => {
    await loginConsole(h, page);
    await expect(page.getByTestId('tenant-name')).toHaveText(h.tenantName);
    await expect(page.getByTestId('queue-empty')).toBeVisible();
    await page.goto(`${SERVER_ORIGIN}/console/#/conversations`);
    await expect(page.getByTestId('conversations-empty')).toBeVisible();
    const me = await page.request.get('/api/console/me');
    assert(me.status() === 200, `로그인 뒤 GET /api/console/me ${me.status()}`);
    return `테넌트 "${h.tenantName}" · 큐 비어 있음 · 대화 로그 비어 있음 · /me 200`;
  });

  // 대화 두 건을 실제 위젯에서 만든다. 대화창 하나는 대화 하나를 이어 가므로, 새 대화마다 데모 페이지를 새로 연다.
  for (const [name, question] of [
    ['demo-plain', PLAIN_QUESTION],
    ['demo-signal', SIGNAL_QUESTION],
  ]) {
    const demo = await h.newPage({ name });
    await h.step(`console-seed-${name}`, `위젯에서 "${question}"를 보내 대화를 만든다`, async () => {
      const frame = await openWidget(h, demo);
      await send(frame, question);
      await expect(finishedAnswers(frame)).toHaveCount(1);
      return `답변 완료 (conversationId=${h.chat.responses.at(-1)?.conversationId})`;
    });
  }

  h.current = page;
  await h.step('console-conversations', '대화 로그를 새로 고치면 2건이 최근순으로 보이고, 신호가 난 대화를 열면 메시지 2건과 "모델 신호" 요청이 있다', async () => {
    await page.reload();
    const items = page.getByTestId('conversation-item');
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText('카카오톡으로 알림');
    await expect(items.first()).toContainText('연결 요청 1');
    await items.first().click();
    await expect(page.getByTestId('messages').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('detail-handoffs')).toContainText('모델 신호');
    return '대화 로그 2건 · 상세: 메시지 2건, 연결 요청(모델 신호) 1건';
  });

  await h.step('console-queue-move', '미응답 큐(열림)의 1건을 "처리 중"으로 옮기면 열림 탭에서 빠지고 처리 중 탭에 보인다. API로 다시 읽어도 in_progress다', async () => {
    await page.goto(`${SERVER_ORIGIN}/console/#/queue/open`);
    const queued = page.getByTestId('queue-item');
    await expect(queued).toHaveCount(1);
    await expect(queued.first()).toContainText('카카오톡으로 알림');
    await queued.first().getByTestId('move-in_progress').click();
    await expect(page.getByTestId('queue-empty')).toBeVisible();
    await page.getByTestId('tab-in_progress').click();
    await expect(page.getByTestId('queue-item')).toHaveCount(1);
    await expect(page.getByTestId('status')).toHaveText('처리 중');
    const res = await page.request.get('/api/console/handoffs?status=in_progress');
    await h.evidence.saveApiResponse('console-handoffs-in_progress.txt', res);
    const { items } = await res.json();
    assert(items.length === 1 && items[0].status === 'in_progress' && items[0].source === 'model', `in_progress 큐: ${JSON.stringify(items)}`);
    return `열림 → 처리 중 1건 · API status=in_progress source=model`;
  });

  await h.step('console-logout', '로그아웃하면 로그인 폼으로 돌아가고 세션 쿠키로도 /me가 401이다', async () => {
    await page.getByRole('button', { name: '로그아웃' }).click();
    await expect(page.getByRole('button', { name: '로그인' })).toBeVisible();
    const me = await page.request.get('/api/console/me');
    assert(me.status() === 401, `로그아웃 뒤 GET /api/console/me ${me.status()}`);
    return '로그인 폼 표시 · /me 401';
  });

  await h.step('console-no-errors', '401 한 줄 외에 브라우저 콘솔 오류가 없다', async () => {
    const errors = h.errorsOf(page);
    assert(errors.length === 0, `콘솔 오류: ${errors.join(' | ')}`);
    return '0건(로그인 전·틀린 키의 401 리소스 오류는 제외)';
  });
}
