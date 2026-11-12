import { WIDGET_SCRIPT_PATH, type ApiErrorBody, type InstallStatusResponse } from '@qrate/contracts';
import { updateAllowedOriginsSchema } from '@qrate/contracts/schemas';
import { Router, type RequestHandler } from 'express';
import { isOriginString } from '../../origin.js';
import type { Repositories, Tenant } from '../../repo/types.js';
import { tenantOf } from './session.js';

// 설치 안내: 설치 스니펫 재료, 허용 사이트, 설치 확인(대화창이 마지막으로 열린 때). 계약은 @qrate/contracts/console.ts.
// 허용 사이트는 대화창 응답의 CSP frame-ancestors에 글자 그대로 들어가서(http/frame.ts) 정규형 오리진만 받는다.
// 바꾼 목록은 다음 대화창 요청부터 쓰인다. frame.ts가 요청마다 테넌트를 읽는다.

export interface InstallRoutesOptions {
  repos: Repositories;
  /** 설치 스니펫의 스크립트 주소가 이 오리진의 WIDGET_SCRIPT_PATH다(app.ts가 그 경로로 런처를 준다). */
  publicOrigin: string;
  session: RequestHandler;
  ownOrigin: RequestHandler;
  json: RequestHandler;
}

export function createInstallRoutes({ repos, publicOrigin, session, ownOrigin, json }: InstallRoutesOptions): Router {
  const router = Router();
  const scriptUrl = `${publicOrigin}${WIDGET_SCRIPT_PATH}`;

  const status = async ({ id, apiKey, allowedOrigins }: Tenant): Promise<InstallStatusResponse> => {
    const lastOpenedAt = await repos.events.lastAt(id, 'widget_open');
    return { tenantKey: apiKey, scriptUrl, allowedOrigins, lastOpenedAt: lastOpenedAt?.toISOString() ?? null };
  };

  router.get('/', session, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await status(tenantOf(res)));
  });

  router.put('/origins', session, ownOrigin, json, async (req, res) => {
    const body = updateAllowedOriginsSchema.safeParse(req.body);
    if (!body.success || !body.data.origins.every(isOriginString)) {
      res.status(400).json({ error: 'invalid_origins' } satisfies ApiErrorBody);
      return;
    }
    const tenant = tenantOf(res);
    const allowedOrigins = [...new Set(body.data.origins)];
    // 세션을 확인한 뒤 회사가 사라졌을 때만 false다. 그 세션은 다음 요청에서도 401이므로 같은 답을 준다.
    if (!(await repos.tenants.setAllowedOrigins(tenant.id, allowedOrigins))) {
      res.status(401).json({ error: 'unauthorized' } satisfies ApiErrorBody);
      return;
    }
    res.json(await status({ ...tenant, allowedOrigins }));
  });

  return router;
}
