import type Anthropic from '@anthropic-ai/sdk';
import type { ThinkingSetting } from '../config.js';

export interface ThinkingParams {
  thinking: Anthropic.Beta.BetaThinkingConfigParam;
  output_config?: Anthropic.Beta.BetaOutputConfig;
}

// "사고를 끈다"는 표현이 모델 계열마다 다르다. 설치된 SDK 타입과 모델 문서(2026-11)로 확인한 규칙:
//  - Sonnet 5.5: {type:'disabled'}는 400. 가장 낮은 설정은 {type:'between_tools'}이고 effort는 high 이하여야 한다.
//  - Haiku 5.5:  {type:'disabled'}가 effort high 이하에서 허용된다.
//  - Opus 5.5·Fable: 끌 수 없다. adaptive + effort low가 최소다.
// 환경변수로 모델만 바꿔도 요청이 400으로 깨지지 않도록 여기서 흡수한다.
export function thinkingParamsFor(model: string, setting: ThinkingSetting): ThinkingParams {
  if (setting !== 'off') {
    return { thinking: { type: 'adaptive' }, output_config: { effort: setting } };
  }
  if (model.startsWith('claude-sonnet-5-5')) {
    return { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } };
  }
  if (model.startsWith('claude-haiku-5-5')) {
    return { thinking: { type: 'disabled' }, output_config: { effort: 'low' } };
  }
  return { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } };
}
