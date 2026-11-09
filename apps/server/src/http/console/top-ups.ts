import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  type ApiErrorBody,
  type ConfirmTopUpResponse,
  type SimulatePaymentResponse,
  type TopUpListResponse,
} from '@qrate/contracts';
import { confirmTopUpSchema, createTopUpSchema, idempotencyKeySchema, simulatePaymentSchema } from '@qrate/contracts/schemas';
import { Router, type RequestHandler } from 'express';
import type { PaymentProvider } from '../../billing/provider.js';
import type { BillingService } from '../../billing/service.js';
import type { Repositories } from '../../repo/types.js';
import { toCheckoutDto, toTopUpDto } from './dto.js';
import { parseListQuery, withCursorErrors } from './query.js';
import { tenantIdOf } from './session.js';

export interface TopUpRoutesOptions {
  repos: Repositories;
  billing: BillingService;
  /** 켜진 제공자. mock이면 /:id/simulate, toss면 /:id/confirm이 생긴다. */
  payments: PaymentProvider | null;
  session: RequestHandler;
  ownOrigin: RequestHandler;
  json: RequestHandler;
}

export function createTopUpRoutes({ repos, billing, payments, session, ownOrigin, json }: TopUpRoutesOptions): Router {
  const router = Router();

  router.get('/', session, async (req, res) => {
    const query = parseListQuery(req.query, res);
    if (!query) return;
    const page = await withCursorErrors(res, () => repos.topUps.list(tenantIdOf(res), { limit: query.limit, cursor: query.cursor }));
    if (!page) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...toCheckoutDto(payments), items: page.items.map(toTopUpDto), nextCursor: page.nextCursor } satisfies TopUpListResponse);
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

  if (payments?.name === 'mock') {
    const mock = payments;
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
      throw new Error(`mock webhook not accepted: ${result.status}`);
    });
  }

  // 요율 제한은 아직 두지 않는다(배포 전에 정한다). 확정 한 번이 부르는 토스는 최대 둘(승인 + 조회)이다.
  if (payments?.name === 'toss') {
    router.post('/:id/confirm', session, ownOrigin, json, async (req, res) => {
      const body = confirmTopUpSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'invalid_payment' } satisfies ApiErrorBody);
        return;
      }
      const result = await billing.confirmTopUp(tenantIdOf(res), { orderId: String(req.params.id), ...body.data });
      switch (result.status) {
        case 'not_found':
          res.status(404).json({ error: 'not_found' } satisfies ApiErrorBody);
          return;
        case 'mismatch':
          res.status(422).json({ error: 'payment_mismatch' } satisfies ApiErrorBody);
          return;
        case 'unconfirmed':
          res.json({ outcome: 'unconfirmed' } satisfies ConfirmTopUpResponse);
          return;
        case 'settled': {
          const { outcome, replayed, topUp } = result.result;
          res.json({ outcome, replayed, topUp: toTopUpDto(topUp) } satisfies ConfirmTopUpResponse);
          return;
        }
      }
    });
  }

  return router;
}
