// Sentry는 다른 모듈보다 먼저 로드되어야 http 요청 등을 계측할 수 있다.
// 그래서 index.ts의 "첫 번째 import"가 이 파일이다. (면접 질문 11번)
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    // 트랜잭션 샘플링 10%: 전수 수집은 비용·노이즈 문제. 장애 조사엔 에러 이벤트가 핵심.
    tracesSampleRate: 0.1,
  });
}

export const sentryEnabled = Boolean(dsn);
export { Sentry };
