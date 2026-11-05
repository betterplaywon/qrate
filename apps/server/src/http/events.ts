import { type ApiErrorBody, type ApiErrorCode } from '@qrate/contracts';
import { widgetEventSchema } from '@qrate/contracts/schemas';
import express, { type RequestHandler } from 'express';
import type { EventSink } from '../events/sink.js';
import { findVariant, type GreetingExperiment } from '../greeting/experiment.js';
import type { Repositories } from '../repo/types.js';
import { jsonRateLimit } from './rate-limit.js';

// POST /api/events — 대화창이 보낸 위젯 사건(계약 @qrate/contracts/events.ts).
//
// 공개 엔드포인트가 DB에 행을 만든다. 막는 것은 상담원 연결(handoff.ts)과 같다: 같은 오리진의 대화창만(app.ts의 requireOwnOrigin),
// IP당 요율 제한(자기 카운터), 본문 모양(zod — 종류는 화이트리스트), 테넌트 존재.
// 브라우저 밖의 호출(curl)은 공개 키만 알면 사건을 꾸밀 수 있다. 그래서 위젯 사건은 콘솔에서 "방문자 브라우저가 보고한 수"로만
// 보이고 서버 사건(TTFT·해결률)과 비율을 만들지 않는다.

const DEFAULT_REQUEST_LIMIT = { max: 30, windowMs: 60_000 };

/** 어느 항목이 틀렸는지 → 오류 코드. 종류가 먼저(서버 사건을 밖에서 쓰려는 시도도 여기), 나머지는 테넌트. */
function bodyError(issues: readonly { path: PropertyKey[] }[]): ApiErrorCode {
  return issues.some((i) => i.path[0] === 'type') ? 'invalid_event' : 'tenant is required';
}

export interface EventRouteOptions {
  repos: Pick<Repositories, 'tenants'>;
  recordEvent: EventSink;
  /** 사건의 variant를 대조할 인사말 실험. null이면 variant는 언제나 null로 남는다. */
  greeting: GreetingExperiment | null;
  /**
   * IP당 고정 창 요율 제한. 기본 30회/분 — 방문자 한 명은 페이지 로드당 최대 2건(첫 열림·첫 질문)이라 NAT 뒤 여럿을 견딘다.
   * 테스트가 줄여서 쓴다.
   */
  requestLimit?: { max: number; windowMs: number };
}

/** Origin 검사 뒤에 붙는 핸들러 묶음: 요율 제한 → JSON 본문(1kb) → 처리. 저장은 기다리지 않는다 — 202가 그 뜻이다. */
export function createEventRoute({ repos, recordEvent, greeting, requestLimit = DEFAULT_REQUEST_LIMIT }: EventRouteOptions): RequestHandler[] {
  const limiter = jsonRateLimit({ ...requestLimit, code: 'too_many_requests' });

  const handler: RequestHandler = async (req, res) => {
    const parsed = widgetEventSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: bodyError(parsed.error.issues) } satisfies ApiErrorBody);
      return;
    }
    const tenant = await repos.tenants.findByKey(parsed.data.tenant);
    if (!tenant) {
      res.status(404).json({ error: 'unknown_tenant' } satisfies ApiErrorBody);
      return;
    }
    // 지금 실험의 변형이 아닌 값(옛 탭의 대화창, 실험을 바꾼 직후, 꾸민 값)은 400이 아니라 null — 열림·질문 수는 지키고 변형만 버린다.
    const variant = greeting ? (findVariant(greeting, parsed.data.variant)?.id ?? null) : null;
    recordEvent({ type: parsed.data.type, tenantId: tenant.id, conversationId: null, variant, createdAt: new Date(), payload: {} });
    res.status(202).end();
  };

  return [limiter, express.json({ limit: '1kb' }), handler];
}
