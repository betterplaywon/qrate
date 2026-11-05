import type { ApiErrorBody } from '@qrate/contracts';
import type { RequestHandler, Response } from 'express';
import type { SessionCodec } from '../../console/session.js';
import { readSessionToken } from './cookie.js';

// 세션이 있어야 하는 라우트 앞의 미들웨어. 쿠키의 토큰을 검증하고 테넌트 id를 res.locals에 둔다.
// 없거나 틀리거나 만료면 401 — 이유는 구분하지 않는다(어느 쪽이든 다시 로그인).

export function requireSession(sessions: SessionCodec): RequestHandler {
  return async (req, res, next) => {
    const token = readSessionToken(req);
    const session = token ? await sessions.verify(token) : null;
    if (!session) {
      res.status(401).json({ error: 'unauthorized' } satisfies ApiErrorBody);
      return;
    }
    res.locals.tenantId = session.tenantId;
    next();
  };
}

/** requireSession이 둔 테넌트 id. 미들웨어 없이 불리면 프로그래밍 오류라 던진다. */
export function tenantIdOf(res: Response): string {
  const id: unknown = res.locals.tenantId;
  if (typeof id !== 'string' || !id) throw new Error('console session missing — requireSession must run first');
  return id;
}
