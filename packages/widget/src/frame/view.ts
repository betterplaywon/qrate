import { MAX_MESSAGE_CHARS } from '@qrate/contracts';
import type { SourceCitation } from './stream';

// 대화창 화면. 상태는 모르고, main.ts가 시키는 대로 그린다.
//
// 규칙: 서버·모델에서 온 문자열(답변, 인용 원문, 출처 제목)은 전부 textContent로 넣는다. innerHTML은 쓰지 않는다.
// 이 문서의 CSP가 인라인 스크립트를 막지만(apps/server/src/frame.ts), 그 방어에 기대지 않고 처음부터 HTML로 해석하지 않는다.
// 같은 CSP가 style="" 속성도 막으므로 모양은 frame.css의 클래스로만 바꾼다.

export interface ViewHandlers {
  onSubmit(message: string): void;
  onClose(): void;
  onHandoff(): void;
}

export interface NoticeAction {
  label: string;
  /** 이 시간 동안 버튼을 누를 수 없다. 서버가 준 Retry-After를 그대로 쓴다. */
  disabledForMs: number | null;
  run(): void;
}

export interface AnswerView {
  append(text: string): void;
  addCitation(citation: SourceCitation): void;
  /** 끝난 답변을 닫는다. interrupted면 부분 답변으로 표시한다. */
  finish(state: 'complete' | 'interrupted'): void;
}

export interface ChatView {
  setBusy(busy: boolean): void;
  addUser(text: string): void;
  startAnswer(): AnswerView;
  addNotice(text: string, action?: NoticeAction): void;
  focusInput(): void;
}

/** 사용자가 위로 스크롤해 읽는 중이면 새 조각이 와도 끌어내리지 않는다. 이 거리 안이면 바닥에 있는 것으로 본다. */
const STICK_TO_BOTTOM_PX = 40;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function createView(root: HTMLElement, handlers: ViewHandlers): ChatView {
  const app = el('div', 'app');

  const head = el('header', 'head');
  const title = el('h1', 'title', '무엇을 도와드릴까요?');
  const actions = el('div', 'head-actions');
  // 요구사항(README 타깃): 사람에게 연결하는 버튼은 항상 보여야 한다. 실제 연결은 W3.
  const handoff = el('button', 'handoff', '상담원 연결');
  handoff.type = 'button';
  const close = el('button', 'close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', '상담 창 닫기');
  actions.append(handoff, close);
  head.append(title, actions);

  const msgs = el('div', 'msgs');
  msgs.setAttribute('role', 'log');
  msgs.setAttribute('aria-live', 'polite');

  const form = el('form', 'composer');
  const label = el('label', 'sr-only', '메시지');
  label.htmlFor = 'qrate-input';
  const input = el('input');
  input.id = 'qrate-input';
  input.autocomplete = 'off';
  input.maxLength = MAX_MESSAGE_CHARS; // 서버의 message_too_long(400)과 같은 값 — 넘는 입력은 보내기 전에 막는다
  input.placeholder = '메시지를 입력하세요';
  const send = el('button', 'send', '전송');
  send.type = 'submit';
  form.append(label, input, send);

  app.append(head, msgs, form);
  root.append(app);

  handoff.addEventListener('click', () => handlers.onHandoff());
  close.addEventListener('click', () => handlers.onClose());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message || send.disabled) return;
    input.value = '';
    handlers.onSubmit(message);
  });

  const nearBottom = (): boolean => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight <= STICK_TO_BOTTOM_PX;
  const append = (node: HTMLElement): void => {
    const stick = nearBottom();
    msgs.appendChild(node);
    if (stick) msgs.scrollTop = msgs.scrollHeight;
  };
  /** 이미 붙어 있는 노드의 내용이 자랄 때. 바닥에 있던 사용자만 따라 내려간다. */
  const grow = (change: () => void): void => {
    const stick = nearBottom();
    change();
    if (stick) msgs.scrollTop = msgs.scrollHeight;
  };

  return {
    setBusy(busy) {
      send.disabled = busy;
    },

    addUser(text) {
      append(el('p', 'msg user', text));
    },

    startAnswer() {
      const bubble = el('div', 'msg bot');
      bubble.setAttribute('aria-busy', 'true');
      const body = el('p', 'text');
      bubble.append(body);
      append(bubble);

      let sources: { details: HTMLDetailsElement; summary: HTMLElement; list: HTMLOListElement } | null = null;
      const bySource = new Map<string, { quotes: HTMLUListElement; seen: Set<string> }>();

      return {
        append(text) {
          grow(() => {
            body.textContent = (body.textContent ?? '') + text;
          });
        },

        addCitation(c) {
          grow(() => {
            if (!sources) {
              const details = el('details', 'sources');
              const summary = el('summary');
              const list = el('ol', 'source-list');
              details.append(summary, list);
              bubble.append(details);
              sources = { details, summary, list };
            }
            let group = bySource.get(c.sourceId);
            if (!group) {
              const item = el('li', 'source');
              item.append(el('span', 'source-title', c.title));
              const quotes = el('ul', 'quotes');
              item.append(quotes);
              sources.list.append(item);
              group = { quotes, seen: new Set() };
              bySource.set(c.sourceId, group);
            }
            // API는 같은 원문을 여러 번 인용할 수 있다. 화면에는 한 번만.
            if (!group.seen.has(c.citedText)) {
              group.seen.add(c.citedText);
              const quote = el('li', 'quote');
              quote.append(el('q', undefined, c.citedText));
              group.quotes.append(quote);
            }
            sources.summary.textContent = `출처 ${bySource.size}건`;
          });
        },

        finish(state) {
          bubble.removeAttribute('aria-busy');
          if (state === 'interrupted') bubble.classList.add('partial');
          // 조각이 하나도 오지 않고 끝났으면 빈 말풍선을 남기지 않는다.
          if (!body.textContent && !sources) bubble.remove();
        },
      };
    },

    addNotice(text, action) {
      const notice = el('div', 'msg notice');
      notice.append(el('span', undefined, text));
      if (action) {
        const button = el('button', 'notice-action', action.label);
        button.type = 'button';
        if (action.disabledForMs) {
          button.disabled = true;
          setTimeout(() => {
            button.disabled = false;
          }, action.disabledForMs);
        }
        button.addEventListener('click', () => {
          button.remove();
          action.run();
        });
        notice.append(button);
      }
      append(notice);
    },

    focusInput() {
      input.focus();
    },
  };
}
