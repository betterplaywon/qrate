// 대화창 앱 — 서버 오리진의 iframe 문서(GET /frame?t=테넌트&o=부모 오리진)에서 돈다.
//
// 역할: 화면(view.ts)과 대화 API 스트림(stream.ts)을 잇고, 런처와 postMessage(../protocol.ts)로 열림·닫힘·안 읽은 수를 주고받는다.
// 서버와 같은 오리진이라 상대 경로로 API를 부르고, 호스트 사이트의 스크립트는 이 문서에 손댈 수 없다(ADR-0003 하이브리드).
//
// 설정은 URL 쿼리에서 읽는다. 서버가 t(테넌트)와 o(부모 오리진 — 테넌트의 허용 목록에 있는지)를 검사한 뒤에야 이 문서를 내려주므로,
// 여기서는 값이 있는지만 본다. 문서에 데이터를 심지 않는 이유: 심으려면 이스케이프가 필요하고 CSP가 인라인 스크립트를 막는다.
//
// 재시도 정책(ADR-0002 질문 4): 자동 재시도는 없다. 서버가 retryable이라고 한 실패만 "다시 보내기" 버튼을 보이고,
// Retry-After 동안 버튼을 잠근다. 같은 메시지를 다시 보내도 결과가 같은 실패(차단, 재시도 불가)에는 버튼이 없다.

import { MAX_UNREAD, parseLauncherMessage, toWire, type FrameMessage } from '../protocol';
import { streamChat, type ChatEvent } from './stream';
import { createView, type AnswerView } from './view';
import './frame.css';

interface FrameConfig {
  tenant: string;
  /** 런처가 있는 고객 사이트의 오리진. postMessage를 보내는 상대이자 받을 때 확인하는 기준이다. */
  parentOrigin: string;
}

function readConfig(): FrameConfig | null {
  const params = new URLSearchParams(location.search);
  const tenant = params.get('t')?.trim();
  const parentOrigin = params.get('o')?.trim();
  return tenant && parentOrigin ? { tenant, parentOrigin } : null;
}

function main(config: FrameConfig): void {
  const root = document.getElementById('app');
  if (!root) return;

  const send = (msg: FrameMessage): void => {
    window.parent.postMessage(toWire(msg), config.parentOrigin);
  };

  let visible = false;
  let unread = 0;
  let conversationId: string | null = null;
  let inFlight = false;

  const view = createView(root, {
    onSubmit: (message) => void ask(message),
    onClose: () => send({ type: 'close' }),
    // 요구사항(README 타깃): 사람에게 연결하는 버튼은 항상 보인다. 실제 연결은 W3.
    onHandoff: () => view.addNotice('상담원 연결은 준비 중이에요. 지금은 이 창에서 질문해 주세요.'),
  });

  // 런처가 보낸 메시지만 받는다: 보낸 문서의 오리진, 보낸 창, 메시지 형식을 모두 확인한다(../protocol.ts).
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.origin !== config.parentOrigin || event.source !== window.parent) return;
    const msg = parseLauncherMessage(event.data);
    if (!msg) return;
    visible = msg.open;
    if (visible) {
      unread = 0;
      view.focusInput();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') send({ type: 'close' });
  });

  /** 패널이 닫힌 동안 끝난 답변을 세어 런처 배지에 알린다. 열리면 런처와 여기서 함께 0이 된다. */
  const noteAnswered = (): void => {
    if (visible) return;
    unread = Math.min(unread + 1, MAX_UNREAD);
    send({ type: 'unread', count: unread });
  };

  const showFailure = (ev: Extract<ChatEvent, { type: 'failed' }>, message: string): void => {
    const text =
      ev.stage === 'connect'
        ? '서버에 연결할 수 없어요.'
        : ev.stage === 'response'
          ? ev.retryable
            ? '지금은 답변할 수 없어요.'
            : `오류가 발생했어요. (${ev.status ?? '?'})`
          : ev.retryable
            ? '답변이 중단됐어요.'
            : '답변 중 오류가 발생했어요.';
    view.addNotice(
      text,
      ev.retryable
        ? { label: '다시 보내기', disabledForMs: ev.retryAfterMs, run: () => void ask(message, { retry: true }) }
        : undefined,
    );
  };

  async function ask(message: string, opts: { retry?: boolean } = {}): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    if (!opts.retry) view.addUser(message);
    view.setBusy(true);

    let answer: AnswerView | null = null;
    try {
      for await (const ev of streamChat({ message, tenant: config.tenant, conversationId })) {
        switch (ev.type) {
          case 'conversation':
            conversationId = ev.id;
            break;
          case 'moderation':
            view.addNotice('안내: 메시지가 검토 대상으로 표시되었어요.');
            break;
          case 'delta':
            answer ??= view.startAnswer();
            answer.append(ev.text);
            break;
          case 'citation':
            answer ??= view.startAnswer();
            answer.addCitation(ev.citation);
            break;
          case 'end':
            answer?.finish('complete');
            if (ev.stopReason === 'refusal') {
              view.addNotice('이 질문에는 답변을 드릴 수 없어요. 상담원에게 문의해 주세요.');
            } else if (ev.stopReason === 'max_tokens') {
              view.addNotice('답변이 길어 잘렸어요.');
            }
            noteAnswered();
            break;
          case 'blocked':
            view.addNotice('해당 메시지는 전송할 수 없어요. 표현을 바꿔 다시 시도해 주세요.');
            break;
          case 'failed':
            answer?.finish('interrupted');
            showFailure(ev, message);
            break;
        }
      }
    } finally {
      inFlight = false;
      view.setBusy(false);
      if (visible) view.focusInput();
    }
  }

  // 런처는 이 메시지를 받은 뒤에야 열림 상태를 보낸다(그 전에는 받을 리스너가 없다).
  send({ type: 'ready' });
}

const CONFIG = readConfig();
if (CONFIG) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => main(CONFIG));
  } else {
    main(CONFIG);
  }
}
