import { CHAT_PATH, CONSOLE_API_PATH, CONSOLE_PATH, EVENTS_PATH, FRAME_PATH, HANDOFF_PATH, PAYMENT_WEBHOOK_ROUTE } from '@qrate/contracts';
import express from 'express';
import type { PaymentProviders } from './billing/provider.js';
import { createBillingService } from './billing/service.js';
import { createChatService } from './chat/service.js';
import { createSessionCodec } from './console/session.js';
import type { AnswerEngine } from './engine/types.js';
import { createEventSink, type EventSink } from './events/sink.js';
import { createChatHandler } from './http/chat.js';
import { createConsoleRouter } from './http/console/router.js';
import { consoleStatic } from './http/console/static.js';
import { createErrorHandler, notFound } from './http/errors.js';
import { createEventRoute } from './http/events.js';
import { createFrameHandler } from './http/frame.js';
import { createHandoffRoute } from './http/handoff.js';
import { createWebhookRoute } from './http/payments.js';
import { requireOwnOrigin } from './origin.js';
import { reportToStderr, type ErrorReporter } from './report.js';
import type { Repositories } from './repo/types.js';

// 서버 구조 — 의존 방향은 바깥에서 안으로만 간다.
//   http/     Express 핸들러·미들웨어·SSE 전송. 본문 모양 검사, 상태 코드(엔진 실패 코드 → 상태 포함), 스트림 쓰기, chat_request 사건,
//             오류 핸들러(errors.ts), 요율 제한(rate-limit.ts), 상담원 연결 접수(handoff.ts), 위젯 사건 수집(events.ts),
//             운영 콘솔(console/ — router 조립, auth 로그인, session 미들웨어, cookie, query, dto, top-ups 충전, static 페이지 서빙),
//             결제 제공자 웹훅(payments.ts)
//   console/  콘솔 인증 조각 — 키 해시(scrypt), 세션 토큰(HMAC), 로그인 시도 제한. Express를 모른다
//   chat/     대화 유스케이스 — 테넌트 확인, 모더레이션, 대화 이어 가기, 지식 선택, 턴 저장. Express를 모른다
//   billing/  충전 유스케이스 — 결제 제공자 경계(provider)·모의 제공자(mock)·이벤트 판정(settlement, 순수)·충전 요청과 웹훅(service). Express를 모른다
//   engine/   답변 엔진 계약과 구현(Claude·목업), 시스템 지시. 실패는 코드·재시도 여부로만 말한다
//   events/   이벤트 로그 — 사건 기록 통로(sink). Express를 모른다
//   repo/     저장소 계약과 구현(메모리; W3에서 Postgres)
//   origin.ts 오리진 규칙(설정 해석·시드 검증·Origin 검사가 함께 쓴다)
//   report.ts 예외 보고 통로(reportError). index.ts가 Sentry를 꽂는다
//   @qrate/contracts  위젯과 함께 쓰는 전송 계약(경로, SSE 이벤트, 오류 본문)
// 이 파일은 조립만 한다. 프로세스 시작·Sentry·listen은 index.ts, 테스트는 이 함수로 앱을 만들어 임시 포트에 띄운다.

export interface AppOptions {
  engine: AnswerEngine;
  repos: Repositories;
  /** 브라우저에 보이는 이 서버의 오리진(scheme://host[:port]). 대화 API는 이 오리진의 문서(iframe)에서 온 요청만 받는다. */
  publicOrigin: string;
  /** 대화창 앱 정적 파일(app.js·app.css)이 있는 디렉터리. 위젯 패키지의 빌드 산출물 dist/frame. (index.ts가 찾는다) */
  frameAssetsDir: string;
  sentryEnabled?: boolean;
  /** 사건 기록 통로. 기본은 저장소(repos.events)에 쓰는 통로. index.ts는 stdout 미러를 켠 것을 넣고, 테스트는 가로챈다. */
  recordEvent?: EventSink;
  /** 처리 중 예외(턴 저장 실패, 예상 밖 엔진 실패, 라우트 예외)의 보고 통로. index.ts가 Sentry를 꽂고, 테스트는 가로챈다. 기본은 stderr. */
  reportError?: ErrorReporter;
  /**
   * 운영 콘솔 API. secret은 세션 토큰의 서명 비밀(QRATE_CONSOLE_SECRET, 16자 이상). 없으면 콘솔 API를 올리지 않는다(/api/console/* → 404).
   * loginAttempts는 IP당 로그인 시도 제한(기본 10회/분) — 테스트가 줄여서 쓴다.
   */
  console?: { secret: string; loginAttempts?: { max: number; windowMs: number } };
  /** 콘솔 앱 정적 파일(index.html·assets/)의 디렉터리 — @qrate/console 빌드 산출물 dist. 없으면 콘솔 페이지는 서빙하지 않는다(API만). */
  consoleAssetsDir?: string;
  /** 상담원 연결 요청(POST /api/handoff)의 IP당 요율 제한. 기본 20회/분. 테스트가 줄여서 쓴다. */
  handoffRequests?: { max: number; windowMs: number };
  /** 위젯 사건(POST /api/events)의 IP당 요율 제한. 기본 30회/분. 테스트가 줄여서 쓴다. */
  eventRequests?: { max: number; windowMs: number };
  payments?: PaymentProviders;
}

export function createApp({
  engine,
  repos,
  publicOrigin,
  frameAssetsDir,
  sentryEnabled = false,
  recordEvent: recordEventOption,
  reportError = reportToStderr,
  console: consoleOptions,
  consoleAssetsDir,
  handoffRequests,
  eventRequests,
  payments = {},
}: AppOptions): express.Express {
  const app = express();
  // Express 기본 `X-Powered-By: Express` 헤더를 끈다. 서버 구현을 알리는 정보일 뿐 기능이 없고,
  // 알려진 취약점이 있는 버전을 고르는 데 쓰일 수 있다. (PR #9 컨테이너 점검에서 확인)
  app.disable('x-powered-by');
  const chat = createChatService({ engine, repos, reportError });
  const billing = createBillingService({ repos, providers: payments, reportError });
  const recordEvent = recordEventOption ?? createEventSink({ repo: repos.events, reportError });

  // CORS 헤더는 없다 (W1의 전체 허용 `*` 제거 — 테넌트 검증 단계).
  // 대화 API를 부르는 브라우저 문서는 이 서버 오리진의 iframe 하나뿐이라(ADR-0003 하이브리드) 같은 오리진 요청이고,
  // 다른 오리진의 페이지가 부르면 브라우저가 preflight에서 막는 데 더해 아래 requireOwnOrigin이 서버 쪽에서 403으로 끊는다.

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, sentry: sentryEnabled, engine: engine.name, model: engine.model });
  });

  // 대화창 앱의 정적 파일(/frame/app.js 등). 파일 이름에 해시가 없으므로 매번 재검증(ETag)하게 한다 — 배포 뒤 옛 번들이 남지 않게.
  // /frame 자체(파일 없음)는 아래 문서 핸들러로 넘어간다. redirect: false — 기본값이면 /frame?t= 을 /frame/ 로 돌려보낸다.
  app.use(FRAME_PATH, express.static(frameAssetsDir, { index: false, redirect: false, maxAge: 0 }));

  // 대화창 문서. 어느 고객 사이트가 iframe으로 넣을 수 있는지는 이 응답의 CSP frame-ancestors가 정한다. (http/frame.ts)
  app.get(FRAME_PATH, createFrameHandler({ repos }));

  // 대화 API. 순서가 곧 비용 순서다: Origin 검사(헤더만 봄) → 본문 파싱(32kb 상한) → 처리.
  app.post(
    CHAT_PATH,
    requireOwnOrigin(publicOrigin),
    express.json({ limit: '32kb' }), // 채팅 입력에 32kb면 충분 — 과대 페이로드 차단
    createChatHandler({ chat, recordEvent, reportError }),
  );

  // 상담원 연결 요청. 대화 API와 같은 Origin 검사 뒤 요율 제한 → 본문 → 처리(http/handoff.ts). 콘솔 큐의 방문자 항목이 된다.
  app.post(
    HANDOFF_PATH,
    requireOwnOrigin(publicOrigin),
    ...createHandoffRoute({ repos, ...(handoffRequests ? { requestLimit: handoffRequests } : {}) }),
  );

  // 위젯 사건(대화창의 widget_open). 상담원 연결과 같은 순서: Origin 검사 → 요율 제한(자기 카운터) → 본문 → 처리(http/events.ts).
  app.post(
    EVENTS_PATH,
    requireOwnOrigin(publicOrigin),
    ...createEventRoute({ repos, recordEvent, ...(eventRequests ? { requestLimit: eventRequests } : {}) }),
  );

  app.post(PAYMENT_WEBHOOK_ROUTE, ...createWebhookRoute(billing));

  // 콘솔 페이지(/console/, http/console/static.ts)와 콘솔 API(http/console/router.ts). 페이지는 로그인 전에도 내려가고 데이터는 API에서 온다.
  if (consoleAssetsDir) app.use(CONSOLE_PATH, consoleStatic(consoleAssetsDir));
  if (consoleOptions) {
    const sessions = createSessionCodec(consoleOptions.secret);
    const loginAttempts = consoleOptions.loginAttempts ? { loginAttempts: consoleOptions.loginAttempts } : {};
    app.use(CONSOLE_API_PATH, createConsoleRouter({ repos, publicOrigin, sessions, ...loginAttempts, billing, providers: payments }));
  }

  // 계약 밖의 실패도 계약의 오류 본문(JSON)으로 답한다(http/errors.ts). 라우터들 뒤에 있어야 한다.
  app.use(notFound);
  app.use(createErrorHandler(reportError));

  return app;
}
