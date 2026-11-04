// Sentry가 가장 먼저 로드되어야 한다 — 아래 import 순서는 의도된 것. (src/sentry.ts 참고)
import { Sentry, sentryEnabled } from './sentry.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { createEngine } from './engine/index.js';
import { reportToStderr, type ErrorReporter } from './report.js';
import { createPrismaClient, createPrismaRepositories } from './repo/prisma.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from './repo/seed.js';
import type { Repositories } from './repo/types.js';

const config = loadConfig();
const engine = createEngine(config);
const storage = await createStorage(config);
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
const app = createApp({
  engine,
  repos: storage.repos,
  publicOrigin: config.publicOrigin,
  frameAssetsDir,
  sentryEnabled,
  reportError,
});

app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(
    `[server] engine=${engine.name} model=${engine.model} thinking=${config.thinking} fallback=${config.fallback ? 'default' : 'off'}`,
  );
  console.log(`[server] storage=${storage.description}`);
  console.log(`[server] publicOrigin=${config.publicOrigin} — 대화 API는 이 오리진의 iframe에서 온 요청만 받는다`);
  console.log(`[server] frame assets=${frameAssetsDir}`);
});

/**
 * 저장소 고르기. auto는 DATABASE_URL이 있으면 Postgres(Prisma), 없으면 시드 파일을 올린 메모리 저장소다(엔진의 auto와 같은 규칙).
 * Postgres는 시작할 때 연결과 마이그레이션 적용 여부를 확인한다 — 주소가 틀리거나 테이블이 없으면 첫 대화가 아니라 여기서 실패한다.
 */
async function createStorage(cfg: AppConfig): Promise<{ repos: Repositories; description: string }> {
  const usePostgres = cfg.repo === 'postgres' || (cfg.repo === 'auto' && Boolean(cfg.databaseUrl));
  if (usePostgres) {
    if (!cfg.databaseUrl) throw new Error('QRATE_REPO=postgres requires DATABASE_URL');
    const prisma = createPrismaClient(cfg.databaseUrl);
    let tenants: number;
    try {
      tenants = await prisma.tenant.count();
    } catch (err) {
      throw new Error(
        'Postgres에 연결하지 못했거나 테이블이 없다. docker compose up -d db 뒤 pnpm --filter @qrate/server db:deploy && db:seed',
        { cause: err },
      );
    }
    return {
      repos: createPrismaRepositories(prisma),
      description: `postgres tenants=${tenants}${tenants === 0 ? ' (비어 있음 — pnpm --filter @qrate/server db:seed)' : ''}`,
    };
  }
  const seed = loadSeedFile(DEFAULT_SEED_PATH);
  if (process.env.NODE_ENV === 'production') {
    // 운영에서 메모리 저장소면 대화가 프로세스 재시작 때 사라진다. 막지는 않는다(목업 엔진과 같은 정책) — 로그로 크게 알린다.
    console.warn('[server] WARNING: memory storage in production — DATABASE_URL이 없어 대화가 재시작 때 사라진다');
  }
  return {
    repos: createRepositoriesFromSeed(seed),
    description: `memory seed tenant=${seed.tenant.id} knowledge=${seed.knowledge.length}`,
  };
}
