// 대화창 앱 — 서버 오리진의 iframe 문서(GET /frame?t=테넌트&o=부모 오리진)에서 돈다.
//
// 역할: 화면(view.ts)과 대화 API 스트림(stream.ts)을 잇고, 런처와 postMessage(../protocol.ts)로 열림·닫힘·안 읽은 수를 주고받는다.
// 열림을 아는 곳이 여기뿐이라(런처는 서버를 부르지 않는다) 첫 열림을 위젯 사건으로 서버에 알린다(events.ts).
// 서버와 같은 오리진이라 상대 경로로 API를 부르고, 호스트 사이트의 스크립트는 이 문서에 손댈 수 없다(ADR-0003 하이브리드).
//
// 설정은 URL 쿼리에서 읽는다. 서버가 t(테넌트)와 o(부모 오리진 — 테넌트의 허용 목록에 있는지)를 검사한 뒤에야 이 문서를 내려주므로,
// 여기서는 값이 있는지만 본다. 문서에 데이터를 심지 않는 이유: 심으려면 이스케이프가 필요하고 CSP가 인라인 스크립트를 막는다.
//
// 재시도 정책(ADR-0002 질문 4): 자동 재시도는 없다. 서버가 retryable이라고 한 실패만 "다시 보내기" 버튼을 보이고,
// Retry-After 동안 버튼을 잠근다. 같은 메시지를 다시 보내도 결과가 같은 실패(차단, 재시도 불가)에는 버튼이 없다.
// 같은 Retry-After 동안 입력창도 잠근다(composer.ts). 버튼과 입력창은 같은 때 풀린다.
//
// 앱 상태(열림·안 읽은 수·대화 id)는 FrameApp 하나가 들고, 입력창 상태(진행 중·잠금)는 그 안의 Composer가 든다.
// 한 턴의 화면 반영(사건 → 말풍선·안내)은 turn.ts의 Turn이 맡고, 앱에 미치는 효과(대화 id, 안 읽은 수, 재시도, 연결 요청, 기다리기)만
// 콜백으로 돌려받는다.

import { MAX_UNREAD, parseLauncherMessage, toWire, type FrameMessage } from '../protocol';
import { Composer } from './composer';
import { sendWidgetEvent } from './events';
import { requestHandoff as postHandoffRequest, type HandoffResult } from './handoff';
import { streamChat } from './stream';
import { Turn } from './turn';
import { createView, type ChatView } from './view';
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

/** 접수 실패 → 안내 문구. 연락처 문제만 따로 알리고 나머지는 "나중에 다시". */
function handoffFailureText(result: Extract<HandoffResult, { ok: false }>): string {
  if (result.code === 'invalid_contact') return '이메일 주소를 확인해 주세요.';
  if (result.status === 429) return '요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.';
  return '지금은 접수할 수 없어요. 잠시 뒤 다시 시도해 주세요.';
}

class FrameApp {
  private readonly view: ChatView;
  private readonly composer: Composer;
  private visible = false;
  /** widget_open은 페이지 로드당 첫 열림에 한 번. 다시 열기는 세지 않는다. */
  private openReported = false;
  private unread = 0;
  private conversationId: string | null = null;

  constructor(
    private readonly config: FrameConfig,
    root: HTMLElement,
  ) {
    this.view = createView(root, {
      onSubmit: (message) => void this.ask(message),
      onClose: () => this.send({ type: 'close' }),
      onHandoff: () => this.requestHandoff(),
    });
    this.composer = new Composer({
      render: (state) => this.view.setComposer(state),
      unlocked: () => {
        if (this.visible) this.view.focusInput();
      },
    });

    // 런처가 보낸 메시지만 받는다: 보낸 문서의 오리진, 보낸 창, 메시지 형식을 모두 확인한다(../protocol.ts).
    window.addEventListener('message', (event: MessageEvent<unknown>) => this.onLauncherMessage(event));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.send({ type: 'close' });
    });

    // 런처는 이 메시지를 받은 뒤에야 열림 상태를 보낸다(그 전에는 받을 리스너가 없다).
    this.send({ type: 'ready' });
  }

  private send(msg: FrameMessage): void {
    window.parent.postMessage(toWire(msg), this.config.parentOrigin);
  }

  private onLauncherMessage(event: MessageEvent<unknown>): void {
    if (event.origin !== this.config.parentOrigin || event.source !== window.parent) return;
    const msg = parseLauncherMessage(event.data);
    if (!msg) return;
    this.visible = msg.open;
    if (this.visible) {
      this.unread = 0;
      this.view.focusInput();
      if (!this.openReported) {
        this.openReported = true;
        void sendWidgetEvent({ tenant: this.config.tenant, type: 'widget_open' });
      }
    }
  }

  /** 패널이 닫힌 동안 끝난 답변을 세어 런처 배지에 알린다. 열리면 런처와 여기서 함께 0이 된다. */
  private noteAnswered(): void {
    if (this.visible) return;
    this.unread = Math.min(this.unread + 1, MAX_UNREAD);
    this.send({ type: 'unread', count: this.unread });
  }

  // 요구사항(README 타깃): 사람에게 연결하는 버튼은 항상 보인다. 누르면 연락처(이메일)와 남길 말을 받아 서버에 접수한다(POST /api/handoff).
  // 접수는 콘솔의 미응답 큐에 들어가고 운영자가 이메일로 답한다(콘솔 결정 2026-11-04, 핸드오프 A). 모델의 핸드오프 신호(event: handoff)가
  // 붙이는 연결 제안 버튼도 같은 길로 간다. 질문 전에 눌러도 되고, 그때 서버가 만든 대화 id를 이어받아 다음 질문이 같은 대화로 간다.
  private requestHandoff(): void {
    this.view.showHandoffForm({
      submit: async (contact, message) => {
        const result = await postHandoffRequest({ tenant: this.config.tenant, conversationId: this.conversationId, contact, message });
        if (!result.ok) return { ok: false, text: handoffFailureText(result) };
        this.conversationId = result.conversationId;
        return { ok: true, text: '접수됐어요. 적어 주신 이메일로 답을 드릴게요.' };
      },
    });
  }

  private async ask(message: string, opts: { retry?: boolean } = {}): Promise<void> {
    if (this.composer.isBusy()) return;
    if (!opts.retry) this.view.addUser(message);
    this.composer.setBusy(true);

    // 턴은 화면만 그리고, 앱 상태를 바꾸는 일은 여기 콜백으로 돌아온다.
    const turn = new Turn(this.view, {
      conversationStarted: (id) => {
        this.conversationId = id;
      },
      answered: () => this.noteAnswered(),
      offerHandoff: () => this.requestHandoff(),
      retry: () => void this.ask(message, { retry: true }),
      waitBeforeSending: (ms) => this.composer.lockFor(ms),
    });
    try {
      for await (const ev of streamChat({ message, tenant: this.config.tenant, conversationId: this.conversationId })) turn.apply(ev);
    } finally {
      this.composer.setBusy(false);
      if (this.visible) this.view.focusInput();
    }
  }
}

function start(config: FrameConfig): void {
  const root = document.getElementById('app');
  if (root) new FrameApp(config, root);
}

const CONFIG = readConfig();
if (CONFIG) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => start(CONFIG));
  } else {
    start(CONFIG);
  }
}
