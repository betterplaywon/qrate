import {
  CONSOLE_API_PATH,
  type ApiErrorBody,
  type ApiErrorCode,
  type ConsoleSessionResponse,
  type ConversationDetailResponse,
  type ConversationListResponse,
  type ConversationSummaryDto,
  type HandoffDto,
  type HandoffListResponse,
  type HandoffQueueItemDto,
  type MessageDto,
} from '@qrate/contracts';
import { consoleListQuerySchema, consoleLoginSchema, updateHandoffSchema } from '@qrate/contracts/schemas';
import { parseCookie, stringifySetCookie } from 'cookie';
import express, { Router, type RequestHandler, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { verifyConsoleKey } from '../console/key.js';
import type { SessionCodec } from '../console/session.js';
import { requireOwnOrigin } from '../origin.js';
import {
  InvalidCursorError,
  type Conversation,
  type ConversationSummary,
  type HandoffQueueItem,
  type HandoffRecord,
  type Repositories,
} from '../repo/types.js';

// 운영 콘솔 API(/api/console/*). 계약은 @qrate/contracts/console.ts, 본문·쿼리 모양은 @qrate/contracts/schemas(zod — 콘솔 폼과 공유).
//
// 인증(콘솔 결정 2026-11-04, A): 로그인 = 테넌트 키(공개) + 콘솔 비밀키(scrypt 해시와 대조). 성공하면 서명된 세션 토큰(JWT)을
// HttpOnly 쿠키로 준다. 쿠키는 Path=/api/console(이 API에만 실린다), SameSite=Strict(다른 사이트에서 시작한 요청에는 안 실린다),
// 공개 오리진이 https면 Secure. 상태를 바꾸는 요청(login·logout·PATCH)은 대화 API와 같은 Origin 검사를 한 번 더 받는다 —
// SameSite가 없는 옛 브라우저와 꾸민 요청을 서버 쪽에서도 막는다. 읽기(GET)는 쿠키만으로 — 다른 오리진의 페이지는 CORS 헤더가
// 없어 응답을 읽을 수 없고, 쿠키도 SameSite 때문에 실리지 않는다.
//
// 테넌트 경계: 세션의 tenantId가 모든 조회·변경의 WHERE 조건이다. 다른 테넌트의 id는 "없음"(404)으로 답한다 — 존재 여부도 알리지 않는다.
// 로그인 실패는 테넌트가 없든 키가 틀리든 같은 401이고, 시도는 IP당 분당 횟수로 제한한다(express-rate-limit, 프로세스 메모리).

export const SESSION_COOKIE = 'qrate_console';
const DEFAULT_LOGIN_ATTEMPTS = { max: 10, windowMs: 60_000 };

export interface ConsoleRouterOptions {
  repos: Repositories;
  /** 브라우저에 보이는 서버 오리진. Origin 검사의 기준이고, https면 쿠키에 Secure를 붙인다. */
  publicOrigin: string;
  sessions: SessionCodec;
  /** 로그인 시도 제한(IP당 고정 창). 기본 10회/분. 테스트가 줄여서 쓴다. */
  loginAttempts?: { max: number; windowMs: number };
}

export function createConsoleRouter({ repos, publicOrigin, sessions, loginAttempts = DEFAULT_LOGIN_ATTEMPTS }: ConsoleRouterOptions): Router {
  const router = Router();
  const ownOrigin = requireOwnOrigin(publicOrigin);
  const secure = publicOrigin.startsWith('https:');
  const session = requireSession(sessions);
  const json = express.json({ limit: '4kb' });
  // 무차별 대입을 늦춘다. 키 검증(scrypt)이 한 번에 수십 ms라 이미 느리지만, 병렬로 밀어붙이는 것은 창으로 막는다.
  // 프록시 뒤에서는 app.set('trust proxy', …)가 있어야 req.ip가 실제 클라이언트다 — 지금 배포는 프록시가 없다.
  const loginLimiter = rateLimit({
    windowMs: loginAttempts.windowMs,
    limit: loginAttempts.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'too_many_attempts' } satisfies ApiErrorBody);
    },
  });

  router.post('/login', ownOrigin, loginLimiter, json, async (req, res) => {
    // 모양이 틀린 본문도 401 — 실패 이유를 나누면 클라이언트 분기만 늘고 얻는 것이 없다.
    const body = consoleLoginSchema.safeParse(req.body);
    const tenant = body.success ? await repos.tenants.findByKey(body.data.tenant) : null;
    const ok = tenant && body.success ? await verifyConsoleKey(body.data.key, tenant.consoleKeyHash) : false;
    if (!tenant || !ok) {
      res.status(401).json({ error: 'invalid_credentials' } satisfies ApiErrorBody);
      return;
    }
    res.setHeader('Set-Cookie', sessionCookie(await sessions.issue(tenant.id), { secure, maxAgeSec: Math.floor(sessions.ttlMs / 1000) }));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ tenant: { id: tenant.id, name: tenant.name } } satisfies ConsoleSessionResponse);
  });

  router.post('/logout', ownOrigin, (_req, res) => {
    res.setHeader('Set-Cookie', sessionCookie('', { secure, maxAgeSec: 0 }));
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
    const page = await listOr400(res, () =>
      repos.conversations.listByTenant(tenantIdOf(res), { limit: query.limit, cursor: query.cursor ?? null }),
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
    const page = await listOr400(res, () =>
      repos.handoffs.list(tenantIdOf(res), {
        ...(query.status ? { status: query.status } : {}),
        limit: query.limit,
        cursor: query.cursor ?? null,
      }),
    );
    if (!page) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: page.items.map(toQueueDto), nextCursor: page.nextCursor } satisfies HandoffListResponse);
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

  return router;
}

/** 쿠키의 세션 토큰을 검증하고 테넌트 id를 res.locals에 둔다. 없거나 틀리거나 만료면 401 — 이유는 구분하지 않는다. */
function requireSession(sessions: SessionCodec): RequestHandler {
  return async (req, res, next) => {
    const token = parseCookie(req.headers.cookie ?? '')[SESSION_COOKIE];
    const session = token ? await sessions.verify(token) : null;
    if (!session) {
      res.status(401).json({ error: 'unauthorized' } satisfies ApiErrorBody);
      return;
    }
    res.locals.tenantId = session.tenantId;
    next();
  };
}

function tenantIdOf(res: Response): string {
  const id: unknown = res.locals.tenantId;
  if (typeof id !== 'string' || !id) throw new Error('console session missing — requireSession must run first');
  return id;
}

export function sessionCookie(token: string, { secure, maxAgeSec }: { secure: boolean; maxAgeSec: number }): string {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: token,
    path: CONSOLE_API_PATH,
    httpOnly: true,
    sameSite: 'strict',
    maxAge: maxAgeSec,
    secure,
  });
}

/** ?limit=&cursor=&status= — 틀린 값은 어느 항목이 틀렸는지에 따라 400 코드를 나눠 답하고 null. */
function parseListQuery(raw: unknown, res: Response): { limit: number; cursor?: string; status?: HandoffQueueItem['status'] } | null {
  const parsed = consoleListQuerySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path[0];
  const code: ApiErrorCode = field === 'status' ? 'invalid_status' : field === 'cursor' ? 'invalid_cursor' : 'invalid_limit';
  res.status(400).json({ error: code } satisfies ApiErrorBody);
  return null;
}

/** 목록 조회에서 깨진 커서는 400, 그 밖의 예외는 그대로 흘려 app.ts의 오류 핸들러(500 + 보고)로. */
async function listOr400<T>(res: Response, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      res.status(400).json({ error: 'invalid_cursor' } satisfies ApiErrorBody);
      return null;
    }
    throw err;
  }
}

function toSummaryDto(c: ConversationSummary): ConversationSummaryDto {
  return {
    id: c.id,
    createdAt: c.createdAt.toISOString(),
    messageCount: c.messageCount,
    handoffCount: c.handoffCount,
    preview: c.preview,
  };
}

function toDetailDto(c: Conversation): ConversationDetailResponse {
  return {
    id: c.id,
    createdAt: c.createdAt.toISOString(),
    messages: c.messages.map((m): MessageDto => ({ role: m.role, content: m.content, createdAt: m.createdAt.toISOString() })),
    handoffs: c.handoffs.map(toHandoffDto),
  };
}

function toHandoffDto(h: HandoffRecord): HandoffDto {
  return {
    id: h.id,
    source: h.source,
    reason: h.reason,
    summary: h.summary,
    contact: h.contact,
    status: h.status,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  };
}

function toQueueDto(h: HandoffQueueItem): HandoffQueueItemDto {
  return { ...toHandoffDto(h), conversationId: h.conversationId, preview: h.preview };
}
