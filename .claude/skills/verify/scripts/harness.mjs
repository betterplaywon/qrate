/* global console, window, location, URL, performance */
// 드라이브 하네스 — 브라우저·요청 컨텍스트·증거 기록·단계(step) 기록. drive.mjs가 만들고 journeys/*.mjs가 받아 쓴다.
// 선택자는 런처(packages/widget/src/loader.ts)·대화창(src/frame/view.ts)의 클래스·id, 콘솔은 data-testid(apps/console/src/views)다.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CHAT_URL,
  CONSOLE_KEY,
  DEMO_ORIGIN,
  NOT_ALLOWED_DEMO_ORIGIN,
  SERVER_ORIGIN,
  TENANT,
  TENANT_NAME,
  assert,
  playwright,
  relative,
} from './lib.mjs';

export const HOST = '#qrate-host';
export const LAUNCHER = `${HOST} .launcher`;
export const FRAME = `${HOST} iframe.frame`;
export const LOADING = `${HOST} .loading`;

const KEPT_HEADERS = [
  'content-type',
  'content-security-policy',
  'cache-control',
  'x-conversation-id',
  'retry-after',
  'set-cookie',
  'idempotent-replayed',
];

function pick(headers, names) {
  return Object.fromEntries(names.filter((n) => n in headers).map((n) => [n, headers[n]]));
}

function headerLines(headers) {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

export class Evidence {
  constructor(dir) {
    this.dir = dir;
    this.files = [];
    mkdirSync(dir, { recursive: true });
  }

  save(name, content) {
    writeFileSync(path.join(this.dir, name), content);
    if (!this.files.includes(name)) this.files.push(name);
    return name;
  }

  saveJson(name, value) {
    return this.save(name, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Playwright APIResponse를 상태줄·헤더·본문 그대로. */
  async saveApiResponse(name, res) {
    return this.save(name, `${res.status()} ${res.url()}\n${headerLines(res.headers())}\n\n${await res.text()}`);
  }

  append(name, text) {
    appendFileSync(path.join(this.dir, name), text);
  }
}

export class StepFailure extends Error {
  constructor(step) {
    super(`step ${step.n} ${step.id}: ${step.error}`);
    this.step = step;
  }
}

export async function createHarness({ evidenceDir, feature, title, headed = false }) {
  const pw = playwright();
  // 목업은 글자당 20ms로 흘려보내 답 하나에 몇 초 걸린다 — 위젯 E2E(playwright.config.ts)와 같은 expect 시간.
  // configure는 전역을 바꾸지 않고 새 expect를 돌려준다.
  const expect = pw.expect.configure({ timeout: 10_000 });
  const evidence = new Evidence(evidenceDir);
  const browser = await pw.chromium.launch({ headless: !headed });
  // baseURL은 page.request(브라우저 쿠키를 싣는 요청)에서 상대 경로를 쓰기 위한 것. 페이지 이동은 전부 절대 주소다.
  const context = await browser.newContext({ baseURL: SERVER_ORIGIN, viewport: { width: 1280, height: 800 }, locale: 'ko-KR' });
  await context.tracing.start({ screenshots: true, snapshots: true });
  // 대화 API(SSE)·접수 API의 응답 본문은 페이지 안에서 복제본을 읽어 남긴다. 위젯이 스트림을 다 읽고 취소하면 CDP가 본문을
  // 내주지 않기 때문이다(response.text()는 실패하거나 끝나지 않는다). 원본 응답은 그대로 위젯이 읽으므로 사용자 경로는 바뀌지 않는다.
  await context.addInitScript(() => {
    const original = window.fetch;
    window.__verifyQrate = [];
    window.fetch = async function tee(input, init) {
      const res = await original.call(this, input, init);
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/chat' || url.pathname === '/api/handoff') {
        const entry = { t: performance.timeOrigin + performance.now(), url: url.href, status: res.status, headers: Object.fromEntries(res.headers), body: null, done: false };
        window.__verifyQrate.push(entry);
        res
          .clone()
          .text()
          .then(
            (text) => {
              entry.body = text;
              entry.done = true;
            },
            (err) => {
              entry.error = String(err);
              entry.done = true;
            },
          );
      }
      return res;
    };
  });
  const api = await pw.request.newContext({ baseURL: SERVER_ORIGIN });

  const network = [];
  const consoleLog = [];
  const errorsByPage = new Map();
  const steps = [];
  let pageCount = 0;
  const ts = () => new Date().toISOString().slice(11, 23);

  evidence.save(
    'steps.md',
    `# verify — ${feature}\n\n${title}\n\n- 증거 폴더: ${relative(evidenceDir)}/\n- 시작: ${new Date().toISOString()}\n- 브라우저: Chromium ${browser.version()} (headless=${!headed})\n`,
  );

  const h = {
    pw,
    expect,
    browser,
    context,
    api,
    evidence,
    steps,
    /** 모든 페이지의 대화 API 왕복. requests[i].body.conversationId ↔ responses[i].conversationId(X-Conversation-Id). 본문은 finish가 파일로 남긴다. */
    chat: { requests: [], responses: [] },
    /** 단계가 끝날 때 스크린샷을 찍는 페이지. newPage가 바꾸고, 여정이 직접 바꿀 수도 있다. */
    current: null,
    origins: { server: SERVER_ORIGIN, demo: DEMO_ORIGIN, notAllowedDemo: NOT_ALLOWED_DEMO_ORIGIN },
    tenant: TENANT,
    tenantName: TENANT_NAME,
    consoleKey: CONSOLE_KEY,

    errorsOf(page) {
      return errorsByPage.get(page) ?? [];
    },

    /** 콘솔 오류·서버 트래픽을 기록하는 페이지. ignoreConsole에 맞는 콘솔 오류는 "정상"으로 보고 세지 않는다(예: 로그인 전 /me의 401). */
    async newPage({ name = `page${pageCount + 1}`, ignoreConsole = null } = {}) {
      pageCount += 1;
      const page = await context.newPage();
      const errors = [];
      errorsByPage.set(page, errors);
      page.on('console', (m) => {
        consoleLog.push(`${ts()} [${name}] ${m.type()}: ${m.text()}`);
        if (m.type() === 'error' && !(ignoreConsole && ignoreConsole.test(m.text()))) errors.push(m.text());
      });
      page.on('pageerror', (e) => {
        consoleLog.push(`${ts()} [${name}] pageerror: ${String(e)}`);
        errors.push(String(e));
      });
      page.on('request', (r) => {
        if (!r.url().startsWith(SERVER_ORIGIN)) return;
        const entry = { t: ts(), page: name, method: r.method(), url: r.url(), frame: r.frame().url() };
        if (r.method() === 'POST' && (r.url() === CHAT_URL || r.url() === `${SERVER_ORIGIN}/api/handoff`)) entry.body = r.postDataJSON();
        network.push(entry);
        if (r.method() === 'POST' && r.url() === CHAT_URL) h.chat.requests.push({ page: name, frameUrl: entry.frame, body: entry.body });
      });
      page.on('response', (r) => {
        if (!r.url().startsWith(SERVER_ORIGIN)) return;
        const headers = r.headers();
        network.push({ t: ts(), page: name, status: r.status(), url: r.url(), headers: pick(headers, KEPT_HEADERS) });
        if (r.request().method() === 'POST' && r.url() === CHAT_URL) {
          h.chat.responses.push({ page: name, status: r.status(), conversationId: headers['x-conversation-id'] ?? null });
        }
      });
      h.current = page;
      return page;
    },

    /** 사용자 행동 하나 = 단계 하나. 끝나면(성공·실패 모두) current 페이지의 스크린샷을 찍고 steps.md에 적는다. 실패하면 여정을 멈춘다. */
    async step(id, name, fn) {
      const n = steps.length + 1;
      const startedAt = Date.now();
      const rec = { n, id, name, ok: false, startedAt: new Date(startedAt).toISOString() };
      steps.push(rec);
      console.log(`step ${n} [${id}] ${name}`);
      try {
        const note = await fn();
        rec.ok = true;
        rec.note = typeof note === 'string' ? note : '';
      } catch (err) {
        rec.error = err?.message ?? String(err);
      }
      rec.ms = Date.now() - startedAt;
      const page = h.current && !h.current.isClosed() ? h.current : null;
      if (page) {
        const file = `${String(n).padStart(2, '0')}-${id}${rec.ok ? '' : '-FAILED'}.png`;
        try {
          await page.screenshot({ path: path.join(evidence.dir, file) });
          evidence.files.push(file);
          rec.screenshot = file;
        } catch (err) {
          rec.screenshotError = err.message;
        }
      }
      evidence.append(
        'steps.md',
        `\n## ${n}. ${name}\n\n- id: \`${id}\`\n- 결과: ${rec.ok ? 'OK' : 'FAIL'} (${rec.ms}ms)` +
          `${rec.note ? `\n- 관찰: ${rec.note}` : ''}${rec.error ? `\n- 오류: ${rec.error}` : ''}${rec.screenshot ? `\n- 스크린샷: ${rec.screenshot}` : ''}\n`,
      );
      console.log(`  ${rec.ok ? 'OK' : 'FAIL'} (${rec.ms}ms)${rec.note ? ` — ${rec.note}` : ''}${rec.error ? ` — ${rec.error}` : ''}`);
      if (!rec.ok) throw new StepFailure(rec);
      return rec;
    },

    /** 페이지 안에서 복제해 둔 대화·접수 API 본문을 chat-N.sse.txt / handoff-N.json.txt 로 남긴다. */
    async saveApiBodies() {
      const captured = [];
      for (const p of context.pages()) {
        for (const f of p.frames()) {
          try {
            const list = await f.evaluate(() => window.__verifyQrate ?? []);
            captured.push(...list);
          } catch {
            // 그려지지 않은 프레임(CSP 거부)이나 떠난 프레임 — 남길 본문이 없다
          }
        }
      }
      captured.sort((a, b) => a.t - b.t);
      let chatN = 0;
      let handoffN = 0;
      for (const e of captured) {
        const isChat = e.url.endsWith('/api/chat');
        const file = isChat ? `chat-${(chatN += 1)}.sse.txt` : `handoff-${(handoffN += 1)}.json.txt`;
        evidence.save(file, `${e.status} ${e.url}\n${headerLines(e.headers)}\n\n${e.body ?? `(본문 없음: ${e.error ?? '읽기 미완료'})`}`);
      }
      return captured.length;
    },

    /** 트레이스·네트워크·브라우저 콘솔을 쓰고 브라우저를 닫는다. 여정이 실패해도 부른다. */
    async finish() {
      try {
        await h.saveApiBodies();
      } catch (err) {
        console.error(`API 본문 저장 실패: ${err.message}`);
      }
      try {
        await context.tracing.stop({ path: path.join(evidence.dir, 'trace.zip') });
        evidence.files.push('trace.zip');
      } catch (err) {
        console.error(`trace 저장 실패: ${err.message}`);
      }
      evidence.save('network.jsonl', `${network.map((e) => JSON.stringify(e)).join('\n')}\n`);
      evidence.save('browser-console.log', `${consoleLog.join('\n')}\n`);
      await api.dispose().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
  return h;
}

/** 데모 페이지를 열고 런처를 눌러 대화창이 준비(ready postMessage → 로딩 문구 제거)될 때까지 기다린다. */
export async function openWidget(h, page, origin = DEMO_ORIGIN) {
  await page.goto(`${origin}/demo.html`);
  await page.locator(LAUNCHER).click();
  await h.expect(page.locator(LOADING)).toHaveCount(0);
  return page.frameLocator(FRAME);
}

export async function send(frame, message) {
  await frame.locator('#qrate-input').fill(message);
  await frame.locator('.send').click();
}

/** 스트리밍이 끝난 답변 말풍선. */
export function finishedAnswers(frame) {
  return frame.locator('.msg.bot:not([aria-busy])');
}

/** 콘솔 로그인 폼(apps/console/src/views/Login.tsx). 세션은 HttpOnly 쿠키라 page.request가 같은 쿠키를 싣는다. */
export async function loginConsole(h, page, key = CONSOLE_KEY) {
  await page.locator('#tenant').fill(TENANT);
  await page.locator('#key').fill(key);
  await page.getByRole('button', { name: '로그인' }).click();
}

/** 브라우저와 별개의 요청 컨텍스트(h.api)로 콘솔 API에 로그인한다 — 부수 효과를 저장소 쪽에서 다시 읽을 때. */
export async function loginApi(h) {
  const res = await h.api.post('/api/console/login', { headers: { origin: SERVER_ORIGIN }, data: { tenant: TENANT, key: CONSOLE_KEY } });
  assert(res.status() === 200, `콘솔 API 로그인 실패: ${res.status()} ${await res.text()}`);
  return res;
}
