// ESM이라 index.ts의 첫 import여도 Sentry.init은 import 그래프가 다 로드된 뒤에 돈다. 그래서 express 같은 라이브러리 계측은 붙지 않고
// 트랜잭션은 들어오는 HTTP 요청 단위(http.server)로만 생긴다. 라이브러리 계측까지 받으려면 실행 줄에서 이 파일을 먼저 읽힌다
// (`node --import ./dist/sentry.js dist/index.js`, @sentry/node README의 ESM 절). 면접 질문 docs/interview/week1-infra.md 13번.
import * as Sentry from '@sentry/node';

type DataCollection = NonNullable<Sentry.NodeOptions['dataCollection']>;

/** dataCollection을 주면 SDK가 빠진 항목을 '모두 수집'으로 채운다. */
const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: true,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  stackFrameVariables: false,
  frameContextLines: 5,
} satisfies Required<Omit<DataCollection, 'queryParams'>>;

export function sentryOptions(dsn: string, environment: string): Sentry.NodeOptions {
  return {
    dsn,
    environment,
    // 트랜잭션 샘플링 10%: 전수 수집은 비용·노이즈 문제. 장애 조사엔 에러 이벤트가 핵심.
    tracesSampleRate: 0.1,
    dataCollection: DATA_COLLECTION,
    // 들어오는 요청 본문은 httpBodies가 아니라 이 옵션만 보고 읽는다(SDK 10.78). 기본값은 10KB까지 읽는다.
    integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' })],
  };
}

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init(sentryOptions(dsn, process.env.NODE_ENV ?? 'development'));
}

export const sentryEnabled = Boolean(dsn);
export { Sentry };
