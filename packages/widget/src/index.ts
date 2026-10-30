// 임베더블 AI 상담 위젯 — 설치 스니펫 한 줄로 동작한다:
//   <script src=".../widget.js" data-endpoint="https://api.example.com" data-tenant="KEY" defer></script>
//
// 핵심 설계 포인트 (ADR·면접 소재):
// 1) Shadow DOM — 호스트 사이트의 CSS가 위젯을 깨뜨리지 못하고, 위젯 CSS도 밖으로 새지 않는다.
// 2) IIFE 번들 — 호스트의 빌드 설정과 무관하게 로드된다. (vite.config.ts)
// 3) fetch + ReadableStream — POST 본문이 필요해 EventSource 대신 선택. (ADR-0002)

import { drainSSEBuffer } from './sse';

interface WidgetConfig {
  endpoint: string;
  tenant: string;
}

const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
  .launcher {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
    width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
    background: #1f6feb; color: #fff; font-size: 22px; box-shadow: 0 4px 16px rgba(0,0,0,.25);
  }
  .panel {
    position: fixed; right: 20px; bottom: 84px; z-index: 2147483000;
    width: 320px; max-width: calc(100vw - 40px); height: 420px;
    display: none; flex-direction: column; overflow: hidden;
    background: #fff; border: 1px solid #d0d7de; border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,.2);
  }
  .panel.open { display: flex; }
  .head { padding: 10px 14px; background: #1f6feb; color: #fff; font-size: 14px; font-weight: 600; }
  .msgs { flex: 1; overflow-y: auto; padding: 12px; font-size: 13px; line-height: 1.5; }
  .msg { margin: 0 0 8px; padding: 8px 10px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
  .msg.user { background: #1f6feb; color: #fff; margin-left: 48px; }
  .msg.bot { background: #f6f8fa; color: #1f2328; margin-right: 48px; }
  .msg.notice { background: #fff8c5; color: #4d2d00; font-size: 12px; }
  form { display: flex; gap: 6px; padding: 10px; border-top: 1px solid #d0d7de; }
  input { flex: 1; padding: 8px 10px; font-size: 13px; border: 1px solid #d0d7de; border-radius: 8px; }
  button[type=submit] { padding: 8px 12px; font-size: 13px; border: none; border-radius: 8px;
    background: #1f6feb; color: #fff; cursor: pointer; }
  button[type=submit]:disabled { opacity: .5; cursor: default; }
`;

function readConfig(): WidgetConfig {
  const script = document.currentScript as HTMLScriptElement | null;
  return {
    endpoint: (script?.dataset.endpoint ?? 'http://localhost:8787').replace(/\/$/, ''),
    tenant: script?.dataset.tenant ?? 'demo',
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function mount(config: WidgetConfig): void {
  const host = el('div');
  host.id = 'sw-widget-host';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = STYLE;

  const launcher = el('button', 'launcher', '💬');
  launcher.type = 'button';
  launcher.setAttribute('aria-label', '상담 열기');

  const panel = el('div', 'panel');
  const head = el('div', 'head', '무엇을 도와드릴까요?');
  const msgs = el('div', 'msgs');
  const form = el('form');
  const input = el('input');
  input.placeholder = '메시지를 입력하세요';
  const send = el('button', undefined, '전송');
  send.type = 'submit';

  form.append(input, send);
  panel.append(head, msgs, form);
  root.append(style, launcher, panel);
  document.body.appendChild(host);

  launcher.addEventListener('click', () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) input.focus();
  });

  const addMsg = (cls: 'user' | 'bot' | 'notice', text: string): HTMLElement => {
    const m = el('p', `msg ${cls}`, text);
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
    return m;
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message || send.disabled) return;
    input.value = '';
    addMsg('user', message);
    send.disabled = true;
    void streamAnswer(config, message, addMsg, msgs).finally(() => {
      send.disabled = false;
      input.focus();
    });
  });
}

async function streamAnswer(
  config: WidgetConfig,
  message: string,
  addMsg: (cls: 'user' | 'bot' | 'notice', text: string) => HTMLElement,
  msgs: HTMLElement,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${config.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, tenant: config.tenant }),
    });
  } catch {
    addMsg('notice', '서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.');
    return;
  }

  if (res.status === 422) {
    addMsg('notice', '해당 메시지는 전송할 수 없어요. 표현을 바꿔 다시 시도해 주세요.');
    return;
  }
  if (!res.ok || !res.body) {
    addMsg('notice', `오류가 발생했어요. (${res.status})`);
    return;
  }

  const bot = addMsg('bot', '');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const { events, rest } = drainSSEBuffer(buffer);
    buffer = rest;

    for (const ev of events) {
      if (ev.data === '[DONE]') return;
      if (ev.event === 'moderation') {
        addMsg('notice', '안내: 메시지가 검토 대상으로 표시되었어요.');
        continue;
      }
      try {
        const parsed = JSON.parse(ev.data) as { delta?: string };
        answer += parsed.delta ?? '';
        bot.textContent = answer;
        msgs.scrollTop = msgs.scrollHeight;
      } catch {
        // 형식이 다른 이벤트는 무시 — 서버와의 계약은 test/sse.test.ts로 고정한다.
      }
    }
  }
}

// 주의: document.currentScript는 "스크립트 평가 시점"에만 유효하다.
// DOMContentLoaded 콜백 안에서 읽으면 null → 설정은 지금 즉시 캡처한다. (실제로 잡기 쉬운 버그)
const CONFIG = readConfig();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mount(CONFIG));
} else {
  mount(CONFIG);
}
