// Sentry가 가장 먼저 로드되어야 한다 — 아래 import 순서는 의도된 것. (src/sentry.ts 참고)
import { Sentry, sentryEnabled } from './sentry.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createEngine } from './engine/index.js';
import { reportToStderr, type ErrorReporter } from './report.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from './repo/seed.js';

const config = loadConfig();
const engine = createEngine(config);
// W2: 시드 파일 → 메모리 저장소. Postgres(Prisma) 구현은 W3 첫날에 붙인다 (개발 DB 결정 2026-11-02).
const seed = loadSeedFile(DEFAULT_SEED_PATH);
const repos = createRepositoriesFromSeed(seed);
// 대화창 앱(app.js·app.css)은 위젯 패키지의 빌드 산출물이다. 워크스페이스 의존성으로 받아 패키지 위치에서 찾는다.
// 컨테이너에는 pnpm deploy가 @qrate/widget의 dist/를 함께 담는다(apps/server/Dockerfile).
const frameAssetsDir = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@qrate/widget/package.json')),
  'dist',
  'frame',
);
// 처리 중 예외의 보고 통로. 앱의 마지막 오류 핸들러(app.ts)와 턴 저장·엔진 실패(chat/, http/)가 이 함수를 부른다.
// Sentry가 켜져 있으면 거기로도 보낸다. 요청 본문·사용자 메시지는 어느 구현에도 넘기지 않는다(src/report.ts).
const reportError: ErrorReporter = sentryEnabled
  ? (err, context) => {
      Sentry.captureException(err, { extra: context });
      reportToStderr(err, context);
    }
  : reportToStderr;
const app = createApp({ engine, repos, publicOrigin: config.publicOrigin, frameAssetsDir, sentryEnabled, reportError });

app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(
    `[server] engine=${engine.name} model=${engine.model} thinking=${config.thinking} fallback=${config.fallback ? 'default' : 'off'}`,
  );
  console.log(`[server] seed tenant=${seed.tenant.id} knowledge=${seed.knowledge.length} (memory repositories)`);
  console.log(`[server] publicOrigin=${config.publicOrigin} — 대화 API는 이 오리진의 iframe에서 온 요청만 받는다`);
  console.log(`[server] frame assets=${frameAssetsDir}`);
});
