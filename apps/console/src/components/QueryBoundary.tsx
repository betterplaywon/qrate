import type { ReactNode } from 'react';

// 쿼리 결과의 공통 상태(불러오는 중 · 실패 · 비어 있음)를 한 곳에서 그린다. 뷰는 성공 분기만 적는다.
// 순서가 곧 우선순위다: 아직 없음 → 실패 → 비어 있음 → 내용.

export function QueryBoundary({
  pending,
  error,
  empty,
  children,
}: {
  pending: boolean;
  /** 실패 안내 문구. 실패가 아니면 false·null. */
  error: string | false | null;
  /** 비어 있을 때 그릴 것. 비어 있지 않으면 false·null. */
  empty?: ReactNode | false | null;
  children: ReactNode;
}) {
  if (pending) return <p className="status">불러오는 중…</p>;
  if (error) return <p className="status error">{error}</p>;
  if (empty) return <>{empty}</>;
  return <>{children}</>;
}
