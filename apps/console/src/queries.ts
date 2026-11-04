import type { ConsoleLoginBody, ConsoleTenant, HandoffQueueItemDto, HandoffStatus } from '@qrate/contracts';
import { MutationCache, QueryCache, QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './api';

// 서버 상태는 전부 react-query가 든다 — 화면 컴포넌트에는 useEffect로 데이터를 끌어오는 코드가 없다.
// 세션(me)도 하나의 쿼리다: 값이 null이면 로그인 화면. 어느 요청이든 401이 오면 me를 null로 바꿔 화면이 로그인으로 돌아간다.

export const keys = {
  me: ['me'] as const,
  conversations: ['conversations'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  handoffs: (status: HandoffStatus) => ['handoffs', status] as const,
};

const signOutOn401 = (err: unknown): void => {
  if (err instanceof ApiError && err.status === 401) queryClient.setQueryData<ConsoleTenant | null>(keys.me, null);
};

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  queryCache: new QueryCache({ onError: signOutOn401 }),
  mutationCache: new MutationCache({ onError: signOutOn401 }),
});

/** 현재 세션의 테넌트. null = 로그인 필요. 로그인·로그아웃이 값을 직접 바꾸므로 다시 묻지 않는다. */
export function useMe() {
  return useQuery<ConsoleTenant | null>({
    queryKey: keys.me,
    queryFn: () =>
      api
        .me()
        .then((r) => r.tenant)
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) return null;
          throw err;
        }),
    staleTime: Infinity,
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ConsoleLoginBody) => api.login(body),
    onSuccess: ({ tenant }) => client.setQueryData<ConsoleTenant | null>(keys.me, tenant),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    // 서버가 쿠키를 지우지 못해도(네트워크) 화면은 로그아웃한다. me를 null로 바꾸면 화면이 로그인으로 가고,
    // 나머지 쿼리는 지운다 — 다른 테넌트로 다시 로그인해도 이전 테넌트의 데이터가 잠깐이라도 보이지 않게.
    onSettled: () => {
      client.setQueryData<ConsoleTenant | null>(keys.me, null);
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    },
  });
}

export function useConversations() {
  return useInfiniteQuery({
    queryKey: keys.conversations,
    queryFn: ({ pageParam }) => api.conversations(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useConversation(id: string) {
  return useQuery({ queryKey: keys.conversation(id), queryFn: () => api.conversation(id) });
}

export function useHandoffs(status: HandoffStatus) {
  return useInfiniteQuery({
    queryKey: keys.handoffs(status),
    queryFn: ({ pageParam }) => api.handoffs(status, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** 상태 전이. 끝나면 큐(모든 탭)와 그 대화의 상세를 다시 읽는다 — 옮긴 줄이 탭에서 빠지고 상세의 상태가 바뀐다. */
export function useUpdateHandoff() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: HandoffStatus }) => api.updateHandoff(id, status),
    onSuccess: (moved: HandoffQueueItemDto) =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['handoffs'] }),
        client.invalidateQueries({ queryKey: keys.conversation(moved.conversationId) }),
      ]),
  });
}
