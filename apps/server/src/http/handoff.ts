import { type ApiErrorBody, type ApiErrorCode, type HandoffRequestResponse } from '@qrate/contracts';
import { handoffRequestSchema } from '@qrate/contracts/schemas';
import express, { type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import type { Repositories } from '../repo/types.js';

// POST /api/handoff — 방문자의 상담원 연결 요청(계약 @qrate/contracts/handoff.ts). 콘솔 미응답 큐의 source=visitor 항목이 된다.
//
// 공개 엔드포인트가 DB에 행을 만든다. 막는 것: 같은 오리진의 대화창만(app.ts의 requireOwnOrigin — 대화 API와 같음),
// IP당 요율 제한(express-rate-limit), 본문 모양(zod — 이메일·길이), 테넌트 존재. 대화 id는 이 테넌트의 대화일 때만 쓰고
// 아니면 새로 만든다 — 남의 대화에 붙이거나 임의 id로 대화를 만들 수 없다.
// 브라우저 밖의 호출(curl)은 Origin 검사로 못 막는다(origin.ts 주석). 요율 제한이 그 비용을 누른다.

const DEFAULT_REQUEST_LIMIT = { max: 20, windowMs: 60_000 };

export interface HandoffRouteOptions {
  repos: Repositories;
  /** IP당 고정 창 요율 제한. 기본 20회/분. 테스트가 줄여서 쓴다. */
  requestLimit?: { max: number; windowMs: number };
}

/** Origin 검사 뒤에 붙는 핸들러 묶음: 요율 제한 → JSON 본문 → 처리. */
export function createHandoffRoute({ repos, requestLimit = DEFAULT_REQUEST_LIMIT }: HandoffRouteOptions): RequestHandler[] {
  const limiter = rateLimit({
    windowMs: requestLimit.windowMs,
    limit: requestLimit.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'too_many_requests' } satisfies ApiErrorBody);
    },
  });

  const handler: RequestHandler = async (req, res) => {
    const parsed = handoffRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: bodyError(parsed.error.issues) } satisfies ApiErrorBody);
      return;
    }
    const { tenant: tenantKey, conversationId: requestedId, contact, message } = parsed.data;
    const tenant = await repos.tenants.findByKey(tenantKey);
    if (!tenant) {
      res.status(404).json({ error: 'unknown_tenant' } satisfies ApiErrorBody);
      return;
    }
    const existing = requestedId ? await repos.conversations.find(requestedId, tenant.id, { lastMessages: 0 }) : null;
    const conversationId = existing?.id ?? randomUUID();
    const { id } = await repos.handoffs.requestByVisitor(conversationId, tenant.id, { contact, summary: message });
    res.status(201).json({ id, conversationId } satisfies HandoffRequestResponse);
  };

  return [limiter, express.json({ limit: '8kb' }), handler];
}

function bodyError(issues: readonly { path: PropertyKey[] }[]): ApiErrorCode {
  const field = issues[0]?.path[0];
  if (field === 'contact') return 'invalid_contact';
  if (field === 'message') return 'message_too_long';
  return 'tenant is required';
}
