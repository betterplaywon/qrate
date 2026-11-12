// `prisma db seed` — 데모 시드 파일(seed/demo-tenant.json, seed/reception-tenant.json)을 Postgres에 넣는다. 메모리 저장소가 서버 시작 때 읽는 것과 같은 파일이다.
// 몇 번을 돌려도 결과가 같다(applySeed). DATABASE_URL은 prisma.config.ts가 .env에서 읽어 환경변수로 둔 값이 그대로 넘어온다.
import { DEMO_CONSOLE_KEY_ENV, readDemoConsoleKeys } from '../src/config.js';
import { hashConsoleKey } from '../src/console/key.js';
import { applySeed, createPrismaClient } from '../src/repo/prisma.js';
import { loadSeedFiles } from '../src/repo/seed.js';

/** 로그용 — 비밀번호는 빼고 호스트·DB 이름만. */
function describeDatabase(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL이 필요하다 (apps/server/.env 또는 환경변수)');

// 데모 회사마다의 콘솔 로그인 키(DEMO_CONSOLE_KEY_ENV). 시드 파일에는 비밀을 두지 않으므로 환경변수에서 받아 해시만 저장한다.
// 키가 없는 회사는 DB의 기존 값을 그대로 둔다(처음이면 null → 콘솔 로그인 불가).
const consoleKeys = readDemoConsoleKeys(process.env);

const prisma = createPrismaClient(url);
try {
  for (const seed of loadSeedFiles()) {
    const key = consoleKeys[seed.tenant.id];
    await applySeed(prisma, seed, key ? { consoleKeyHash: hashConsoleKey(key) } : {});
    console.log(`[seed] tenant=${seed.tenant.id} knowledge=${seed.knowledge.length} console=${key ? '새 키' : '그대로'} → ${describeDatabase(url)}`);
  }
  const missing = Object.entries(DEMO_CONSOLE_KEY_ENV).flatMap(([tenantId, name]) => (consoleKeys[tenantId] ? [] : [name]));
  if (missing.length > 0) {
    console.warn(`[seed] ${missing.join('·')} 없음 — 그 회사의 콘솔 키는 바꾸지 않았다. 콘솔 로그인이 필요하면 설정하고 다시 돌린다`);
  }
} finally {
  await prisma.$disconnect();
}
