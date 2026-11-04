import type { ConsoleTenant } from '@qrate/contracts';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

// react-query 클라이언트와 전역 규칙. 어느 요청이든 401이 오면 세션 쿼리(me)를 null로 바꿔 화면이 로그인으로 돌아간다.
// 재시도는 하지 않는다 — 401은 "로그인 필요"라는 뜻이고, 그 밖의 실패를 조용히 반복할 이유가 없다.
// 캐시의 onError가 클라이언트를 참조하므로, 캐시를 먼저 만들고 클라이언트를 만든 뒤 핸들러를 붙인다(서로 앞서 참조하지 않게).

export const ME_KEY = ['me'] as const;

const queryCache = new QueryCache();
const mutationCache = new MutationCache();

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  queryCache,
  mutationCache,
});

function signOutOn401(err: unknown): void {
  if (err instanceof ApiError && err.status === 401) queryClient.setQueryData<ConsoleTenant | null>(ME_KEY, null);
}

queryCache.config.onError = signOutOn401;
mutationCache.config.onError = signOutOn401;
