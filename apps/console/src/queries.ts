import type {
  ConsoleLoginBody,
  ConsoleTenant,
  CreateTopUpBody,
  HandoffQueueItemDto,
  HandoffStatus,
  PaymentResult,
} from '@qrate/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './api';
import { ME_KEY } from './queryClient';
import { clearTossReturn, openTossPaymentWindow, type TossSuccess } from './toss';

// 서버 상태는 전부 react-query가 든다 — 화면 컴포넌트에는 useEffect로 데이터를 끌어오는 코드가 없다.
// 세션(me)도 하나의 쿼리다: 값이 null이면 로그인 화면. 401 처리는 queryClient.ts.

export const keys = {
  me: ME_KEY,
  conversations: ['conversations'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  handoffs: (status: HandoffStatus) => ['handoffs', status] as const,
  credits: ['credits'] as const,
  topUps: ['topUps'] as const,
  topUpConfirm: (paymentKey: string) => ['topUpConfirm', paymentKey] as const,
  metrics: ['metrics'] as const,
};

/** 세션 조회. 401은 오류가 아니라 "로그인 필요"(null)다. */
async function fetchMe(): Promise<ConsoleTenant | null> {
  try {
    return (await api.me()).tenant;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** 현재 세션의 테넌트. null = 로그인 필요. 로그인·로그아웃이 값을 직접 바꾸므로 다시 묻지 않는다. */
export function useMe() {
  return useQuery<ConsoleTenant | null>({ queryKey: keys.me, queryFn: fetchMe, staleTime: Infinity });
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

export function useCredits() {
  return useInfiniteQuery({
    queryKey: keys.credits,
    queryFn: ({ pageParam }) => api.credits(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useMetrics() {
  return useQuery({ queryKey: keys.metrics, queryFn: api.metrics });
}

export function useTopUps() {
  return useInfiniteQuery({
    queryKey: keys.topUps,
    queryFn: ({ pageParam }) => api.topUps(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useCreateTopUp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ body, key }: { body: CreateTopUpBody; key: string }) => api.createTopUp(body, key),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.topUps }),
  });
}

export function useSimulatePayment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, result }: { id: string; result: PaymentResult }) => api.simulatePayment(id, { result }),
    onSuccess: () =>
      Promise.all([client.invalidateQueries({ queryKey: keys.topUps }), client.invalidateQueries({ queryKey: keys.credits })]),
  });
}

/** 확정 결과가 정해진 실패(본문 형식·없는 주문·주문과 다른 결제). 그 밖(네트워크·5xx·401)은 같은 결제로 다시 물을 수 있게 주소를 남긴다. */
const SETTLED_CONFIRM_FAILURES: ReadonlySet<number> = new Set([400, 404, 422]);

/**
 * 결제창 성공 주소로 돌아온 결제의 확정. 쿼리로 둔 이유: 같은 결제의 확정은 서버·토스 양쪽에서 멱등이라 "이 결제의 확정 결과"를 읽는 일과 같고,
 * 화면이 뜨자마자 한 번 보내는 일을 데이터용 useEffect 없이 하는 방법이 쿼리다(같은 키라 두 번 마운트돼도 요청은 하나).
 * 답을 받은 뒤에는 staleTime이 Infinity라 창 포커스·재마운트로 다시 보내지 않고, 다시 묻는 길은 refetch("다시 확인")다.
 * 실패한 확정은 다시 마운트될 때(세션이 끊겨 다시 로그인한 뒤 등) 한 번 더 묻는다.
 * 결과가 정해지면 주소의 쿼리를 지우고 충전 목록·원장을 다시 읽는다(v5 useQuery에는 onSuccess가 없어 queryFn 안에서).
 */
export function useConfirmTopUp(ret: TossSuccess) {
  const client = useQueryClient();
  return useQuery({
    queryKey: keys.topUpConfirm(ret.paymentKey),
    queryFn: async () => {
      try {
        const result = await api.confirmTopUp(ret.orderId, { paymentKey: ret.paymentKey, amount: ret.amount });
        if (result.outcome !== 'unconfirmed') {
          clearTossReturn(window.location, window.history);
          await Promise.all([client.invalidateQueries({ queryKey: keys.topUps }), client.invalidateQueries({ queryKey: keys.credits })]);
        }
        return result;
      } catch (err) {
        if (err instanceof ApiError && SETTLED_CONFIRM_FAILURES.has(err.status)) clearTossReturn(window.location, window.history);
        throw err;
      }
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/** 결제창 열기. data는 결제창이 끝난 모양, 오류는 SDK를 못 불러왔거나 창을 못 그린 것이다. */
export function useTossPaymentWindow() {
  return useMutation({ mutationFn: openTossPaymentWindow });
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
