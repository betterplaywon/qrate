import { IDEMPOTENT_REPLAYED_HEADER, type ApiErrorBody, type WebhookAckBody } from '@qrate/contracts';
import express, { type RequestHandler } from 'express';
import type { BillingService } from '../billing/service.js';

// 요율 제한은 두지 않는다 — 서명 확인 전에 드는 비용은 HMAC 한 번이다.
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
    }
  };
  return [express.raw({ type: () => true, limit: '16kb' }), handler];
}
