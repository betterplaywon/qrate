/* global URL */
// 허용되지 않은 오리진 차단 — 서버는 시드 allowedOrigins 밖의 o에 403 안내 문서를 주고(스크립트 없음), 브라우저는 CSP frame-ancestors
// 위반으로 프레임을 그리지 않아 런처의 로딩 문구가 남는다. 대조군으로 허용 오리진(5173)에서는 열린다.
// 기대값은 packages/widget/e2e/widget.spec.ts의 마지막 테스트와 같다.
import { DEMO_ORIGIN, NOT_ALLOWED_DEMO_ORIGIN, SERVER_ORIGIN, assert, waitFor } from '../lib.mjs';
import { FRAME, LAUNCHER, LOADING, openWidget } from '../harness.mjs';

export const title = '허용되지 않은 오리진 차단 — /frame 403 안내 문서 + 브라우저 CSP frame-ancestors 거부, 허용 오리진 대조군';

export async function run(h) {
  const { expect } = h;

  await h.step('origin-server-403', '서버는 허용 목록 밖의 o(5174)나 o 없음에 403 안내 문서를 주고, CSP는 허용 목록 그대로 내린다. t 없음 400, 모르는 t 404', async () => {
    const denied = await h.api.get(`/frame?t=demo&o=${encodeURIComponent(NOT_ALLOWED_DEMO_ORIGIN)}`);
    await h.evidence.saveApiResponse('frame-denied.txt', denied);
    assert(denied.status() === 403, `/frame?o=5174 → ${denied.status()}`);
    const csp = denied.headers()['content-security-policy'] ?? '';
    assert(csp.includes(`frame-ancestors ${DEMO_ORIGIN}`), `CSP: "${csp}"`);
    const html = await denied.text();
    assert(html.includes('이 사이트에서는 상담 창을 열 수 없어요'), '안내 문구가 없다');
    assert(!html.includes('app.js'), '거부 문서에 대화창 스크립트가 실려 있다');
    assert((await h.api.get('/frame?t=demo')).status() === 403, '/frame?t=demo(o 없음)가 403이 아니다');
    const noTenant = await h.api.get('/frame');
    assert(noTenant.status() === 400 && (await noTenant.json()).error === 'tenant is required', `/frame → ${noTenant.status()}`);
    const unknown = await h.api.get(`/frame?t=nope&o=${encodeURIComponent(DEMO_ORIGIN)}`);
    assert(unknown.status() === 404 && (await unknown.json()).error === 'unknown_tenant', `/frame?t=nope → ${unknown.status()}`);
    return `o=5174 → 403 안내(스크립트 없음), CSP "${csp}" · o 없음 403 · t 없음 400 · t=nope 404`;
  });

  const page = await h.newPage({ name: 'not-allowed' }); // CSP 위반 콘솔 오류를 일부러 그대로 센다
  await h.step('origin-browser-blocked', '허용 목록 밖 포트(5174)의 데모에서 런처를 누르면 iframe은 o=5174로 /frame을 요청해 403을 받고, 브라우저가 CSP 위반으로 프레임을 거부해 로딩 문구가 남는다', async () => {
    const frameResponse = page.waitForResponse((r) => r.url().startsWith(`${SERVER_ORIGIN}/frame?`));
    await page.goto(`${NOT_ALLOWED_DEMO_ORIGIN}/demo.html`);
    await page.locator(LAUNCHER).click();
    const src = new URL((await page.locator(FRAME).getAttribute('src')) ?? '');
    assert(src.searchParams.get('o') === NOT_ALLOWED_DEMO_ORIGIN, `iframe의 o=${src.searchParams.get('o')}`);
    const res = await frameResponse;
    assert(res.status() === 403, `/frame 응답 ${res.status()}`);
    await waitFor(() => h.errorsOf(page).some((e) => e.includes('frame-ancestors')), { timeoutMs: 10_000, label: 'CSP frame-ancestors 콘솔 오류' });
    await expect(page.locator(LOADING)).toBeVisible();
    await expect(page.locator(LOADING)).toHaveText('상담 창을 불러오는 중…');
    const cspError = h.errorsOf(page).find((e) => e.includes('frame-ancestors'));
    return `iframe o=${NOT_ALLOWED_DEMO_ORIGIN} · /frame 403 · 콘솔 "${cspError.slice(0, 90)}…" · 로딩 문구 유지`;
  });

  const control = await h.newPage({ name: 'allowed' });
  await h.step('origin-browser-allowed', '대조군: 허용 오리진(5173)의 데모에서는 같은 동작으로 대화창이 열리고 로딩 문구가 사라진다', async () => {
    const frame = await openWidget(h, control);
    await expect(frame.locator('.title')).toHaveText('무엇을 도와드릴까요?');
    return '5173에서는 ready 수신, 대화창 머리글 표시';
  });

  await h.step('origin-errors-scoped', '차단된 페이지의 콘솔 오류는 CSP 위반·403 리소스 오류뿐이고, 허용 페이지에는 오류가 없다', async () => {
    const blocked = h.errorsOf(page);
    const unexpected = blocked.filter((e) => !/frame-ancestors|403/.test(e));
    assert(blocked.length > 0 && unexpected.length === 0, `예상 밖 오류: ${unexpected.join(' | ')}`);
    const allowed = h.errorsOf(control);
    assert(allowed.length === 0, `허용 페이지 콘솔 오류: ${allowed.join(' | ')}`);
    return `차단 페이지 오류 ${blocked.length}건(전부 CSP/403) · 허용 페이지 0건`;
  });
}
