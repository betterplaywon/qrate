import type { ConsoleTenant } from '@qrate/contracts';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

// react-query 클라이언트와 전역 규칙. 어느 요청이든 401이 오면 로그아웃과 같이 세션을 끝낸다(signOut) — 화면이 로그인으로 돌아간다.
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

/**
 * 세션을 끝낸다. me를 null로 바꾸면 화면이 로그인으로 가고, 나머지 쿼리는 지운다 —
 * 다른 테넌트로 다시 로그인해도 이전 테넌트의 데이터가 잠깐이라도 보이지 않게. 로그아웃과 401이 같이 쓴다.
 */
export function signOut(client: QueryClient): void {
  client.setQueryData<ConsoleTenant | null>(ME_KEY, null);
  client.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
}

function signOutOn401(err: unknown): void {
  if (err instanceof ApiError && err.status === 401) signOut(queryClient);
}

queryCache.config.onError = signOutOn401;
mutationCache.config.onError = signOutOn401;
