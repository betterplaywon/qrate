// Sentry는 다른 모듈보다 먼저 로드되어야 http 요청 등을 계측할 수 있다.
// 그래서 index.ts의 "첫 번째 import"가 이 파일이다. (면접 질문 11번)
import * as Sentry from '@sentry/node';

type DataCollection = NonNullable<Sentry.NodeOptions['dataCollection']>;

/**
 * Sentry로 보내는 데이터의 범위. 요청 본문(방문자 메시지·콘솔 로그인 키), 쿠키(콘솔 세션), 요청 헤더, IP, 모델 입력·출력을 보내지 않는다.
 * dataCollection을 주면 SDK가 빠진 항목을 '모두 수집'으로 채운다. 그래서 타입으로 모든 항목을 적게 한다 —
 * SDK가 항목을 늘리면 타입체크가 실패해 그 항목을 정하게 된다.
 */
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
    // 들어오는 요청 본문은 httpBodies가 아니라 이 옵션만 보고 읽는다(SDK 10.78, 2026-11-06 실측). 기본값은 10KB까지 읽는다.
    integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' })],
  };
}

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init(sentryOptions(dsn, process.env.NODE_ENV ?? 'development'));
}

export const sentryEnabled = Boolean(dsn);
export { Sentry };
