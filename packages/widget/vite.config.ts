import { defaultClientConditions, defineConfig } from 'vite';

// IIFE 단일 파일 번들: 고객 사이트가 <script> 한 줄로 로드한다.
// ESM이 아닌 IIFE인 이유 — 호스트 페이지의 모듈 시스템·빌드 설정과 무관하게 동작해야 하므로.
export default defineConfig({
  // @qrate/contracts는 빌드 산출물이 아니라 소스를 번들에 넣는다(package.json exports의 `source` 조건).
  resolve: { conditions: ['source', ...defaultClientConditions] },
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'Qrate',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
  },
});
