import express from 'express';
import { createChatHandler, type UsageLogger } from './chat.js';
import type { AnswerEngine } from './engine/types.js';
import type { Repositories } from './repo/types.js';

export interface AppOptions {
  engine: AnswerEngine;
  repos: Repositories;
  sentryEnabled?: boolean;
  /** 테스트에서 로그를 가로채기 위한 주입점. 기본은 stdout JSON 한 줄. */
  logUsage?: UsageLogger;
}

// 앱 조립은 index.ts(프로세스 시작·Sentry·listen)와 분리한다. 테스트는 이 함수로 앱을 만들어 임시 포트에 띄운다.
export function createApp({ engine, repos, sentryEnabled = false, logUsage }: AppOptions): express.Express {
  const app = express();
  app.use(express.json({ limit: '32kb' })); // 채팅 입력에 32kb면 충분 — 과대 페이로드 차단

  // CORS: W1 데모용 전체 허용.
  // 테넌트 검증 단계에서 대화 API는 위젯 서버 오리진의 iframe에서만 호출되므로(ADR-0003 하이브리드) 이 블록을 없앤다.
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'X-Conversation-Id');
    next();
  });
  app.options('/api/chat', (_req, res) => {
    res.sendStatus(204);
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, sentry: sentryEnabled, engine: engine.name, model: engine.model });
  });

  app.post('/api/chat', createChatHandler({ engine, repos, logUsage }));

  return app;
}
