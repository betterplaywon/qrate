import { defaultClientConditions, defineConfig } from 'vite';

// 대화창 앱 번들. 서버가 /frame/app.js·/frame/app.css로 서빙한다(apps/server/src/http/frame.ts).
// /frame 문서의 CSP(default-src 'self')가 인라인 스크립트·스타일을 막으므로 별도 파일이어야 하고, 같은 오리진이면 된다.
// 런처(vite.config.ts)와 따로 빌드하는 이유: IIFE 라이브러리 모드는 진입점을 하나만 받는다.
export default defineConfig({
  resolve: { conditions: ['source', ...defaultClientConditions] },
  build: {
    outDir: 'dist/frame',
    lib: {
      entry: 'src/frame/main.ts',
      name: 'QrateFrame',
      formats: ['iife'],
      fileName: () => 'app.js',
      cssFileName: 'app',
    },
  },
});
