import type { PaymentProviderName } from '@qrate/contracts';
import express, { type RequestHandler } from 'express';

// 콘솔 앱(React 빌드 산출물 index.html·assets/)의 정적 서빙. 서버가 같은 오리진의 /console/ 아래에서 내려준다(콘솔 결정 2026-11-04).
// 자산은 파일 이름에 해시가 있어 오래 캐시하고, index.html은 매번 재검증한다. 화면 상태는 해시 라우팅이라 SPA 폴백이 필요 없다.
// 로그인 전에도 문서는 내려간다 — 데이터는 전부 세션이 있어야 하는 API에서 온다.

type CheckoutDirective = 'script-src' | 'connect-src' | 'frame-src';
const CHECKOUT_DIRECTIVES: readonly CheckoutDirective[] = ['script-src', 'connect-src', 'frame-src'];

/**
 * 토스는 결제창형 SDK를 콘솔과 같은 헤더 아래에서 띄워 위반 0을 확인한 호스트만 넣었다(2026-11-09, 테스트 모드, 와일드카드 없음).
 * 인라인 스타일·eval·팝업은 쓰지 않았다. 상점의 결제수단이 달라 목록 밖이 필요해지면 브라우저 콘솔에 CSP 위반이 뜬다.
 */
const CHECKOUT_SOURCES = {
  mock: {},
  toss: {
    'script-src': [
      'https://js.tosspayments.com', // SDK. 결제하기를 누를 때 콘솔이 넣는다
    ],
    'connect-src': [
      'https://api.tosspayments.com', // SDK가 결제창을 그릴 때 부른다(xhr GET)
      'https://apigw-sandbox.tosspayments.com', // 결제하기 뒤의 결제 요청(xhr POST, 테스트 모드 호스트)
      'https://event.tosspayments.com',
      'https://log.tosspayments.com',
    ],
    'frame-src': [
      'https://payment-widget.tosspayments.com',
      'https://payment-gateway-sandbox.tosspayments.com', // 결제하기 뒤 같은 iframe이 옮겨 가는 결제 게이트웨이(테스트 모드 호스트)
      'https://toss.im', // 기본 결제수단 퀵계좌이체에서 게이트웨이가 옮겨 간다 — 빼면 기본 수단이 막힌다
    ],
  },
} as const satisfies Record<PaymentProviderName, Partial<Record<CheckoutDirective, readonly string[]>>>;

/**
 * 콘솔 문서의 CSP. 기본은 대화창과 같은 default-src 'self'(번들은 /console/assets/의 파일, 인라인 없음) +
 * frame-ancestors 'none'(콘솔은 어디에도 iframe으로 들어가지 않는다 — 클릭재킹 방지) + base-uri 'none'.
 * 결제 방법이 지시문을 더하면 그 앞에 'self'를 넣는다. 지시문을 따로 적는 순간 그 종류에는 default-src가 적용되지 않아서다.
 */
export function consoleCsp(provider: PaymentProviderName | null): string {
  const sources: Partial<Record<CheckoutDirective, readonly string[]>> = provider ? CHECKOUT_SOURCES[provider] : {};
  const opened = CHECKOUT_DIRECTIVES.flatMap((directive) => {
    const hosts = sources[directive];
    return hosts ? [`${directive} 'self' ${hosts.join(' ')}`] : [];
  });
  return ["default-src 'self'", ...opened, "frame-ancestors 'none'", "base-uri 'none'"].join('; ');
}

export function consoleStatic(assetsDir: string, csp: string): RequestHandler {
  return express.static(assetsDir, {
    index: 'index.html',
    maxAge: '1y',
    immutable: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Security-Policy', csp);
      }
    },
  });
}
