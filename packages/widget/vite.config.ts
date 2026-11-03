import { defaultClientConditions, defineConfig } from 'vite';

// 런처 번들(widget.js): 고객 사이트가 <script> 한 줄로 로드하는 IIFE 단일 파일.
// ESM이 아닌 IIFE인 이유 — 호스트 페이지의 모듈 시스템·빌드 설정과 무관하게 동작해야 하므로.
// 대화창 앱은 vite.frame.config.ts로 따로 빌드한다(dist/frame/).
export default defineConfig({
  // @qrate/contracts는 빌드 산출물이 아니라 소스를 번들에 넣는다(package.json exports의 `source` 조건).
  resolve: { conditions: ['source', ...defaultClientConditions] },
  build: {
    // dist/frame/(대화창 빌드)을 지우지 않는다. dist 전체 정리는 build 스크립트의 rm -rf가 맡는다.
    emptyOutDir: false,
    lib: {
      entry: 'src/loader.ts',
      name: 'Qrate',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
  },
});
