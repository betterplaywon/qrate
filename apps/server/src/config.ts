// 런타임 설정은 전부 환경변수에서 읽고, 이 파일 한 곳에서만 해석한다.
// .env 파일은 dev 스크립트의 `--env-file-if-exists=.env`(Node 22.9+)로 로드되고,
// 컨테이너에서는 compose가 환경변수로 직접 넘긴다. 코드 어디에도 .env 파서는 없다.

import { parseOrigin } from './origin.js';

/** 답변 전 사고(thinking) 설정. off = 사고 없음(TTFT 최소), 나머지는 adaptive 사고 + effort. */
export type ThinkingSetting = 'off' | 'low' | 'medium' | 'high';
/** auto = API 키가 있으면 claude, 없으면 mock. CI와 테스트는 키가 없어 항상 mock으로 돈다. */
export type EngineKind = 'auto' | 'mock' | 'claude';

export interface AppConfig {
  port: number;
  /**
   * 브라우저에 보이는 이 서버의 오리진(scheme://host[:port]). 대화 API Origin 검사의 기준값. (src/origin.ts)
   * 기본값은 로컬 개발용 http://localhost:PORT. 운영에서는 위젯 서버의 공개 주소를 QRATE_PUBLIC_ORIGIN으로 준다.
   */
  publicOrigin: string;
  engine: EngineKind;
  /** 값은 어디에도 로그로 남기지 않는다. */
  apiKey: string | undefined;
  model: string;
  thinking: ThinkingSetting;
  /** 정책 거절(stop_reason: refusal) 시 서버 측 대체 모델 재시도(베타). Haiku처럼 지원하지 않는 모델에선 무시된다. */
  fallback: boolean;
  maxTokens: number;
}

const THINKING_SETTINGS = ['off', 'low', 'medium', 'high'] as const satisfies readonly ThinkingSetting[];
const ENGINE_KINDS = ['auto', 'mock', 'claude'] as const satisfies readonly EngineKind[];

// D5 결정(2026-11-02): 기본 Sonnet 5.5 + 사고 끔. 환경변수 한 줄로 교체한다.
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = parsePositiveInt(env.PORT, 8787);
  const thinking = parseEnum(env.QRATE_THINKING, THINKING_SETTINGS, 'off');
  // 사고를 켜면 사고 토큰도 max_tokens 안에서 소비되므로 여유를 더 둔다.
  const defaultMaxTokens = thinking === 'off' ? 1024 : 4096;
  return {
    port,
    // 값이 틀리면(http(s)가 아님 등) 여기서 던져 서버가 시작되지 않는다. 조용히 기본값으로 가면 Origin 검사가 전부 403이 된다.
    publicOrigin: parseOrigin(env.QRATE_PUBLIC_ORIGIN ? env.QRATE_PUBLIC_ORIGIN : `http://localhost:${port}`),
    engine: parseEnum(env.QRATE_ENGINE, ENGINE_KINDS, 'auto'),
    apiKey: env.ANTHROPIC_API_KEY ? env.ANTHROPIC_API_KEY : undefined,
    model: env.QRATE_MODEL ? env.QRATE_MODEL : DEFAULT_MODEL,
    thinking,
    fallback: (env.QRATE_FALLBACK ?? 'default') !== 'off',
    maxTokens: parsePositiveInt(env.QRATE_MAX_TOKENS, defaultMaxTokens),
  };
}

function parseEnum<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
