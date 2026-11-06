import { describe, expect, it } from 'vitest';
import { Turn, failureText, type TurnEffects } from '../src/frame/turn';
import type { AnswerView, ChatView, NoticeAction } from '../src/frame/view';

// 스트림 사건 → 화면 호출의 대응을 브라우저 없이 고정한다. ChatView는 호출을 기록하는 가짜다.

type Call = string;

function fakeView(): { view: ChatView; calls: Call[]; notices: { text: string; action?: NoticeAction }[] } {
  const calls: Call[] = [];
  const notices: { text: string; action?: NoticeAction }[] = [];
  let bubbles = 0;
  const view: ChatView = {
    setComposer: (state) => void calls.push(`composer:${state}`),
    addUser: (text) => void calls.push(`user:${text}`),
    showGreeting: (text) => void calls.push(`greeting:${text}`),
    startAnswer: (): AnswerView => {
      const n = ++bubbles;
      calls.push(`start:${n}`);
      return {
        append: (text) => void calls.push(`append:${n}:${text}`),
        addCitation: (c) => void calls.push(`cite:${n}:${c.sourceId}`),
        finish: (state) => void calls.push(`finish:${n}:${state}`),
      };
    },
    addNotice: (text, action) => {
      notices.push(action ? { text, action } : { text });
      calls.push(`notice:${text}`);
    },
    showHandoffForm: () => void calls.push('form'),
    focusInput: () => void calls.push('focus'),
  };
  return { view, calls, notices };
}

function fakeEffects(): { effects: TurnEffects; fired: string[] } {
  const fired: string[] = [];
  return {
    fired,
    effects: {
      conversationStarted: (id) => void fired.push(`conversation:${id}`),
      answered: () => void fired.push('answered'),
      offerHandoff: () => void fired.push('offerHandoff'),
      retry: () => void fired.push('retry'),
      waitBeforeSending: (ms) => void fired.push(`wait:${ms}`),
    },
  };
}

describe('Turn — 사건을 화면에 반영한다', () => {
  it('조각과 인용은 말풍선 하나에 모이고, 끝나면 완료로 닫히며 answered가 난다. 대화 id는 앱으로 넘긴다', () => {
    const { view, calls } = fakeView();
    const { effects, fired } = fakeEffects();
    const turn = new Turn(view, effects);
    turn.apply({ type: 'conversation', id: 'c1' });
    turn.apply({ type: 'delta', text: '7일 ' });
    turn.apply({ type: 'citation', citation: { sourceId: 'faq:refund', title: '환불', citedText: '7일 이내' } });
    turn.apply({ type: 'delta', text: '이내' });
    turn.apply({ type: 'end', stopReason: 'end_turn' });
    expect(calls).toEqual(['start:1', 'append:1:7일 ', 'cite:1:faq:refund', 'append:1:이내', 'finish:1:complete']);
    expect(fired).toEqual(['conversation:c1', 'answered']);
  });

  it('거절·길이 초과로 끝나면 안내를 덧붙인다. 조각이 없던 턴은 말풍선을 만들지 않는다', () => {
    const { view, calls } = fakeView();
    const turn = new Turn(view, fakeEffects().effects);
    turn.apply({ type: 'end', stopReason: 'refusal' });
    expect(calls).toEqual(['notice:이 질문에는 답변을 드릴 수 없어요. 상담원에게 문의해 주세요.']);

    const long = fakeView();
    const turn2 = new Turn(long.view, fakeEffects().effects);
    turn2.apply({ type: 'delta', text: '…' });
    turn2.apply({ type: 'end', stopReason: 'max_tokens' });
    expect(long.calls).toEqual(['start:1', 'append:1:…', 'finish:1:complete', 'notice:답변이 길어 잘렸어요.']);
  });

  it('모델의 연결 신호는 버튼 달린 안내가 되고, 버튼은 offerHandoff를 부른다', () => {
    const { view, notices } = fakeView();
    const { effects, fired } = fakeEffects();
    new Turn(view, effects).apply({ type: 'handoff', reason: 'not_in_knowledge', summary: null });
    expect(notices[0]?.text).toBe('상담원에게 연결해 드릴까요?');
    expect(notices[0]?.action?.label).toBe('상담원 연결');
    notices[0]?.action?.run();
    expect(fired).toEqual(['offerHandoff']);
  });

  it('실패: 부분 답은 중단으로 닫히고, 재시도 가능할 때만 "다시 보내기"(Retry-After 잠금)가 붙어 retry를 부른다', () => {
    const { view, calls, notices } = fakeView();
    const { effects, fired } = fakeEffects();
    const turn = new Turn(view, effects);
    turn.apply({ type: 'delta', text: '부분' });
    turn.apply({ type: 'failed', stage: 'stream', status: null, code: null, retryable: true, retryAfterMs: 2000 });
    expect(calls).toEqual(['start:1', 'append:1:부분', 'finish:1:interrupted', 'notice:답변이 중단됐어요.']);
    expect(notices[0]?.action).toMatchObject({ label: '다시 보내기', disabledForMs: 2000 });
    notices[0]?.action?.run();
    expect(fired).toEqual(['wait:2000', 'retry']);

    const fatal = fakeView();
    const fatalEffects = fakeEffects();
    new Turn(fatal.view, fatalEffects.effects).apply({ type: 'failed', stage: 'response', status: 502, code: 'upstream_error', retryable: false, retryAfterMs: null });
    expect(fatal.notices).toEqual([{ text: '오류가 발생했어요. (502)' }]);
    expect(fatalEffects.fired).toEqual([]);
  });

  it('Retry-After가 붙은 실패는 버튼과 같은 시간만큼 새 메시지도 기다리게 한다. Retry-After가 없으면 기다리지 않는다', () => {
    const limited = fakeEffects();
    new Turn(fakeView().view, limited.effects).apply({
      type: 'failed',
      stage: 'response',
      status: 429,
      code: 'too_many_requests',
      retryable: true,
      retryAfterMs: 37000,
    });
    expect(limited.fired).toEqual(['wait:37000']);

    const lost = fakeEffects();
    new Turn(fakeView().view, lost.effects).apply({ type: 'failed', stage: 'connect', status: null, code: null, retryable: true, retryAfterMs: null });
    expect(lost.fired).toEqual([]);
  });

  it('차단·경고 안내, 실패 문구 표', () => {
    const { view, calls } = fakeView();
    const turn = new Turn(view, fakeEffects().effects);
    turn.apply({ type: 'moderation' });
    turn.apply({ type: 'blocked' });
    expect(calls).toEqual(['notice:안내: 메시지가 검토 대상으로 표시되었어요.', 'notice:해당 메시지는 전송할 수 없어요. 표현을 바꿔 다시 시도해 주세요.']);
    expect(failureText({ type: 'failed', stage: 'connect', status: null, code: null, retryable: true, retryAfterMs: null })).toBe('서버에 연결할 수 없어요.');
    expect(failureText({ type: 'failed', stage: 'response', status: 503, code: 'rate_limited', retryable: true, retryAfterMs: 2000 })).toBe('지금은 답변할 수 없어요.');
    expect(failureText({ type: 'failed', stage: 'response', status: 429, code: 'too_many_requests', retryable: true, retryAfterMs: 37000 })).toBe(
      '요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.',
    );
    expect(failureText({ type: 'failed', stage: 'stream', status: null, code: 'upstream_error', retryable: false, retryAfterMs: null })).toBe('답변 중 오류가 발생했어요.');
  });

  it('크레딧 소진(402 insufficient_credits)은 방문자가 고칠 수 없는 상태라 운영자에게 알리라고 안내하고 버튼이 없다', () => {
    const { view, notices } = fakeView();
    new Turn(view, fakeEffects().effects).apply({
      type: 'failed',
      stage: 'response',
      status: 402,
      code: 'insufficient_credits',
      retryable: false,
      retryAfterMs: null,
    });
    expect(notices).toEqual([{ text: '지금은 상담을 이용할 수 없어요. 사이트 운영자에게 알려 주세요.' }]);
  });
});
