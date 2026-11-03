import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../src/engine/types.js';
import { sseForEngineEvent } from '../src/http/sse.js';

// 전송 형식 자체(이벤트 이름·JSON 모양·[DONE])는 @qrate/contracts의 테스트가 고정한다.
// 여기서는 엔진 이벤트 → 전송 이벤트 변환, 특히 "무엇을 위젯에 보내지 않는가"를 본다.

const zeroUsage = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };

describe('엔진 이벤트 직렬화 — 위젯 파서와의 계약', () => {
  it('delta는 event 필드 없이 data만 (기본 이벤트 message)', () => {
    expect(sseForEngineEvent({ type: 'delta', text: '안' })).toBe('data: {"delta":"안"}\n\n');
  });

  it('citation은 event: citation + 인용 전체', () => {
    const citation = {
      sourceIndex: 0,
      sourceId: 'faq:refund',
      title: '환불 정책',
      citedText: '결제 후 7일 이내 전액 환불됩니다.',
      blockStart: 0,
      blockEnd: 1,
    };
    const out = sseForEngineEvent({ type: 'citation', citation });
    expect(out.startsWith('event: citation\ndata: ')).toBe(true);
    expect(JSON.parse(out.slice('event: citation\ndata: '.length))).toEqual(citation);
  });

  it('done은 stopReason만 담고 토큰 사용량·모델은 위젯에 보내지 않는다', () => {
    const done: EngineEvent = {
      type: 'done',
      stopReason: 'end_turn',
      refusalCategory: null,
      model: 'claude-sonnet-5-5',
      servedBy: 'claude-sonnet-5-5',
      fallbackUsed: false,
      usage: zeroUsage,
    };
    expect(sseForEngineEvent(done)).toBe('event: done\ndata: {"stopReason":"end_turn"}\n\n');
  });

  it('정책 거절이면 카테고리를 함께 보낸다', () => {
    const done: EngineEvent = {
      type: 'done',
      stopReason: 'refusal',
      refusalCategory: 'general_harms',
      model: 'm',
      servedBy: 'm',
      fallbackUsed: false,
      usage: zeroUsage,
    };
    expect(sseForEngineEvent(done)).toBe(
      'event: done\ndata: {"stopReason":"refusal","refusalCategory":"general_harms"}\n\n',
    );
  });
});
