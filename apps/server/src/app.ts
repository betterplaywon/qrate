import { CHAT_PATH, FRAME_PATH } from '@qrate/contracts';
import express from 'express';
import { createChatHandler, type UsageLogger } from './chat.js';
import type { AnswerEngine } from './engine/types.js';
import { createFrameHandler } from './frame.js';
import { requireOwnOrigin } from './origin.js';
import type { Repositories } from './repo/types.js';

export interface AppOptions {
  engine: AnswerEngine;
  repos: Repositories;
  /** 브라우저에 보이는 이 서버의 오리진(scheme://host[:port]). 대화 API는 이 오리진의 문서(iframe)에서 온 요청만 받는다. */
  publicOrigin: string;
  sentryEnabled?: boolean;
  /** 테스트에서 로그를 가로채기 위한 주입점. 기본은 stdout JSON 한 줄. */
  logUsage?: UsageLogger;
}

// 앱 조립은 index.ts(프로세스 시작·Sentry·listen)와 분리한다. 테스트는 이 함수로 앱을 만들어 임시 포트에 띄운다.
export function createApp({ engine, repos, publicOrigin, sentryEnabled = false, logUsage }: AppOptions): express.Express {
  const app = express();

  // CORS 헤더는 없다 (W1의 전체 허용 `*` 제거 — 테넌트 검증 단계).
  // 대화 API를 부르는 브라우저 문서는 이 서버 오리진의 iframe 하나뿐이라(ADR-0003 하이브리드) 같은 오리진 요청이고,
  // 다른 오리진의 페이지가 부르면 브라우저가 preflight에서 막는 데 더해 아래 requireOwnOrigin이 서버 쪽에서 403으로 끊는다.

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, sentry: sentryEnabled, engine: engine.name, model: engine.model });
  });

  // 대화창 문서. 어느 고객 사이트가 iframe으로 넣을 수 있는지는 이 응답의 CSP frame-ancestors가 정한다. (src/frame.ts)
  app.get(FRAME_PATH, createFrameHandler({ repos }));

  // 대화 API. 순서가 곧 비용 순서다: Origin 검사(헤더만 봄) → 본문 파싱(32kb 상한) → 처리.
  app.post(
    CHAT_PATH,
    requireOwnOrigin(publicOrigin),
    express.json({ limit: '32kb' }), // 채팅 입력에 32kb면 충분 — 과대 페이로드 차단
    createChatHandler({ engine, repos, logUsage }),
  );

  return app;
}
