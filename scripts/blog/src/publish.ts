// 티스토리 발행 스크립트 (브라우저 자동화).
//
// 배경: 티스토리 오픈 API는 2024-02 종료되어, 프로그램 발행은 실제 브라우저를
// 자동화하는 방법뿐이다. Playwright로 로그인 세션을 .auth/에 보존해 재사용한다.
//
// 사용:
//   1회 준비: pnpm --filter @sw/blog-tools exec playwright install chromium
//   임시저장: pnpm blog:publish docs/blog/drafts/2026-11-xx.md
//   공개발행: pnpm blog:publish docs/blog/drafts/2026-11-xx.md --go
//
// 원칙:
//   - 항상 headful(브라우저 창 표시)로 실행한다. 내 계정으로 뭘 하는지 눈으로 확인한다.
//   - 캡차·보안 확인이 뜨면 우회하지 않는다. 사람이 처리하거나 중단한다.
//   - 기본은 "임시저장"이고, --go를 줬을 때만 공개 발행한다.
//   - 티스토리 에디터 DOM이 바뀌면 아래 SEL 상수를 조정한다(스크립트가 깨지는 유일한 지점).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { marked } from 'marked';
import { chromium } from 'playwright';

const BLOG = process.env.TISTORY_BLOG ?? 'betterpalywon';
const AUTH_DIR = path.resolve(import.meta.dirname, '../.auth');

// ── 티스토리 에디터 셀렉터 (2026-10 기준 신 에디터) ──────────────────────────
// DOM 변경으로 실패하면: headful 창에서 요소를 우클릭 → 검사로 확인 후 여기만 수정.
const SEL = {
  titleInput: '#post-title-inp',
  modeButton: '#editor-mode-layer-btn-open',
  modeHtml: '#editor-mode-html',
  modeHtmlText: 'HTML',
  codeMirror: '.CodeMirror',
  completeButton: '#publish-layer-btn',
  publicRadioLabel: 'label[for="open20"]',
  publishButton: '#publish-btn',
  saveDraftButton: '.btn-save, #save-btn', // 임시저장 (버전에 따라 상이)
};
// ───────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [fileArg, ...flags] = process.argv.slice(2);
  if (!fileArg) {
    console.error('사용법: pnpm blog:publish <초안.md 경로> [--go]');
    process.exit(1);
  }
  const go = flags.includes('--go');

  const raw = readFileSync(path.resolve(fileArg), 'utf8');
  const { data, content } = matter(raw);
  const title = typeof data.title === 'string' && data.title ? data.title : path.basename(fileArg);
  const html = await marked.parse(content);

  // persistent context: 쿠키·세션이 .auth/에 저장되어 다음 실행부터 로그인 생략.
  const context = await chromium.launchPersistentContext(AUTH_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // "작성 중인 글이 있습니다. 이어서 작성하시겠습니까?" 등의 confirm은 취소(새 글 기준).
  page.on('dialog', (d) => {
    void d.dismiss().catch(() => d.accept());
  });

  const newPostUrl = `https://${BLOG}.tistory.com/manage/newpost/`;
  await page.goto(newPostUrl, { waitUntil: 'domcontentloaded' });

  // 로그인 세션이 없으면 로그인 페이지로 리다이렉트된다 → 사람이 직접 로그인.
  if (!page.url().includes('/manage/newpost')) {
    console.log('▶ 로그인이 필요합니다. 열린 브라우저에서 카카오 로그인을 완료하세요. (최대 5분 대기)');
    await page.waitForURL('**/manage/newpost/**', { timeout: 5 * 60 * 1000 });
  }

  await page.fill(SEL.titleInput, title);

  // HTML 모드로 전환 (마크다운 → HTML 변환 결과를 그대로 넣기 위해)
  await page.click(SEL.modeButton);
  const htmlMenu = page.locator(SEL.modeHtml);
  if (await htmlMenu.count()) {
    await htmlMenu.click();
  } else {
    await page.getByText(SEL.modeHtmlText, { exact: true }).first().click();
  }

  // CodeMirror 인스턴스에 직접 값 주입 (타이핑 시뮬레이션보다 안정적)
  await page.waitForSelector(SEL.codeMirror);
  await page.evaluate(
    ({ selector, value }) => {
      const node = document.querySelector(selector) as
        | (Element & { CodeMirror?: { setValue: (v: string) => void } })
        | null;
      node?.CodeMirror?.setValue(value);
    },
    { selector: SEL.codeMirror, value: html },
  );

  if (go) {
    await page.click(SEL.completeButton);
    const publicRadio = page.locator(SEL.publicRadioLabel);
    if (await publicRadio.count()) await publicRadio.click();
    await page.click(SEL.publishButton);
    await page.waitForURL(`https://${BLOG}.tistory.com/**`, { timeout: 30_000 });
    console.log(`✔ 공개 발행 완료: ${page.url()}`);
  } else {
    const save = page.locator(SEL.saveDraftButton).first();
    if (await save.count()) {
      await save.click();
      console.log('✔ 임시저장 완료. 공개하려면 --go 플래그로 다시 실행하거나 에디터에서 발행.');
    } else {
      console.log('△ 임시저장 버튼을 찾지 못했습니다. 열린 창에서 직접 저장하세요. (SEL.saveDraftButton 조정 필요)');
    }
    console.log('  브라우저 창은 확인을 위해 10초 뒤 닫힙니다.');
    await page.waitForTimeout(10_000);
  }

  await context.close();
}

main().catch((err) => {
  console.error('발행 실패:', err instanceof Error ? err.message : err);
  console.error('셀렉터 변경이 원인이면 publish.ts 상단 SEL 상수를 조정하세요.');
  process.exit(1);
});
