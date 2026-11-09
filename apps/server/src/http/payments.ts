import { IDEMPOTENT_REPLAYED_HEADER, type ApiErrorBody, type WebhookAckBody } from '@qrate/contracts';
import express, { type RequestHandler } from 'express';
import type { BillingService } from '../billing/service.js';

// 요율 제한은 아직 두지 않는다(README '배포 전 할 일').
export function createWebhookRoute(billing: BillingService): RequestHandler[] {
  const handler: RequestHandler = async (req, res) => {
    // 본문이 없으면 파서가 req.body를 채우지 않는다.
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await billing.receiveWebhook(String(req.params.provider), { rawBody, headers: req.headers });
    switch (result.status) {
      case 'unknown_provider':
        res.status(404).json({ error: 'not_found' } satisfies ApiErrorBody);
        return;
      case 'rejected':
        if (result.reason === 'signature') res.status(401).json({ error: 'invalid_signature' } satisfies ApiErrorBody);
        else res.status(400).json({ error: 'invalid_webhook' } satisfies ApiErrorBody);
        return;
      case 'ignored':
        res.json({ outcome: result.reason } satisfies WebhookAckBody);
        return;
      case 'settled':
        if (result.result.replayed) res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
        res.json({ outcome: result.result.outcome } satisfies WebhookAckBody);
        return;
      case 'unsettled':
      case 'unverified':
        if (result.status === 'unsettled' && result.scope === 'open') {
          // 아직 끝나지 않은 결제는 다시 물으면 답이 바뀐다 — 토스가 다시 보내게 한다.
          res.status(503).json({ error: 'provider_unavailable' } satisfies ApiErrorBody);
          return;
        }
        // 200이어야 토스가 재전송을 멈춘다.
        res.json({ outcome: result.status } satisfies WebhookAckBody);
        return;
      case 'unavailable':
        // 토스가 다시 보낸다(최대 7회). 조회가 회복되면 그때 판정한다.
        res.status(503).json({ error: 'provider_unavailable' } satisfies ApiErrorBody);
        return;
    }
  };
  return [express.raw({ type: () => true, limit: '16kb' }), handler];
}
