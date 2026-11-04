import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

/**
 * .env에서 QRATE_TEST_* 만 테스트 환경으로 올린다(예: QRATE_TEST_DATABASE_URL → Postgres 계약 테스트).
 * 나머지(API 키, 개발 DB 주소)는 일부러 올리지 않는다 — 테스트가 실제 모델이나 개발 DB를 건드리면 안 된다.
 * 셸 환경변수가 이미 있으면(CI) 그쪽이 우선이다.
 */
function testEnvFromDotenv(): Record<string, string> {
  try {
    const parsed = parseEnv(readFileSync('.env', 'utf8'));
    return Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key.startsWith('QRATE_TEST_') && !(key in process.env)),
    );
  } catch {
    return {};
  }
}

// 워크스페이스 패키지(@qrate/contracts)는 빌드 산출물(dist)이 아니라 소스를 바로 읽는다 — package.json exports의 `source` 조건.
// 그래서 테스트는 contracts를 먼저 빌드하지 않아도 돈다. 타입체크는 tsconfig.json의 customConditions가 같은 일을 한다.
// Node 환경의 테스트는 Vite의 SSR 해석기를 타므로 ssr.resolve에도 같은 조건을 준다.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: { env: testEnvFromDotenv() },
});
