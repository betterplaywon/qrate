import type { ApiErrorBody } from '@qrate/contracts';
import type { RequestHandler, Response } from 'express';
import { consoleKeyFingerprint } from '../../console/key.js';
import type { SessionCodec } from '../../console/session.js';
import type { Tenant, TenantRepository } from '../../repo/types.js';
import { readSessionToken } from './cookie.js';

// 세션이 있어야 하는 라우트 앞의 미들웨어. 쿠키의 토큰을 검증하고, 테넌트의 지금 콘솔 키 지문이 세션의 지문과 같을 때만
// 테넌트 id를 res.locals에 둔다. 콘솔 키를 다시 발급하거나 회수하면 지문이 달라져 그 전 세션은 여기서 끝난다(요청마다 테넌트를 한 번 읽는다).
// 없거나 틀리거나 만료거나 지문이 다르면 401 — 이유는 구분하지 않는다(어느 쪽이든 다시 로그인).

export function requireSession(sessions: SessionCodec, tenants: Pick<TenantRepository, 'findById'>): RequestHandler {
  return async (req, res, next) => {
    const token = readSessionToken(req);
    const session = token ? await sessions.verify(token) : null;
    const tenant = session ? await tenants.findById(session.tenantId) : null;
    if (!session || !tenant?.consoleKeyHash || consoleKeyFingerprint(tenant.consoleKeyHash) !== session.keyFingerprint) {
      res.status(401).json({ error: 'unauthorized' } satisfies ApiErrorBody);
      return;
    }
    res.locals.tenantId = session.tenantId;
    res.locals.tenant = tenant;
    next();
  };
}

/** requireSession이 둔 테넌트 id. 미들웨어 없이 불리면 프로그래밍 오류라 던진다. */
export function tenantIdOf(res: Response): string {
  const id: unknown = res.locals.tenantId;
  if (typeof id !== 'string' || !id) throw new Error('console session missing — requireSession must run first');
  return id;
}

/** requireSession이 지문을 맞추려고 읽어 둔 테넌트. 같은 요청에서 다시 읽지 않는다. */
export function tenantOf(res: Response): Tenant {
  const tenant = res.locals.tenant as Tenant | undefined;
  if (!tenant) throw new Error('console session missing — requireSession must run first');
  return tenant;
}
