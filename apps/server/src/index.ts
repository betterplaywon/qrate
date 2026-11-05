// Sentry가 가장 먼저 로드되어야 한다 — 아래 import 순서는 의도된 것. (src/sentry.ts 참고)
import { Sentry, sentryEnabled } from './sentry.js';
import { CONSOLE_API_PATH, CONSOLE_PATH } from '@qrate/contracts';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createApp } from './app.js';
import { createMockProvider } from './billing/mock.js';
import type { PaymentProviders } from './billing/provider.js';
import { isDevelopmentEnv, loadConfig } from './config.js';
import { createEngine } from './engine/index.js';
import { createEventSink } from './events/sink.js';
import { reportToStderr, type ErrorReporter } from './report.js';
import { createRepositories } from './repo/create.js';

/** 워크스페이스 패키지의 빌드 산출물 위치. 컨테이너에는 pnpm deploy가 각 패키지의 dist/를 함께 담는다(apps/server/Dockerfile). */
const require = createRequire(import.meta.url);
const packageDist = (pkg: string, ...segments: string[]): string =>
  path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'dist', ...segments);

const config = loadConfig();
const engine = createEngine(config);
// 저장소(repo/create.ts): DATABASE_URL이 있으면 Postgres, 없으면 시드 파일을 올린 메모리.
const storage = await createRepositories(config);
// 대화창 앱(app.js·app.css)과 운영 콘솔 앱(index.html·assets/)은 각 패키지의 빌드 산출물이다. 워크스페이스 의존성으로 받아 서빙한다.
const frameAssetsDir = packageDist('@qrate/widget', 'frame');
const consoleAssetsDir = packageDist('@qrate/console');
// 처리 중 예외의 보고 통로. 앱의 마지막 오류 핸들러(app.ts)와 턴 저장·엔진 실패(chat/, http/)가 이 함수를 부른다.
// Sentry가 켜져 있으면 거기로도 보낸다. 요청 본문·사용자 메시지는 어느 구현에도 넘기지 않는다(src/report.ts).
const reportError: ErrorReporter = sentryEnabled
  ? (err, context) => {
      Sentry.captureException(err, { extra: context });
      reportToStderr(err, context);
    }
  : reportToStderr;
// 콘솔 세션 서명 비밀. 환경변수가 없으면 프로세스마다 새로 만든다 — 로컬에선 충분하고, 재시작하면 운영자가 다시 로그인한다.
const consoleSecret = config.consoleSecret ?? randomBytes(32).toString('base64url');
const payments: PaymentProviders =
  config.paymentProvider === 'mock'
    ? { mock: createMockProvider(config.mockPaymentSecret ?? randomBytes(32).toString('base64url')) }
    : {};
if (config.paymentProvider === 'mock' && !isDevelopmentEnv(process.env.NODE_ENV)) {
  console.warn(
    `[server] WARNING: mock payments with NODE_ENV=${process.env.NODE_ENV ?? '(없음)'} — 결제 없이 크레딧을 채우는 테스트 버튼이 열린다(QRATE_PAYMENT_PROVIDER=mock)`,
  );
}
const app = createApp({
  engine,
  repos: storage.repos,
  publicOrigin: config.publicOrigin,
  frameAssetsDir,
  sentryEnabled,
  reportError,
  // 사건 JSON을 stdout에도 한 줄씩 — 개발 중 보기용. verify·E2E 서버는 NODE_ENV 없이 떠서 켜지고, 컨테이너(production)는 끈다.
  recordEvent: createEventSink({ repo: storage.repos.events, reportError, echo: process.env.NODE_ENV !== 'production' }),
  console: { secret: consoleSecret },
  consoleAssetsDir,
  payments,
});

app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(
    `[server] engine=${engine.name} model=${engine.model} thinking=${config.thinking} fallback=${config.fallback ? 'default' : 'off'}`,
  );
  console.log(`[server] storage=${storage.description}`);
  console.log(`[server] console api=${CONSOLE_API_PATH} session secret=${config.consoleSecret ? 'env' : 'random (재시작하면 세션이 끊긴다 — QRATE_CONSOLE_SECRET)'}`);
  console.log(
    `[server] payments=${config.paymentProvider}${config.paymentProvider === 'mock' ? ` webhook secret=${config.mockPaymentSecret ? 'env' : 'random'}` : ''}`,
  );
  console.log(`[server] publicOrigin=${config.publicOrigin} — 대화 API는 이 오리진의 iframe에서 온 요청만 받는다`);
  console.log(`[server] frame assets=${frameAssetsDir}`);
  console.log(`[server] console app=${CONSOLE_PATH}/ assets=${consoleAssetsDir}`);
});
