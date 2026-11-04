import type { UseInfiniteQueryResult } from '@tanstack/react-query';

// 커서 페이지네이션의 "더 보기" 버튼. 다음 페이지가 없으면 아무것도 그리지 않는다.

export function LoadMore({ query }: { query: Pick<UseInfiniteQueryResult, 'hasNextPage' | 'isFetchingNextPage' | 'fetchNextPage'> }) {
  if (!query.hasNextPage) return null;
  return (
    <button type="button" className="ghost more" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
      더 보기
    </button>
  );
}
