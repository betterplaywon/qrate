// E2E가 띄우는 두 서버의 주소(playwright.config.ts의 webServer). 테스트와 설정이 같은 값을 본다.
// 데모 오리진은 시드 테넌트의 allowedOrigins에 있어야 대화창이 열린다(apps/server/seed/demo-tenant.json).
export const SERVER_ORIGIN = 'http://localhost:8787';
export const DEMO_ORIGIN = 'http://localhost:5173';
/**
 * 같은 데모를 허용 목록에 없는 포트에서 한 번 더 서빙한다 — "허용되지 않은 사이트"를 실제 서버로 재현한다.
 * 네트워크 가로채기로 가짜 오리진을 꾸미면 Chromium이 그 문서를 공개 주소로 보고 로컬 네트워크 접근 검사
 * (net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS)로 localhost 서버 요청을 먼저 막아, 서버·CSP 검사를 볼 수 없다.
 */
export const NOT_ALLOWED_DEMO_ORIGIN = 'http://localhost:5174';
