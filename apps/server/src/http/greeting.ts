import type { ApiErrorBody, GreetingResponse } from '@qrate/contracts';
import { greetingQuerySchema } from '@qrate/contracts/schemas';
import type { RequestHandler } from 'express';
import { assignGreeting, type GreetingExperiment } from '../greeting/experiment.js';
import type { Repositories } from '../repo/types.js';

// GET /api/greeting — 대화창이 처음 뜰 때 묻는 인사말 배정(계약 @qrate/contracts/greeting.ts).
// 행을 만들지 않으므로 요율 제한은 없다. 비용은 /frame과 같은 테넌트 조회 하나다. 노출은 대화창이 /api/events의 widget_open에 싣는다.

export interface GreetingRouteOptions {
  repos: Pick<Repositories, 'tenants'>;
  /** null이면 실험 없음 — 언제나 { greeting: null }. */
  experiment: GreetingExperiment | null;
}

export function createGreetingHandler({ repos, experiment }: GreetingRouteOptions): RequestHandler {
  return async (req, res) => {
    const parsed = greetingQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'tenant is required' } satisfies ApiErrorBody);
      return;
    }
    const tenant = await repos.tenants.findByKey(parsed.data.tenant);
    if (!tenant) {
      res.status(404).json({ error: 'unknown_tenant' } satisfies ApiErrorBody);
      return;
    }
    // 첫 방문은 무작위다. 중간 캐시가 한 변형을 모두에게 돌려주면 안 된다.
    res.setHeader('Cache-Control', 'no-store');
    const variant = experiment && assignGreeting(experiment, parsed.data.variant, Math.random);
    res.json({ greeting: variant ? { variant: variant.id, text: variant.text } : null } satisfies GreetingResponse);
  };
}
