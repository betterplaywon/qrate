// Sentry가 가장 먼저 로드되어야 한다 — 아래 import 순서는 의도된 것. (src/sentry.ts 참고)
import { Sentry, sentryEnabled } from './sentry.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createEngine } from './engine/index.js';
import { DEFAULT_SEED_PATH, createRepositoriesFromSeed, loadSeedFile } from './repo/seed.js';

const config = loadConfig();
const engine = createEngine(config);
// W2: 시드 파일 → 메모리 저장소. Postgres(Prisma) 구현은 W3 첫날에 붙인다 (개발 DB 결정 2026-11-02).
const seed = loadSeedFile(DEFAULT_SEED_PATH);
const repos = createRepositoriesFromSeed(seed);
const app = createApp({ engine, repos, sentryEnabled });

// Sentry 에러 핸들러는 라우트 등록 "이후", 리스닝 "이전"에 단다.
if (sentryEnabled) {
  Sentry.setupExpressErrorHandler(app);
}

app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(
    `[server] engine=${engine.name} model=${engine.model} thinking=${config.thinking} fallback=${config.fallback ? 'default' : 'off'}`,
  );
  console.log(`[server] seed tenant=${seed.tenant.id} knowledge=${seed.knowledge.length} (memory repositories)`);
});
