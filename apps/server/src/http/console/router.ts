import {
  type ApiErrorBody,
  type ConsoleMetricsResponse,
  type ConsoleSessionResponse,
  type ConversationListResponse,
  type CreditsResponse,
  type HandoffListResponse,
} from '@qrate/contracts';
import { updateHandoffSchema } from '@qrate/contracts/schemas';
import express, { Router } from 'express';
import type { PaymentProvider } from '../../billing/provider.js';
import type { BillingService } from '../../billing/service.js';
import type { SessionCodec } from '../../console/session.js';
import { computeMetrics } from '../../events/metrics.js';
import type { GreetingExperiment } from '../../greeting/experiment.js';
import { requireOwnOrigin } from '../../origin.js';
import type { Repositories } from '../../repo/types.js';
import { jsonRateLimit } from '../rate-limit.js';
import { authenticate } from './auth.js';
import { sessionCookie } from './cookie.js';
import { toCreditDto, toDetailDto, toMetricsDto, toQueueDto, toSummaryDto } from './dto.js';
import { parseListQuery, withCursorErrors } from './query.js';
import { requireSession, tenantIdOf } from './session.js';
import { createTopUpRoutes } from './top-ups.js';

// 운영 콘솔 API(/api/console/*)의 라우터 — 조립만 한다. 계약은 @qrate/contracts/console.ts.
//   auth.ts     로그인(테넌트 키 + 콘솔 키 검증)
//   session.ts  세션 미들웨어(쿠키 → 테넌트 id)
//   cookie.ts   세션 쿠키 속성
//   query.ts    목록 쿼리 해석, 커서 오류
//   dto.ts      저장소 타입 → 응답
//   top-ups.ts  충전 요청·목록·결제 시뮬레이션
//
// 인증(콘솔 결정 2026-11-04, A): 성공하면 서명된 세션 토큰(JWT)을 HttpOnly 쿠키로 준다. 상태를 바꾸는 요청(login·logout·PATCH·POST)은
// 대화 API와 같은 Origin 검사를 한 번 더 받는다 — SameSite가 없는 옛 브라우저와 꾸민 요청을 서버 쪽에서도 막는다.
// 읽기(GET)는 쿠키만으로 — 다른 오리진의 페이지는 CORS 헤더가 없어 응답을 읽을 수 없고, 쿠키도 SameSite 때문에 실리지 않는다.
// 테넌트 경계: 세션의 tenantId가 모든 조회·변경의 WHERE 조건이다. 다른 테넌트의 id는 "없음"(404)으로 답한다 — 존재 여부도 알리지 않는다.
// 로그인 실패는 테넌트가 없든 키가 틀리든 같은 401이고, 시도는 IP당 분당 횟수로 제한한다.

const DEFAULT_LOGIN_ATTEMPTS = { max: 10, windowMs: 60_000 };

export interface ConsoleRouterOptions {
  repos: Repositories;
  /** 브라우저에 보이는 서버 오리진. Origin 검사의 기준이고, https면 쿠키에 Secure를 붙인다. */
  publicOrigin: string;
  sessions: SessionCodec;
  /** 로그인 시도 제한(IP당 고정 창). 기본 10회/분. 테스트가 줄여서 쓴다. */
  loginAttempts?: { max: number; windowMs: number };
  billing: BillingService;
  payments: PaymentProvider | null;
  /** 지표의 인사말 A/B가 보는 실험. 배정·사건 검증과 같은 값을 app.ts가 넘긴다. */
  greeting: GreetingExperiment | null;
}

export function createConsoleRouter({
  repos,
  publicOrigin,
  sessions,
  loginAttempts = DEFAULT_LOGIN_ATTEMPTS,
  billing,
  payments,
  greeting,
}: ConsoleRouterOptions): Router {
  const router = Router();
  const ownOrigin = requireOwnOrigin(publicOrigin);
  const session = requireSession(sessions);
  const json = express.json({ limit: '4kb' });
  const cookieOptions = { secure: publicOrigin.startsWith('https:') };
  // 무차별 대입을 늦춘다. 키 검증(scrypt)이 한 번에 수십 ms라 이미 느리지만, 병렬로 밀어붙이는 것은 창으로 막는다.
  const loginLimiter = jsonRateLimit({ ...loginAttempts, code: 'too_many_attempts' });

  router.post('/login', ownOrigin, loginLimiter, json, async (req, res) => {
    const tenant = await authenticate(repos, req.body);
    if (!tenant) {
      res.status(401).json({ error: 'invalid_credentials' } satisfies ApiErrorBody);
      return;
    }
    const token = await sessions.issue(tenant.id);
    res.setHeader('Set-Cookie', sessionCookie(token, { ...cookieOptions, maxAgeSec: Math.floor(sessions.ttlMs / 1000) }));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ tenant: { id: tenant.id, name: tenant.name } } satisfies ConsoleSessionResponse);
  });

  router.post('/logout', ownOrigin, (_req, res) => {
    res.setHeader('Set-Cookie', sessionCookie('', { ...cookieOptions, maxAgeSec: 0 }));
    res.status(204).end();
  });

  router.get('/me', session, async (_req, res) => {
    const tenant = await repos.tenants.findById(tenantIdOf(res));
    if (!tenant) {
      // 세션은 유효한데 테넌트가 사라졌다(삭제). 다시 로그인하게 한다.
      res.status(401).json({ error: 'unauthorized' } satisfies ApiErrorBody);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ tenant: { id: tenant.id, name: tenant.name } } satisfies ConsoleSessionResponse);
  });

  router.get('/conversations', session, async (req, res) => {
    const query = parseListQuery(req.query, res);
    if (!query) return;
    const page = await withCursorErrors(res, () =>
      repos.conversations.listByTenant(tenantIdOf(res), { limit: query.limit, cursor: query.cursor }),
    );
    if (!page) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: page.items.map(toSummaryDto), nextCursor: page.nextCursor } satisfies ConversationListResponse);
  });

  router.get('/conversations/:id', session, async (req, res) => {
    const conversation = await repos.conversations.find(String(req.params.id), tenantIdOf(res));
    if (!conversation) {
      res.status(404).json({ error: 'not_found' } satisfies ApiErrorBody);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(toDetailDto(conversation));
  });

  router.get('/handoffs', session, async (req, res) => {
    const query = parseListQuery(req.query, res);
    if (!query) return;
    const page = await withCursorErrors(res, () =>
      repos.handoffs.list(tenantIdOf(res), {
        ...(query.status ? { status: query.status } : {}),
        limit: query.limit,
        cursor: query.cursor,
      }),
    );
    if (!page) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: page.items.map(toQueueDto), nextCursor: page.nextCursor } satisfies HandoffListResponse);
  });

  router.get('/credits', session, async (req, res) => {
    const query = parseListQuery(req.query, res);
    if (!query) return;
    const tenantId = tenantIdOf(res);
    const page = await withCursorErrors(res, () => repos.credits.list(tenantId, { limit: query.limit, cursor: query.cursor }));
    if (!page) return;
    const balance = await repos.credits.balance(tenantId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ balance, items: page.items.map(toCreditDto), nextCursor: page.nextCursor } satisfies CreditsResponse);
  });

  // 창은 고정(최근 7일, 쿼리 없음)이다. 정의는 events/metrics.ts 한 곳.
  router.get('/metrics', session, async (_req, res) => {
    const metrics = await computeMetrics(repos, tenantIdOf(res), new Date(), greeting);
    res.setHeader('Cache-Control', 'no-store');
    res.json(toMetricsDto(metrics) satisfies ConsoleMetricsResponse);
  });

  router.patch('/handoffs/:id', session, ownOrigin, json, async (req, res) => {
    const body = updateHandoffSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_status' } satisfies ApiErrorBody);
      return;
    }
    const updated = await repos.handoffs.updateStatus(String(req.params.id), tenantIdOf(res), body.data.status);
    if (!updated) {
      res.status(404).json({ error: 'not_found' } satisfies ApiErrorBody);
      return;
    }
    res.json(toQueueDto(updated));
  });

  router.use('/top-ups', createTopUpRoutes({ repos, billing, payments, session, ownOrigin, json }));

  return router;
}
