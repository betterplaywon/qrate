// 콘솔 E2E가 띄우는 서버(playwright.config.ts의 webServer). 위젯 E2E(8787)와 포트를 달리해 둘이 이어 돌아도 부딪히지 않는다.
export const SERVER_ORIGIN = 'http://localhost:8788';
/** 서버 환경변수 QRATE_DEMO_CONSOLE_KEY와 같은 값 — 메모리 저장소가 시작 때 해시해 데모 테넌트에 붙인다. */
export const CONSOLE_KEY = 'e2e-console-key';
/** 서버 환경변수 QRATE_MOCK_PAYMENT_SECRET과 같은 값 — 테스트가 결제 제공자 역할로 웹훅 원문에 직접 서명한다. */
export const MOCK_PAYMENT_SECRET = 'e2e-mock-payment-secret-0123456789';
