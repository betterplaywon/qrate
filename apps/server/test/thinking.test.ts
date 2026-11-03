import { describe, expect, it } from 'vitest';
import { thinkingParamsFor } from '../src/engine/thinking.js';

describe('thinkingParamsFor — 모델 계열마다 다른 "사고 끄기" 표현', () => {
  it('Sonnet 5.5는 between_tools (disabled는 400)', () => {
    expect(thinkingParamsFor('claude-sonnet-5-5', 'off')).toEqual({
      thinking: { type: 'between_tools' },
      output_config: { effort: 'low' },
    });
  });

  it('Haiku 5.5는 disabled', () => {
    expect(thinkingParamsFor('claude-haiku-5-5', 'off')).toEqual({
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
    });
  });

  it('Opus 5.5는 끌 수 없어 adaptive + low가 최소', () => {
    expect(thinkingParamsFor('claude-opus-5-5', 'off')).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    });
  });

  it('off가 아니면 모델과 무관하게 adaptive + 지정 effort', () => {
    expect(thinkingParamsFor('claude-sonnet-5-5', 'medium')).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    });
  });
});
