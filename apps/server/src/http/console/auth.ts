import { consoleLoginSchema } from '@qrate/contracts/schemas';
import { verifyConsoleKey } from '../../console/key.js';
import type { Repositories, Tenant } from '../../repo/types.js';

// 로그인 = 테넌트 키(공개) + 콘솔 비밀키(scrypt 해시와 대조). 실패 지점(본문 모양, 모르는 테넌트, 키 불일치)을 나누지 않는다 —
// 어느 경우든 null이고 라우터는 같은 401을 낸다. 나누면 클라이언트 분기만 늘고 얻는 것이 없다.

/** 로그인에 성공한 테넌트. 키가 맞았다는 것은 해시가 있었다는 뜻이라, 세션의 지문을 만들 해시를 타입으로 보장한다. */
export type AuthenticatedTenant = Tenant & { consoleKeyHash: string };

export async function authenticate(repos: Repositories, body: unknown): Promise<AuthenticatedTenant | null> {
  const parsed = consoleLoginSchema.safeParse(body);
  if (!parsed.success) return null;
  const tenant = await repos.tenants.findByKey(parsed.data.tenant);
  const keyHash = tenant?.consoleKeyHash;
  if (!tenant || !keyHash) return null;
  const ok = await verifyConsoleKey(parsed.data.key, keyHash);
  return ok ? { ...tenant, consoleKeyHash: keyHash } : null;
}
