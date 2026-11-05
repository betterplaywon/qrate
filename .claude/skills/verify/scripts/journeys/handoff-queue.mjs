// 상담원 연결 접수 — 두 입구: (a) 모델 신호([[handoff]] 목업 훅) 뒤의 "상담원 연결" 제안, (b) 머리글의 "상담원 연결" 버튼(질문 전).
// 접수는 POST /api/handoff(201)로 가고, 콘솔 미응답 큐에 방문자 항목으로 들어간다 — API와 콘솔 화면 양쪽에서 확인한다.
// 기대값은 packages/widget/e2e/widget.spec.ts의 두 핸드오프 테스트와 같다.
import { HANDOFF_URL, CHAT_URL, SERVER_ORIGIN, assert } from '../lib.mjs';
import { finishedAnswers, loginApi, loginConsole, openWidget, send } from '../harness.mjs';

export const title = '상담원 연결 접수 — 모델 신호 제안 / 머리글 버튼 → 연락처 폼 → POST /api/handoff 201 → 콘솔 미응답 큐';

const SIGNAL_QUESTION = '[[handoff]] 카카오톡으로 청구서 알림을 보낼 수 있나요?';
const VISITOR = { contact: 'visitor@example.com', message: '전화 주세요' };
const EARLY = { contact: 'early@example.com' };

const postedHandoff = (page) => page.waitForResponse((r) => r.url() === HANDOFF_URL && r.request().method() === 'POST');

export async function run(h) {
  const { expect } = h;

  const pageA = await h.newPage({ name: 'demo-signal' });
  const frameA = await openWidget(h, pageA);
  await h.step('handoff-offer', `"${SIGNAL_QUESTION}"에 모델이 자료에 없다고 신호하면, 안내 답변(출처 없음) 뒤에 "상담원 연결" 제안이 붙는다`, async () => {
    await send(frameA, SIGNAL_QUESTION);
    await expect(finishedAnswers(frameA)).toHaveCount(1);
    const answer = frameA.locator('.msg.bot').first();
    await expect(answer.locator('.text')).toContainText('안내 자료에 없어요');
    await expect(answer.locator('.sources')).toHaveCount(0);
    const offer = frameA.locator('.msg.notice').last();
    await expect(offer).toContainText('상담원에게 연결해 드릴까요?');
    await expect(offer.locator('.notice-action')).toHaveText('상담원 연결');
    return '안내 답변(출처 0건) + "상담원에게 연결해 드릴까요?" 제안 버튼';
  });

  await h.step('handoff-submit', '제안 버튼 → 연락처 폼에 이메일·메모를 적어 보내면 POST /api/handoff가 201이고 "접수됐어요" 안내가 남는다', async () => {
    await frameA.locator('.msg.notice').last().locator('.notice-action').click();
    const form = frameA.locator('.handoff-form');
    await expect(form).toBeVisible();
    await form.locator('#qrate-contact').fill(VISITOR.contact);
    await form.locator('#qrate-handoff-message').fill(VISITOR.message);
    const [created] = await Promise.all([postedHandoff(pageA), form.locator('button[type="submit"]').click()]);
    assert(created.status() === 201, `POST /api/handoff ${created.status()}`);
    const body = await created.json();
    const chatConversationId = h.chat.responses[0]?.conversationId;
    assert(body.conversationId === chatConversationId, `접수가 다른 대화에 붙었다: ${body.conversationId} ≠ ${chatConversationId}`);
    await expect(frameA.locator('.msg.notice').last()).toContainText('접수됐어요');
    await expect(form).toHaveCount(0);
    return `201 id=${body.id} conversationId=${body.conversationId} · "접수됐어요" 안내, 폼 제거`;
  });

  const pageB = await h.newPage({ name: 'demo-header' });
  const frameB = await openWidget(h, pageB);
  let earlyConversationId = null;
  await h.step('handoff-header', '머리글 "상담원 연결"은 질문 전에도 열린다. 취소하면 폼이 사라지고, 다시 열어 이메일만 보내도 201로 접수된다', async () => {
    await frameB.locator('.handoff').click();
    const form = frameB.locator('.handoff-form');
    await expect(form).toBeVisible();
    await form.locator('.cancel').click();
    await expect(form).toHaveCount(0);
    await frameB.locator('.handoff').click();
    await frameB.locator('#qrate-contact').fill(EARLY.contact);
    const [created] = await Promise.all([postedHandoff(pageB), frameB.locator('.handoff-form button[type="submit"]').click()]);
    assert(created.status() === 201, `POST /api/handoff ${created.status()}`);
    earlyConversationId = (await created.json()).conversationId;
    await expect(frameB.locator('.msg.notice').last()).toContainText('접수됐어요');
    return `취소 → 폼 제거 · 재요청 201 conversationId=${earlyConversationId}(서버가 새로 만든 대화)`;
  });

  await h.step('handoff-then-chat', '접수 뒤의 질문은 서버가 만든 그 대화 id로 간다', async () => {
    const [req] = await Promise.all([
      pageB.waitForRequest((r) => r.url() === CHAT_URL && r.method() === 'POST'),
      send(frameB, '환불되나요?'),
    ]);
    const sent = req.postDataJSON().conversationId;
    assert(sent === earlyConversationId, `질문의 conversationId=${sent} ≠ 접수의 ${earlyConversationId}`);
    await expect(finishedAnswers(frameB)).toHaveCount(1);
    return `POST /api/chat conversationId=${sent} · 답변 완료`;
  });

  await h.step('handoff-queued', '콘솔 API의 미응답 큐(open)에 방문자 요청 2건과 모델 신호 1건이 들어 있다(부수 효과)', async () => {
    await loginApi(h);
    const res = await h.api.get('/api/console/handoffs?status=open');
    await h.evidence.saveApiResponse('console-handoffs-open.txt', res);
    assert(res.status() === 200, `GET /api/console/handoffs ${res.status()}`);
    const { items } = await res.json();
    const visitor = items.find((x) => x.source === 'visitor' && x.contact === VISITOR.contact);
    assert(visitor, `큐에 ${VISITOR.contact} 항목이 없다 (${items.length}건)`);
    assert(visitor.summary === VISITOR.message && visitor.preview.includes('카카오톡'), `방문자 항목: summary=${visitor.summary} preview=${visitor.preview}`);
    assert(visitor.conversationId === h.chat.responses[0]?.conversationId, '방문자 항목이 신호가 난 대화에 붙어 있지 않다');
    const early = items.find((x) => x.source === 'visitor' && x.contact === EARLY.contact);
    assert(early && early.conversationId === earlyConversationId && early.preview.includes('환불되나요?'), `머리글 접수 항목: ${JSON.stringify(early)}`);
    const model = items.find((x) => x.source === 'model');
    assert(model && model.reason === 'not_in_knowledge' && model.conversationId === visitor.conversationId, `모델 신호 항목: ${JSON.stringify(model)}`);
    assert(items.length === 3, `큐 항목 ${items.length}건 (3 기대)`);
    return `open 큐 3건: visitor(${VISITOR.contact}, "${VISITOR.message}") · visitor(${EARLY.contact}) · model(not_in_knowledge)`;
  });

  const consolePage = await h.newPage({ name: 'console', ignoreConsole: /status of 401/ }); // 로그인 전 /me의 401은 정상
  await h.step('handoff-console-ui', '운영 콘솔의 미응답 큐 화면에 그 3건이 연락처와 함께 보인다', async () => {
    await consolePage.goto(`${SERVER_ORIGIN}/console/`);
    await loginConsole(h, consolePage);
    await expect(consolePage.getByTestId('tenant-name')).toHaveText(h.tenantName);
    await consolePage.goto(`${SERVER_ORIGIN}/console/#/queue/open`);
    const queued = consolePage.getByTestId('queue-item');
    await expect(queued).toHaveCount(3);
    const list = consolePage.getByTestId('queue-list');
    await expect(list).toContainText('방문자 요청');
    await expect(list).toContainText(VISITOR.contact);
    await expect(list).toContainText(EARLY.contact);
    await expect(list).toContainText('모델 신호');
    return `큐 화면 3건(방문자 요청 ×2, 모델 신호 ×1), 연락처 표시`;
  });

  await h.step('handoff-no-errors', '정상 흐름에서 브라우저 콘솔 오류가 없다', async () => {
    for (const [name, p] of [['demo-signal', pageA], ['demo-header', pageB], ['console', consolePage]]) {
      const errors = h.errorsOf(p);
      assert(errors.length === 0, `${name} 콘솔 오류: ${errors.join(' | ')}`);
    }
    return '세 페이지 모두 0건';
  });
}
