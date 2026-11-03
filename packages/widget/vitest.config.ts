import { defineConfig } from 'vitest/config';

// @qrate/contracts는 소스를 바로 읽는다(exports의 `source` 조건). Node 환경 테스트는 SSR 해석기를 타므로 ssr.resolve에도 준다.
// 단위 테스트는 test/ 아래만. e2e/의 *.spec.ts는 Playwright가 돌린다(playwright.config.ts).
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: { include: ['test/**/*.test.ts'] },
});
