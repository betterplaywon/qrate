import type { ConsoleTenant, ConversationListResponse, HandoffListResponse } from '@qrate/contracts';
import { InfiniteQueryObserver, MutationObserver, type InfiniteData } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';
import { keys } from '../src/queries';
import { ME_KEY, queryClient } from '../src/queryClient';

const tenantA: ConsoleTenant = { id: 'tenant-a', name: '가 회사' };
const tenantB: ConsoleTenant = { id: 'tenant-b', name: '나 회사' };

const queueOfA: InfiniteData<HandoffListResponse, string | null> = {
  pages: [
    {
      items: [
        {
          id: 'h-a',
          conversationId: 'c-a',
          preview: '가 회사 방문자의 질문',
          source: 'visitor',
          reason: 'needs_human',
          summary: null,
          contact: 'visitor@a.example',
          status: 'open',
          createdAt: '2026-11-12T00:00:00.000Z',
          updatedAt: '2026-11-12T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    },
  ],
  pageParams: [null],
};
const conversationsOfA: InfiniteData<ConversationListResponse, string | null> = {
  pages: [{ items: [{ id: 'c-a', createdAt: '2026-11-12T00:00:00.000Z', messageCount: 2, handoffCount: 1, preview: '가 회사 방문자의 질문' }], nextCursor: null }],
  pageParams: [null],
};

const rejectWith = (status: number) => () => Promise.reject(new ApiError(status, status === 401 ? 'unauthorized' : 'internal_error'));

/** 테넌트 A가 로그인해 큐와 대화 로그를 본 뒤의 캐시. */
function signedInAsA(): void {
  queryClient.setQueryData(ME_KEY, tenantA);
  queryClient.setQueryData(keys.handoffs('open'), queueOfA);
  queryClient.setQueryData(keys.conversations, conversationsOfA);
}

/** 다른 테넌트로 다시 로그인한 직후 큐와 대화 로그 화면이 처음 받는 결과(useLogin은 me만 바꾼다). */
function firstRenderAfterLoginAsB() {
  queryClient.setQueryData(ME_KEY, tenantB);
  const page = { initialPageParam: null, getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor };
  const queue = new InfiniteQueryObserver(queryClient, {
    queryKey: keys.handoffs('open'),
    queryFn: () => Promise.resolve<HandoffListResponse>({ items: [], nextCursor: null }),
    ...page,
  });
  const conversations = new InfiniteQueryObserver(queryClient, {
    queryKey: keys.conversations,
    queryFn: () => Promise.resolve<ConversationListResponse>({ items: [], nextCursor: null }),
    ...page,
  });
  return { queue: queue.getCurrentResult(), conversations: conversations.getCurrentResult() };
}

const cachedKeys = () => queryClient.getQueryCache().getAll().map((q) => q.queryKey);

afterEach(() => {
  queryClient.clear();
});

describe('401로 끊긴 세션', () => {
  it('쿼리가 401이면 로그인 화면으로 가고(me = null), 다른 테넌트로 다시 로그인한 첫 그림에 이전 테넌트의 큐·대화가 없다', async () => {
    signedInAsA();
    await expect(
      queryClient.fetchInfiniteQuery({ queryKey: keys.handoffs('open'), queryFn: rejectWith(401), initialPageParam: null }),
    ).rejects.toThrow(ApiError);

    expect(queryClient.getQueryData(ME_KEY)).toBeNull();
    const left = cachedKeys();
    const first = firstRenderAfterLoginAsB();
    expect(first.queue.data).toBeUndefined();
    expect(first.queue.status).toBe('pending');
    expect(first.conversations.data).toBeUndefined();
    expect(first.conversations.status).toBe('pending');
    expect(left).toEqual([ME_KEY]);
  });

  it('변경 요청(상태 옮기기 등)이 401이어도 같다', async () => {
    signedInAsA();
    const move = new MutationObserver(queryClient, { mutationFn: rejectWith(401) });
    await expect(move.mutate()).rejects.toThrow(ApiError);

    expect(queryClient.getQueryData(ME_KEY)).toBeNull();
    const left = cachedKeys();
    expect(firstRenderAfterLoginAsB().conversations.data).toBeUndefined();
    expect(left).toEqual([ME_KEY]);
  });

  it('401이 아닌 실패는 세션도 캐시도 그대로 둔다', async () => {
    signedInAsA();
    await expect(queryClient.fetchQuery({ queryKey: keys.metrics, queryFn: rejectWith(500) })).rejects.toThrow(ApiError);
    await expect(new MutationObserver(queryClient, { mutationFn: rejectWith(500) }).mutate()).rejects.toThrow(ApiError);

    expect(queryClient.getQueryData(ME_KEY)).toEqual(tenantA);
    expect(queryClient.getQueryData(keys.handoffs('open'))).toEqual(queueOfA);
    expect(queryClient.getQueryData(keys.conversations)).toEqual(conversationsOfA);
  });
});
