import { CHAT_PATH, FRAME_PATH, type ApiErrorBody, type ApiErrorCode } from '@qrate/contracts';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createChatService } from './chat/service.js';
import type { AnswerEngine } from './engine/types.js';
import { createChatHandler, type UsageLogger } from './http/chat.js';
import { createFrameHandler } from './http/frame.js';
import { requireOwnOrigin } from './origin.js';
import { reportToStderr, type ErrorReporter } from './report.js';
import type { Repositories } from './repo/types.js';

// 서버 구조 — 의존 방향은 바깥에서 안으로만 간다.
//   http/     Express 핸들러·미들웨어·SSE 전송. 본문 모양 검사, 상태 코드(엔진 실패 코드 → 상태 포함), 스트림 쓰기, 사용량 로그
//   chat/     대화 유스케이스 — 테넌트 확인, 모더레이션, 대화 이어 가기, 지식 선택, 턴 저장. Express를 모른다
//   engine/   답변 엔진 계약과 구현(Claude·목업), 시스템 지시. 실패는 코드·재시도 여부로만 말한다
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
  /** 테스트에서 로그를 가로채기 위한 주입점. 기본은 stdout JSON 한 줄. */
  logUsage?: UsageLogger;
  /** 처리 중 예외(턴 저장 실패, 예상 밖 엔진 실패, 라우트 예외)의 보고 통로. index.ts가 Sentry를 꽂고, 테스트는 가로챈다. 기본은 stderr. */
  reportError?: ErrorReporter;
}

export function createApp({
  engine,
  repos,
  publicOrigin,
  frameAssetsDir,
  sentryEnabled = false,
  logUsage,
  reportError = reportToStderr,
}: AppOptions): express.Express {
  const app = express();
  // Express 기본 `X-Powered-By: Express` 헤더를 끈다. 서버 구현을 알리는 정보일 뿐 기능이 없고,
  // 알려진 취약점이 있는 버전을 고르는 데 쓰일 수 있다. (PR #9 컨테이너 점검에서 확인)
  app.disable('x-powered-by');
  const chat = createChatService({ engine, repos, reportError });

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
    createChatHandler({ chat, logUsage, reportError }),
  );

  // 계약 밖의 실패도 계약의 오류 본문(JSON)으로 답한다. Express 기본 핸들러에 맡기면 HTML 페이지가 나가고,
  // 기본 핸들러는 오류 객체를 통째로 찍는데 body-parser의 오류 객체에는 요청 본문이 들어 있어 사용자 메시지가 로그에 남는다.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' } satisfies ApiErrorBody);
  });
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const failure = bodyParserFailure(err);
    if (failure) {
      res.status(failure.status).json({ error: failure.code } satisfies ApiErrorBody);
      return;
    }
    // 라우트가 던진 예외. Express 5는 async 핸들러의 거절도 여기로 보낸다. 본문은 넘기지 않는다.
    reportError(err, { where: 'express', method: req.method, path: req.path });
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({ error: 'internal_error' } satisfies ApiErrorBody);
  });

  return app;
}

/**
 * express.json(body-parser)의 실패인가. type과 4xx status가 함께 있으면 클라이언트 쪽 문제다 —
 * 32kb 초과는 413 그대로, 그 밖(JSON 아님, 문자셋·인코딩 미지원)은 400으로 답한다.
 */
function bodyParserFailure(err: unknown): { status: number; code: ApiErrorCode } | null {
  if (typeof err !== 'object' || err === null) return null;
  const { type, status } = err as { type?: unknown; status?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number' || status < 400 || status >= 500) return null;
  return type === 'entity.too.large' ? { status: 413, code: 'payload_too_large' } : { status: 400, code: 'invalid_json' };
}
