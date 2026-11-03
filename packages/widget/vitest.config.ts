import { defineConfig } from 'vitest/config';

// @qrate/contracts는 소스를 바로 읽는다(exports의 `source` 조건). Node 환경 테스트는 SSR 해석기를 타므로 ssr.resolve에도 준다.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
});
