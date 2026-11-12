import type { ChatEvent } from './stream';
import type { AnswerView, ChatView } from './view';

// 한 턴(질문 하나 → 답 하나)의 화면 반영. 대화 API 스트림의 사건(ChatEvent)을 받아 말풍선·안내를 그린다.
//
// 턴은 화면(ChatView)만 알고 앱 상태는 모른다. 대화 id·안 읽은 수·다음 행동(재시도·연결 요청·기다리기)은 TurnEffects로 앱(main.ts)에 넘긴다 —
// 그래서 브라우저 없이 가짜 ChatView로 단위 테스트할 수 있다(test/turn.test.ts).
// 사건 종류마다 핸들러가 하나씩 있고, Handlers 타입이 전부 있는지를 컴파일 때 확인한다 — stream.ts에 사건이 늘면 여기가 컴파일 오류로 알린다.
// (모르는 사건을 조용히 넘기는 것은 parseChatEvent의 몫이다. 여기 오는 사건은 전부 아는 것이어야 한다.)

/** 턴이 앱에 미치는 효과. */
export interface TurnEffects {
  /** 서버가 대화 id를 알려 줬다(응답 헤더). 다음 질문에 싣는다. */
  conversationStarted(id: string): void;
  /** 답이 정상으로 끝났다 — 닫혀 있으면 안 읽은 수를 센다. */
  answered(): void;
  /** 모델이 상담원 연결을 권했고 방문자가 버튼을 눌렀다. */
  offerHandoff(): void;
  /** 재시도 가능한 실패에서 방문자가 "다시 보내기"를 눌렀다. */
  retry(): void;
  /** 서버가 Retry-After로 기다리라고 했다. 그동안 새 메시지도 "다시 보내기"도 보내지 못하게 한다. */
  waitBeforeSending(ms: number): void;
}

type Failure = Extract<ChatEvent, { type: 'failed' }>;

type Handlers = { [K in ChatEvent['type']]: (ev: Extract<ChatEvent, { type: K }>) => void };

/** 실패 단계와 재시도 가능 여부 → 안내 문구. 방문자가 고칠 수 없는 상태(크레딧 소진)는 운영자에게 알리라고 따로 말한다. */
export function failureText(ev: Failure): string {
  if (ev.code === 'insufficient_credits') return '지금은 상담을 이용할 수 없어요. 사이트 운영자에게 알려 주세요.';
  if (ev.code === 'too_many_requests') return '요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.';
  if (ev.stage === 'connect') return '서버에 연결할 수 없어요.';
  if (ev.stage === 'response') return ev.retryable ? '지금은 답변할 수 없어요.' : `오류가 발생했어요. (${ev.status ?? '?'})`;
  return ev.retryable ? '답변이 중단됐어요.' : '답변 중 오류가 발생했어요.';
}

export class Turn {
  private answer: AnswerView | null = null;

  private readonly handlers: Handlers = {
    conversation: (ev) => this.effects.conversationStarted(ev.id),
    moderation: () => this.view.addNotice('안내: 메시지가 검토 대상으로 표시되었어요.'),
    delta: (ev) => this.bubble().append(ev.text),
    citation: (ev) => this.bubble().addCitation(ev.citation),
    // 모델이 자료에 없는 질문이라고 신호했다. 안내 문장은 답으로 이미 흘러왔으니, 여기서는 사람 연결로 이어 주는 길만 보인다.
    handoff: () =>
      this.view.addNotice('상담원에게 연결해 드릴까요?', {
        label: '상담원 연결',
        sends: false,
        run: () => this.effects.offerHandoff(),
      }),
    end: (ev) => {
      this.answer?.finish('complete');
      if (ev.stopReason === 'refusal') this.view.addNotice('이 질문에는 답변을 드릴 수 없어요. 상담원에게 문의해 주세요.');
      if (ev.stopReason === 'max_tokens') this.view.addNotice('답변이 길어 잘렸어요.');
      this.effects.answered();
    },
    blocked: () => this.view.addNotice('해당 메시지는 전송할 수 없어요. 표현을 바꿔 다시 시도해 주세요.'),
    failed: (ev) => {
      this.answer?.finish('interrupted');
      if (ev.retryAfterMs) this.effects.waitBeforeSending(ev.retryAfterMs);
      const retry = ev.retryable ? { label: '다시 보내기', sends: true, run: () => this.effects.retry() } : undefined;
      this.view.addNotice(failureText(ev), retry);
    },
  };

  constructor(
    private readonly view: ChatView,
    private readonly effects: TurnEffects,
  ) {}

  /** 사건 하나를 화면에 반영한다. */
  apply(ev: ChatEvent): void {
    // 핸들러는 자기 종류의 사건만 받도록 선언돼 있고(Handlers), ev.type으로 고른 핸들러에 같은 ev를 넘기므로 안전하다.
    // TypeScript는 이 "같은 분기"를 추적하지 못해 한 번 넓힌다.
    (this.handlers[ev.type] as (event: ChatEvent) => void)(ev);
  }

  /** 답 말풍선은 첫 조각(또는 첫 인용)이 올 때 만든다 — 조각이 하나도 없는 턴은 빈 말풍선을 남기지 않는다. */
  private bubble(): AnswerView {
    this.answer ??= this.view.startAnswer();
    return this.answer;
  }
}
