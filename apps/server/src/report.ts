// 처리 중 예외를 운영자에게 알리는 통로. index.ts가 Sentry를 꽂고, 테스트는 가짜 함수로 가로챈다.
// 기본은 stderr 한 줄이다. 어느 구현이든 요청 본문·사용자 메시지는 context에 넣지 않는다 — 넣으면 로그에 남는다.
export type ErrorReporter = (err: unknown, context?: Record<string, unknown>) => void;

export const reportToStderr: ErrorReporter = (err, context = {}) => {
  console.error('[server] error', JSON.stringify(context), err instanceof Error ? (err.stack ?? err.message) : String(err));
};
