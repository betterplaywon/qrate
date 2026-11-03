import { describe, expect, it } from 'vitest';
import { HANDOFF_TOOL, HANDOFF_TOOL_NAME, readHandoff } from '../src/engine/handoff.js';

// 핸드오프 신호용 도구: 응답 content에서 tool_use 블록을 읽는 규칙과 도구 정의의 모양을 고정한다.
// 실제 모델이 도구를 부르는지는 키가 있어야 보이므로 여기서는 보지 않는다(실측은 ADR-0005 결과 확인 방법).

/** SDK 응답 블록의 모양만 흉내 낸다. readHandoff는 type·name·input만 보고 나머지는 무시해야 한다. */
type Block = { type: string; name?: string; input?: unknown; [field: string]: unknown };
const textBlock = (text: string): Block => ({ type: 'text', text, citations: null });
const handoffBlock = (input: unknown): Block => ({ type: 'tool_use', id: 'toolu_1', name: HANDOFF_TOOL_NAME, input });
const otherTool: Block = { type: 'tool_use', id: 'toolu_2', name: 'other_tool', input: { reason: 'not_in_knowledge' } };

describe('readHandoff — 응답 블록에서 신호 읽기', () => {
  it('텍스트 블록과 섞여 있어도 request_handoff 블록을 찾아 reason·summary(앞뒤 공백 제거)를 읽는다', () => {
    const content = [
      textBlock('그 내용은 안내 자료에 없어요. 상담원에게 문의해 주세요.'),
      handoffBlock({ reason: 'not_in_knowledge', summary: ' 카카오톡 알림 기능 문의 ' }),
    ];
    expect(readHandoff(content)).toEqual({ type: 'handoff', reason: 'not_in_knowledge', summary: '카카오톡 알림 기능 문의' });
  });

  it('도구 호출이 없으면 null이고, 다른 이름의 도구는 무시한다', () => {
    expect(readHandoff([textBlock('안녕하세요!')])).toBeNull();
    expect(readHandoff([otherTool])).toBeNull();
    expect(readHandoff([])).toBeNull();
  });

  it('입력이 스키마와 달라도 신호는 살린다 — 모르는 reason은 other, summary는 비문자열·빈 문자열이면 null', () => {
    expect(readHandoff([handoffBlock({ reason: 'billing_dispute', summary: 7 })])).toEqual({
      type: 'handoff',
      reason: 'other',
      summary: null,
    });
    expect(readHandoff([handoffBlock('garbage')])).toEqual({ type: 'handoff', reason: 'other', summary: null });
    expect(readHandoff([handoffBlock({ reason: 'needs_human', summary: '   ' })])).toEqual({
      type: 'handoff',
      reason: 'needs_human',
      summary: null,
    });
  });

  it('요약은 200자에서 자른다 — 큐·로그에 들어가는 값', () => {
    const out = readHandoff([handoffBlock({ reason: 'out_of_scope', summary: '가'.repeat(300) })]);
    expect(out?.reason).toBe('out_of_scope');
    expect(out?.summary).toHaveLength(200);
  });
});

describe('HANDOFF_TOOL — 도구 정의', () => {
  it('이름은 request_handoff, reason은 필수이고 enum은 계약의 HandoffReason에서 other를 뺀 것', () => {
    expect(HANDOFF_TOOL.name).toBe('request_handoff');
    const schema = HANDOFF_TOOL.input_schema as {
      type: string;
      required?: string[] | null;
      properties?: { reason?: { enum?: string[] }; summary?: { type?: string } };
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['reason']);
    expect(schema.properties?.reason?.enum).toEqual(['not_in_knowledge', 'needs_human', 'out_of_scope']);
    expect(schema.properties?.summary?.type).toBe('string');
    // 설명은 "문장을 먼저 쓴다"를 모델에게 요구한다 — 도구만 부르고 안내 문장을 비우는 것을 막는 첫 번째 장치
    expect(HANDOFF_TOOL.description).toContain('문장을 쓴 뒤');
  });
});
