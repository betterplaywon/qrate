import type { AppConfig } from '../config.js';
import { ClaudeEngine } from './claude.js';
import { MockEngine } from './mock.js';
import type { AnswerEngine } from './types.js';

/** auto: 키가 있으면 Claude, 없으면 목업. CI와 테스트는 키가 없어 항상 목업이다. */
export function createEngine(config: AppConfig): AnswerEngine {
  const useClaude = config.engine === 'claude' || (config.engine === 'auto' && Boolean(config.apiKey));
  if (!useClaude) return new MockEngine();
  if (!config.apiKey) throw new Error('QRATE_ENGINE=claude requires ANTHROPIC_API_KEY');
  return new ClaudeEngine(config);
}
