import { consoleLoginSchema } from '@qrate/contracts/schemas';
import { verifyConsoleKey } from '../../console/key.js';
import type { Repositories, Tenant } from '../../repo/types.js';

// 로그인 = 테넌트 키(공개) + 콘솔 비밀키(scrypt 해시와 대조). 실패 지점(본문 모양, 모르는 테넌트, 키 불일치)을 나누지 않는다 —
// 어느 경우든 null이고 라우터는 같은 401을 낸다. 나누면 클라이언트 분기만 늘고 얻는 것이 없다.

export async function authenticate(repos: Repositories, body: unknown): Promise<Tenant | null> {
  const parsed = consoleLoginSchema.safeParse(body);
  if (!parsed.success) return null;
  const tenant = await repos.tenants.findByKey(parsed.data.tenant);
  if (!tenant) return null;
  const ok = await verifyConsoleKey(parsed.data.key, tenant.consoleKeyHash);
  return ok ? tenant : null;
}
