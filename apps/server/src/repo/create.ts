import { DEMO_CONSOLE_KEY_ENV, type AppConfig } from '../config.js';
import { hashConsoleKey } from '../console/key.js';
import { createPrismaClient, createPrismaRepositories } from './prisma.js';
import { createRepositoriesFromSeeds, loadSeedFiles } from './seed.js';
import type { Repositories } from './types.js';

// 저장소 고르기(서버 시작). auto는 DATABASE_URL이 있으면 Postgres(Prisma), 없으면 시드 파일을 올린 메모리 저장소다 — 엔진의 auto와 같은 규칙.

export interface Storage {
  repos: Repositories;
  /** 시작 로그 한 줄. 비밀값은 없다. */
  description: string;
}

/** Postgres. 시작할 때 연결과 마이그레이션 적용 여부를 확인한다 — 주소가 틀리거나 테이블이 없으면 첫 대화가 아니라 여기서 실패한다. */
async function connectPostgres(databaseUrl: string): Promise<Storage> {
  const prisma = createPrismaClient(databaseUrl);
  let tenants: number;
  try {
    tenants = await prisma.tenant.count();
  } catch (err) {
    throw new Error(
      'Postgres에 연결하지 못했거나 테이블이 없다. docker compose up -d db 뒤 pnpm --filter @qrate/server db:deploy && db:seed',
      { cause: err },
    );
  }
  const hint = tenants === 0 ? ' (비어 있음 — pnpm --filter @qrate/server db:seed)' : '';
  return { repos: createPrismaRepositories(prisma), description: `postgres tenants=${tenants}${hint}` };
}

/**
 * 메모리 + 데모 시드 파일 전부. 콘솔 로그인 키는 시드 파일에 없다(비밀). 데모 회사마다 환경변수(DEMO_CONSOLE_KEY_ENV)로 받고,
 * 키가 없는 회사는 콘솔 로그인이 안 되는 채로 뜬다.
 */
function memoryFromSeeds(demoConsoleKeys: Readonly<Record<string, string>>): Storage {
  const seeds = loadSeedFiles();
  const consoleKeyHashes: Record<string, string> = {};
  for (const { tenant } of seeds) {
    const key = demoConsoleKeys[tenant.id];
    if (key) consoleKeyHashes[tenant.id] = hashConsoleKey(key);
  }
  const withKey = Object.keys(consoleKeyHashes);
  const consoleHint = withKey.length > 0 ? `on(${withKey.join(',')})` : `off (${Object.values(DEMO_CONSOLE_KEY_ENV).join('·')} 없음)`;
  const tenants = seeds.map((seed) => `${seed.tenant.id}(${seed.knowledge.length})`).join(',');
  return {
    repos: createRepositoriesFromSeeds(seeds, { consoleKeyHashes }),
    description: `memory seed tenants=${tenants} console=${consoleHint}`,
  };
}

export async function createRepositories(cfg: AppConfig): Promise<Storage> {
  const usePostgres = cfg.repo === 'postgres' || (cfg.repo === 'auto' && Boolean(cfg.databaseUrl));
  if (usePostgres) {
    if (!cfg.databaseUrl) throw new Error('QRATE_REPO=postgres requires DATABASE_URL');
    return connectPostgres(cfg.databaseUrl);
  }
  if (process.env.NODE_ENV === 'production') {
    // 운영에서 메모리 저장소면 대화가 프로세스 재시작 때 사라진다. 막지는 않는다(목업 엔진과 같은 정책) — 로그로 크게 알린다.
    console.warn('[server] WARNING: memory storage in production — DATABASE_URL이 없어 대화가 재시작 때 사라진다');
  }
  return memoryFromSeeds(cfg.demoConsoleKeys);
}
