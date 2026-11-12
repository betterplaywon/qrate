// Prisma CLI 설정(Prisma 7) — 스키마·마이그레이션·시드 위치와 DB 주소.
// 서버 런타임은 이 파일을 읽지 않는다. DATABASE_URL 해석은 src/config.ts, 연결은 src/repo/prisma.ts.
// 명령은 apps/server에서 실행한다: pnpm --filter @qrate/server exec prisma <command>
import { defineConfig } from 'prisma/config';

// Prisma 7 CLI는 .env를 읽지 않는다. 서버와 같은 파일(apps/server/.env)을 Node 내장 로더로 읽는다 — dotenv 없이.
// 이미 있는 환경변수가 우선한다(CI·컨테이너는 환경변수로 넘긴다). 파일이 없으면 환경변수만 쓴다.
try {
  process.loadEnvFile('.env');
} catch {
  // .env 없음
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // prisma db seed. 데모 시드 파일(seed/demo-tenant.json, seed/reception-tenant.json)은 메모리 저장소와 같은 것을 쓴다 — prisma/seed.ts
    seed: 'tsx --conditions=source prisma/seed.ts',
  },
  datasource: {
    // env() 헬퍼는 값이 없으면 generate까지 막는다. generate는 DB가 필요 없으므로(Docker 빌드 스테이지, 키 없는 로컬)
    // 빈 값을 허용하고, migrate·seed는 연결할 때 실패한다.
    url: process.env.DATABASE_URL ?? '',
  },
});
