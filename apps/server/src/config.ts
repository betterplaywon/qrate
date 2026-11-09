// 런타임 설정은 전부 환경변수에서 읽고, 이 파일 한 곳에서만 해석한다.
// .env 파일은 dev 스크립트의 `--env-file-if-exists=.env`(Node 22.9+)로 로드되고,
// 컨테이너에서는 compose가 환경변수로 직접 넘긴다. 코드 어디에도 .env 파서는 없다.

import { parseTossKeys, type TossClientKey, type TossSecretKey } from './billing/toss.js';
import { parseOrigin } from './origin.js';

/** 답변 전 사고(thinking) 설정. off = 사고 없음(TTFT 최소), 나머지는 adaptive 사고 + effort. */
export type ThinkingSetting = 'off' | 'low' | 'medium' | 'high';
/** auto = API 키가 있으면 claude, 없으면 mock. CI와 테스트는 키가 없어 항상 mock으로 돈다. */
export type EngineKind = 'auto' | 'mock' | 'claude';
/** auto = DATABASE_URL이 있으면 postgres(Prisma), 없으면 memory(시드 파일). 테스트와 E2E는 memory를 명시한다. */
export type RepoKind = 'auto' | 'memory' | 'postgres';
export type PaymentProviderSetting = 'auto' | 'mock' | 'toss' | 'none';

export type PaymentConfig =
  | { provider: 'none' }
  | { provider: 'mock'; webhookSecret: string | undefined }
  | { provider: 'toss'; clientKey: TossClientKey; secretKey: TossSecretKey };

export interface AppConfig {
  port: number;
  /**
   * 연결을 받을 주소(QRATE_HOST). 개발(NODE_ENV=development)의 기본은 127.0.0.1이다 — 실제 API 키를 읽는 개발 서버를 같은 네트워크의 다른 기기에 열지 않는다.
   * 그 밖의 기본은 Node 기본값인 모든 인터페이스다. 컨테이너는 그래야 바깥에서 닿는다.
   */
  host: string | undefined;
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
  repo: RepoKind;
  /** Postgres 연결 문자열. 비밀번호가 들어 있으니 어디에도 로그로 남기지 않는다. */
  databaseUrl: string | undefined;
  /** 메모리 저장소일 때 데모 테넌트의 콘솔 로그인 키(시작 때 해시). Postgres에서는 시드가 넣은 해시를 쓴다. 값은 로그에 남기지 않는다. */
  demoConsoleKey: string | undefined;
  /** 콘솔 세션 토큰의 서명 비밀(16자 이상). 없으면 index.ts가 프로세스마다 무작위로 만든다 — 재시작하면 세션이 끊긴다. */
  consoleSecret: string | undefined;
  /** 비밀값은 어디에도 로그로 남기지 않는다. 시작 로그는 출처('env'·'random')만. */
  payments: PaymentConfig;
}

const THINKING_SETTINGS = ['off', 'low', 'medium', 'high'] as const satisfies readonly ThinkingSetting[];
const ENGINE_KINDS = ['auto', 'mock', 'claude'] as const satisfies readonly EngineKind[];
const REPO_KINDS = ['auto', 'memory', 'postgres'] as const satisfies readonly RepoKind[];
const PAYMENT_PROVIDER_SETTINGS = ['auto', 'mock', 'toss', 'none'] as const satisfies readonly PaymentProviderSetting[];

// D5 결정(2026-11-02): 기본 Sonnet 5.5 + 사고 끔. 환경변수 한 줄로 교체한다.
const DEFAULT_MODEL = 'claude-sonnet-5-5';

/**
 * 결제 없이 크레딧을 채우는 모의 결제는 개발·테스트임이 확실할 때만 기본으로 연다(2026-11-05 결정).
 * NODE_ENV가 비어 있으면 운영일 수도 있어 닫힌 쪽으로 본다 — 이미지 밖에서 띄운 운영 서버가 무료 충전을 열지 않게.
 */
export function isDevelopmentEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

/** 짧은 비밀은 조용히 받지 않는다 — 오타로 'secret' 같은 값이 들어가면 세션·웹훅 위조가 쉬워진다. 시작 시점에 실패시킨다. */
function parseSecret(name: string, raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.length < 16) throw new Error(`${name}은 16자 이상이어야 함`);
  return raw;
}

function parseEnum<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parsePayments(env: NodeJS.ProcessEnv): PaymentConfig {
  const setting = parseEnum(env.QRATE_PAYMENT_PROVIDER, PAYMENT_PROVIDER_SETTINGS, 'auto');
  const provider = setting === 'auto' ? (isDevelopmentEnv(env.NODE_ENV) ? 'mock' : 'none') : setting;
  const webhookSecret = parseSecret('QRATE_MOCK_PAYMENT_SECRET', env.QRATE_MOCK_PAYMENT_SECRET);
  switch (provider) {
    case 'none':
      return { provider };
    case 'mock':
      return { provider, webhookSecret };
    case 'toss':
      return { provider, ...parseTossKeys({ clientKey: env.QRATE_TOSS_CLIENT_KEY, secretKey: env.QRATE_TOSS_SECRET_KEY }) };
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = parsePositiveInt(env.PORT, 8787);
  const thinking = parseEnum(env.QRATE_THINKING, THINKING_SETTINGS, 'off');
  // 사고를 켜면 사고 토큰도 max_tokens 안에서 소비되므로 여유를 더 둔다.
  const defaultMaxTokens = thinking === 'off' ? 1024 : 4096;
  return {
    port,
    host: env.QRATE_HOST ? env.QRATE_HOST : env.NODE_ENV === 'development' ? '127.0.0.1' : undefined,
    // 값이 틀리면(http(s)가 아님 등) 여기서 던져 서버가 시작되지 않는다. 조용히 기본값으로 가면 Origin 검사가 전부 403이 된다.
    publicOrigin: parseOrigin(env.QRATE_PUBLIC_ORIGIN ? env.QRATE_PUBLIC_ORIGIN : `http://localhost:${port}`),
    engine: parseEnum(env.QRATE_ENGINE, ENGINE_KINDS, 'auto'),
    apiKey: env.ANTHROPIC_API_KEY ? env.ANTHROPIC_API_KEY : undefined,
    model: env.QRATE_MODEL ? env.QRATE_MODEL : DEFAULT_MODEL,
    thinking,
    fallback: (env.QRATE_FALLBACK ?? 'default') !== 'off',
    maxTokens: parsePositiveInt(env.QRATE_MAX_TOKENS, defaultMaxTokens),
    repo: parseEnum(env.QRATE_REPO, REPO_KINDS, 'auto'),
    databaseUrl: env.DATABASE_URL ? env.DATABASE_URL : undefined,
    demoConsoleKey: env.QRATE_DEMO_CONSOLE_KEY ? env.QRATE_DEMO_CONSOLE_KEY : undefined,
    consoleSecret: parseSecret('QRATE_CONSOLE_SECRET', env.QRATE_CONSOLE_SECRET),
    payments: parsePayments(env),
  };
}
