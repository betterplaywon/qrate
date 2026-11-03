import { describe, expect, it } from 'vitest';
import {
  drainSSEBuffer,
  encodeChatEvent,
  parseApiErrorBody,
  parseChatEvent,
  type ChatStreamEvent,
} from '../src/index.js';

const citation = {
  sourceIndex: 0,
  sourceId: 'faq:refund',
  title: '환불 정책',
  citedText: '결제 후 7일 이내 전액 환불됩니다.',
  blockStart: 0,
  blockEnd: 1,
};

describe('대화 스트림 이벤트 — encode ↔ parse 왕복', () => {
  const cases: ChatStreamEvent[] = [
    { type: 'delta', text: '안' },
    { type: 'moderation', reasons: ['warn:ignore\\s+(?:all\\s+)?(?:pre'] },
    { type: 'citation', citation },
    { type: 'done', stopReason: 'end_turn', refusalCategory: null },
    { type: 'done', stopReason: 'refusal', refusalCategory: 'general_harms' },
    { type: 'error', code: 'rate_limited', retryable: true },
    { type: 'end' },
  ];

  it.each(cases)('$type', (ev) => {
    const { events, rest } = drainSSEBuffer(encodeChatEvent(ev));
    expect(rest).toBe('');
    expect(events).toHaveLength(1);
    expect(parseChatEvent(events[0] ?? { event: '', data: '' })).toEqual(ev);
  });

  it('전송 형식 고정 — 서버·위젯 양쪽이 기대하는 글자 그대로', () => {
    expect(encodeChatEvent({ type: 'delta', text: '안' })).toBe('data: {"delta":"안"}\n\n');
    expect(encodeChatEvent({ type: 'moderation', reasons: ['r'] })).toBe(
      'event: moderation\ndata: {"level":"warn","reasons":["r"]}\n\n',
    );
    expect(encodeChatEvent({ type: 'done', stopReason: 'end_turn', refusalCategory: null })).toBe(
      'event: done\ndata: {"stopReason":"end_turn"}\n\n',
    );
    expect(encodeChatEvent({ type: 'error', code: 'rate_limited', retryable: true })).toBe(
      'event: error\ndata: {"code":"rate_limited","retryable":true}\n\n',
    );
    expect(encodeChatEvent({ type: 'end' })).toBe('data: [DONE]\n\n');
  });
});

describe('parseChatEvent — 수신 쪽은 너그럽게 읽는다', () => {
  it('모르는 이벤트·형식이 다른 데이터는 null(건너뛴다)', () => {
    expect(parseChatEvent({ event: 'handoff', data: '{}' })).toBeNull();
    expect(parseChatEvent({ event: 'message', data: 'not json' })).toBeNull();
    expect(parseChatEvent({ event: 'message', data: '{"delta":1}' })).toBeNull();
    expect(parseChatEvent({ event: 'citation', data: '{"sourceId":"x"}' })).toBeNull();
    expect(parseChatEvent({ event: 'error', data: '{"code":"x"}' })).toBeNull();
    expect(parseChatEvent({ event: 'done', data: '[1]' })).toBeNull();
  });

  it('모르는 stopReason은 other — 서버가 종료 사유를 늘려도 이전 위젯이 깨지지 않게', () => {
    expect(parseChatEvent({ event: 'done', data: '{"stopReason":"pause_turn"}' })).toEqual({
      type: 'done',
      stopReason: 'other',
      refusalCategory: null,
    });
  });

  it('[DONE]은 message 이벤트일 때만 종료 센티널이다', () => {
    expect(parseChatEvent({ event: 'message', data: '[DONE]' })).toEqual({ type: 'end' });
    expect(parseChatEvent({ event: 'error', data: '[DONE]' })).toBeNull();
  });
});

describe('parseApiErrorBody — 첫 이벤트 전 실패 본문', () => {
  it('error 문자열이 있어야 하고, retryable·reasons는 형식이 맞을 때만 읽는다', () => {
    expect(parseApiErrorBody({ error: 'rate_limited', retryable: true })).toEqual({ error: 'rate_limited', retryable: true });
    expect(parseApiErrorBody({ error: 'blocked_by_moderation', reasons: ['block:x'] })).toEqual({
      error: 'blocked_by_moderation',
      reasons: ['block:x'],
    });
    expect(parseApiErrorBody({ error: 'x', retryable: 'yes' })).toEqual({ error: 'x' });
    expect(parseApiErrorBody({ message: 'x' })).toBeNull();
    expect(parseApiErrorBody('oops')).toBeNull();
  });
});
