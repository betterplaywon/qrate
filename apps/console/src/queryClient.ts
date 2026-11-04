import type { ConsoleTenant } from '@qrate/contracts';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

// react-query 클라이언트와 전역 규칙. 어느 요청이든 401이 오면 세션 쿼리(me)를 null로 바꿔 화면이 로그인으로 돌아간다.
// 재시도는 하지 않는다 — 401은 "로그인 필요"라는 뜻이고, 그 밖의 실패를 조용히 반복할 이유가 없다.

export const ME_KEY = ['me'] as const;

const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  queryCache: new QueryCache({ onError: (err) => signOutOn401(err) }),
  mutationCache: new MutationCache({ onError: (err) => signOutOn401(err) }),
});

function signOutOn401(err: unknown): void {
  if (err instanceof ApiError && err.status === 401) client.setQueryData<ConsoleTenant | null>(ME_KEY, null);
}

export const queryClient = client;
