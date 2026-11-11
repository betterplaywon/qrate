import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { ClaudeEngine } from '../src/engine/claude.js';
import { ToolMarkupFilter, handoffFromMarkup } from '../src/engine/tool-markup.js';
import type { EngineEvent } from '../src/engine/types.js';

function run(chunks: string[]): { shown: string; leaked: string | null } {
  const filter = new ToolMarkupFilter();
  const shown = chunks.map((chunk) => filter.push(chunk)).join('');
  const { rest, leaked } = filter.end();
  return { shown: shown + rest, leaked };
}

// W5 평가 h01 r1에서 Sonnet이 본문에 쓴 글의 꼴: 닫는 </invoke>가 없다.
const WRITTEN_CALL =
  '<invoke name="request_handoff">\n<parameter name="reason">needs_human</parameter>\n<parameter name="summary">지난달 결제 건 환불 요청</parameter>';

describe('ToolMarkupFilter — 본문에 쓴 도구 호출 거르기', () => {
  it('표지가 없으면 조각을 그대로 내보낸다', () => {
    expect(run(['환불은 ', '고객지원 이메일로 ', '요청합니다.'])).toEqual({ shown: '환불은 고객지원 이메일로 요청합니다.', leaked: null });
  });

  it('조각 끝의 "<"는 붙잡았다가 표지가 아니면 다음 조각과 함께 내보낸다', () => {
    const filter = new ToolMarkupFilter();
    expect(filter.push('금액이 <')).toBe('금액이 ');
    expect(filter.push(' 10만 원이면')).toBe('< 10만 원이면');
    expect(filter.end()).toEqual({ rest: '', leaked: null });
  });

  it('스트림이 표지의 앞부분으로 끝나면 끝에서 내보낸다', () => {
    expect(run(['화살표 <in'])).toEqual({ shown: '화살표 <in', leaked: null });
  });

  it('표지부터 끝까지는 내보내지 않는다 — 표지가 조각 경계에 걸쳐도', () => {
    const { shown, leaked } = run([
      '상담원이 확인해 드립니다.\n\n<inv',
      'oke name="request_handoff">\n<parameter name="reason">needs_',
      'human</parameter>',
    ]);
    expect(shown).toBe('상담원이 확인해 드립니다.\n\n');
    expect(leaked).toBe('<invoke name="request_handoff">\n<parameter name="reason">needs_human</parameter>');
  });

  it('<function_calls로 시작해도 거른다', () => {
    expect(run(['답입니다.<function_calls>\n<invoke name="request_handoff">']).shown).toBe('답입니다.');
  });
});

describe('handoffFromMarkup — 글자로 쓴 호출에서 신호 살리기', () => {
  it('사유와 요약을 읽는다', () => {
    expect(handoffFromMarkup(WRITTEN_CALL)).toEqual({ type: 'handoff', reason: 'needs_human', summary: '지난달 결제 건 환불 요청' });
  });

  it('닫는 태그 전에 끝나도 읽는다', () => {
    expect(handoffFromMarkup('<invoke name="request_handoff">\n<parameter name="reason">not_in_knowledge')).toEqual({
      type: 'handoff',
      reason: 'not_in_knowledge',
      summary: null,
    });
  });

  it('모르는 사유는 other로 살리고, request_handoff 호출이 아니면 null', () => {
    expect(handoffFromMarkup('<invoke name="request_handoff"><parameter name="reason">weird</parameter>')?.reason).toBe('other');
    expect(handoffFromMarkup('<invoke name="web_search"><parameter name="query">x</parameter>')).toBeNull();
  });
});

describe('ClaudeEngine — 본문에 쓴 넘김 호출', () => {
  const config = { model: 'claude-sonnet-5-5', thinking: 'off', fallback: false, maxTokens: 1024, apiKey: 'test' } as unknown as AppConfig;

  function fakeClient(texts: string[]): Anthropic {
    const stream = {
      async *[Symbol.asyncIterator]() {
        for (const text of texts) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
      },
      finalMessage: async () => ({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: texts.join(''), citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
    };
    return { beta: { messages: { stream: () => stream } } } as unknown as Anthropic;
  }

  it('태그는 방문자에게 가지 않고, 넘김 신호가 done 앞에 한 번 나간다', async () => {
    const engine = new ClaudeEngine(config, fakeClient(['환불 처리는 상담원이 이어서 도와드릴게요.\n\n', WRITTEN_CALL]));
    const events: EngineEvent[] = [];
    const request = { tenantId: 't', tenantName: '데모', message: '환불해 주세요', history: [], knowledge: [], signal: new AbortController().signal };
    for await (const event of engine.stream(request)) events.push(event);

    const shown = events
      .filter((e): e is Extract<EngineEvent, { type: 'delta' }> => e.type === 'delta')
      .map((e) => e.text)
      .join('');
    expect(shown).toBe('환불 처리는 상담원이 이어서 도와드릴게요.\n\n');
    expect(events.filter((e) => e.type === 'handoff')).toEqual([{ type: 'handoff', reason: 'needs_human', summary: '지난달 결제 건 환불 요청' }]);
    expect(events.at(-1)?.type).toBe('done');
  });
});
