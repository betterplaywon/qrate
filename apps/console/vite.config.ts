import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// 운영 콘솔 빌드·개발 설정.
// - base '/console/': 빌드 산출물은 서버가 같은 오리진의 /console/ 아래에서 서빙한다(apps/server/src/app.ts). 콘솔 결정(2026-11-04) 위치 A.
// - dev 서버(5175, 위젯 데모 5173과 겹치지 않게): /api 요청을 8787(pnpm dev)로 프록시한다. 브라우저 입장에선 페이지와 API가
//   같은 오리진(localhost:5175)이라 세션 쿠키가 그대로 실리고, 프록시가 Origin 헤더를 서버 오리진으로 바꿔 서버의 Origin 검사를 통과한다.
//   (개발 편의로 Origin 검사를 우회하는 것이다 — 운영에선 프록시가 없고 페이지와 API가 실제로 같은 오리진이다.)
const SERVER = 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  base: '/console/',
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5175,
    proxy: { '/api': { target: SERVER, headers: { origin: SERVER } } },
  },
});
