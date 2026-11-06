import type { WidgetEventBody } from '@qrate/contracts';
import { describe, expect, it } from 'vitest';
import { PageLoadEvents } from '../src/frame/page-events';

function pageLoad() {
  const sent: WidgetEventBody[] = [];
  return { sent, events: new PageLoadEvents('demo', (body) => sent.push(body)) };
}

describe('PageLoadEvents — 한 페이지 로드의 위젯 사건', () => {
  it('열림·첫 질문은 각각 페이지 로드당 한 번 — 다시 열거나 다시 물어도 더 보내지 않는다', () => {
    const { sent, events } = pageLoad();
    events.open();
    events.question();
    events.open();
    events.question();
    expect(sent.map((b) => b.type)).toEqual(['widget_open', 'first_question']);
  });

  it('인사말을 붙였으면 두 사건 모두 그 변형을 싣는다', () => {
    const { sent, events } = pageLoad();
    expect(events.claimGreeting('exp.b')).toBe(true);
    events.open();
    events.question();
    expect(sent).toEqual([
      { tenant: 'demo', type: 'widget_open', variant: 'exp.b' },
      { tenant: 'demo', type: 'first_question', variant: 'exp.b' },
    ]);
  });

  it('인사말이 없었으면(요청 실패·시간 초과·실험 없음) 변형 키를 뺀다', () => {
    const { sent, events } = pageLoad();
    events.open();
    events.question();
    expect(sent).toEqual([
      { tenant: 'demo', type: 'widget_open' },
      { tenant: 'demo', type: 'first_question' },
    ]);
  });

  it('첫 질문이 인사말보다 먼저 나갔으면 인사말을 붙이지 않는다 — 그 페이지 로드는 실험 밖이다', () => {
    const { sent, events } = pageLoad();
    events.question();
    expect(events.claimGreeting('exp.b')).toBe(false);
    events.open();
    expect(sent).toEqual([
      { tenant: 'demo', type: 'first_question' },
      { tenant: 'demo', type: 'widget_open' },
    ]);
  });

  it('열림이 이미 나갔으면 인사말을 붙이지 않는다 — 변형 없는 열림 뒤에 변형 있는 첫 질문이 나가지 않게', () => {
    const { sent, events } = pageLoad();
    events.open();
    expect(events.claimGreeting('exp.b')).toBe(false);
    events.question();
    expect(sent.every((b) => !('variant' in b))).toBe(true);
  });
});
