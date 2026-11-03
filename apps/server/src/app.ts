import { CHAT_PATH, FRAME_PATH } from '@qrate/contracts';
import express from 'express';
import { createChatService } from './chat/service.js';
import type { AnswerEngine } from './engine/types.js';
import { createChatHandler, type UsageLogger } from './http/chat.js';
import { createFrameHandler } from './http/frame.js';
import { requireOwnOrigin } from './origin.js';
import type { Repositories } from './repo/types.js';

// 서버 구조 — 의존 방향은 바깥에서 안으로만 간다.
//   http/     Express 핸들러·미들웨어·SSE 전송. 본문 모양 검사, 상태 코드, 스트림 쓰기, 사용량 로그
//   chat/     대화 유스케이스 — 테넌트 확인, 모더레이션, 대화 이어 가기, 지식 선택, 답변 저장. Express를 모른다
//   engine/   답변 엔진 계약과 구현(Claude·목업), 시스템 지시
//   repo/     저장소 계약과 구현(메모리; W3에서 Postgres)
//   origin.ts 오리진 규칙(설정 해석·시드 검증·Origin 검사가 함께 쓴다)
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
}

export function createApp({
  engine,
  repos,
  publicOrigin,
  frameAssetsDir,
  sentryEnabled = false,
  logUsage,
}: AppOptions): express.Express {
  const app = express();
  // Express 기본 `X-Powered-By: Express` 헤더를 끈다. 서버 구현을 알리는 정보일 뿐 기능이 없고,
  // 알려진 취약점이 있는 버전을 고르는 데 쓰일 수 있다. (PR #9 컨테이너 점검에서 확인)
  app.disable('x-powered-by');
  const chat = createChatService({ engine, repos });

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
    createChatHandler({ chat, logUsage }),
  );

  return app;
}
