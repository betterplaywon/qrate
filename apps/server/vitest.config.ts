import { defineConfig } from 'vitest/config';

// 워크스페이스 패키지(@qrate/contracts)는 빌드 산출물(dist)이 아니라 소스를 바로 읽는다 — package.json exports의 `source` 조건.
// 그래서 테스트는 contracts를 먼저 빌드하지 않아도 돈다. 타입체크는 tsconfig.json의 customConditions가 같은 일을 한다.
// Node 환경의 테스트는 Vite의 SSR 해석기를 타므로 ssr.resolve에도 같은 조건을 준다.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
});
