import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  type ApiErrorBody,
  type SimulatePaymentResponse,
  type TopUpListResponse,
} from '@qrate/contracts';
import { createTopUpSchema, idempotencyKeySchema, simulatePaymentSchema } from '@qrate/contracts/schemas';
import { Router, type RequestHandler } from 'express';
import type { PaymentProviders } from '../../billing/provider.js';
import type { BillingService } from '../../billing/service.js';
import type { Repositories } from '../../repo/types.js';
import { toTopUpDto } from './dto.js';
import { parseListQuery, withCursorErrors } from './query.js';
import { tenantIdOf } from './session.js';

// 콘솔의 충전(/api/console/top-ups). 계약은 @qrate/contracts/console.ts. router.ts가 세션·Origin·본문 미들웨어를 넘긴다.
// 재요청 응답은 상태·본문이 첫 요청과 같고 Idempotent-Replayed 헤더로만 구분한다 — 재시도한 클라이언트가 두 응답을 같은 것으로 다루게.

export interface TopUpRoutesOptions {
  repos: Repositories;
  billing: BillingService;
  providers: PaymentProviders;
  session: RequestHandler;
  ownOrigin: RequestHandler;
  json: RequestHandler;
}

export function createTopUpRoutes({ repos, billing, providers, session, ownOrigin, json }: TopUpRoutesOptions): Router {
  const router = Router();

  router.get('/', session, async (req, res) => {
    const query = parseListQuery(req.query, res);
    if (!query) return;
    const page = await withCursorErrors(res, () => repos.topUps.list(tenantIdOf(res), { limit: query.limit, cursor: query.cursor }));
    if (!page) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ provider: billing.provider, items: page.items.map(toTopUpDto), nextCursor: page.nextCursor } satisfies TopUpListResponse);
  });

  router.post('/', session, ownOrigin, json, async (req, res) => {
    const key = idempotencyKeySchema.safeParse(req.get(IDEMPOTENCY_KEY_HEADER));
    if (!key.success) {
      res.status(400).json({ error: 'invalid_idempotency_key' } satisfies ApiErrorBody);
      return;
    }
    const body = createTopUpSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_package' } satisfies ApiErrorBody);
      return;
    }
    const result = await billing.requestTopUp(tenantIdOf(res), { requestKey: key.data, packageId: body.data.packageId });
    switch (result.status) {
      case 'created':
        res.status(201).json(toTopUpDto(result.topUp));
        return;
      case 'replayed':
        res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
        res.status(201).json(toTopUpDto(result.topUp));
        return;
      case 'key_reused':
        res.status(422).json({ error: 'idempotency_key_reused' } satisfies ApiErrorBody);
        return;
      case 'unknown_package':
        res.status(400).json({ error: 'invalid_package' } satisfies ApiErrorBody);
        return;
      case 'unavailable':
        res.status(503).json({ error: 'payments_unavailable' } satisfies ApiErrorBody);
        return;
    }
  });

  // 결제 시뮬레이션 — 모의 제공자가 서명한 웹훅을 웹훅 경로와 같은 receiveWebhook에 넣는다. 서명 검증도 그대로 지난다.
  const { mock } = providers;
  if (mock) {
    router.post('/:id/simulate', session, ownOrigin, json, async (req, res) => {
      const body = simulatePaymentSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'invalid_result' } satisfies ApiErrorBody);
        return;
      }
      const topUp = await repos.topUps.findForTenant(String(req.params.id), tenantIdOf(res));
      if (!topUp) {
        res.status(404).json({ error: 'not_found' } satisfies ApiErrorBody);
        return;
      }
      const webhook = mock.signEvent({ orderId: topUp.id, amount: topUp.amount, result: body.data.result }, new Date());
      const result = await billing.receiveWebhook(mock.name, webhook);
      if (result.status === 'settled') {
        const { outcome, replayed, topUp: after } = result.result;
        res.json({ outcome, replayed, topUp: toTopUpDto(after) } satisfies SimulatePaymentResponse);
        return;
      }
      if (result.status === 'ignored') {
        res.json({ outcome: result.reason, replayed: false, topUp: toTopUpDto(topUp) } satisfies SimulatePaymentResponse);
        return;
      }
      // 방금 같은 비밀로 서명한 웹훅이 거절됐다면 프로그래밍 오류다. 오류 핸들러(500 + 보고)로 보낸다.
      throw new Error(`mock webhook not accepted: ${result.status}`);
    });
  }

  return router;
}
