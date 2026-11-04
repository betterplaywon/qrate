import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

// Prisma 7 클라이언트. 드라이버 어댑터(@prisma/adapter-pg → node-postgres 커넥션 풀)로 만든다.
// 생성 코드는 src/generated/prisma(prisma generate, git 제외). 스키마와 마이그레이션은 prisma/.

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export type { PrismaClient };
