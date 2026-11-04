import type { CursorKey } from '../listing.js';

// 키셋 페이지네이션의 WHERE 조각. (createdAt, id) 내림차순에서 커서 "뒤"(더 오래된 쪽)의 행만:
// createdAt이 더 이르거나, 같으면 id가 더 작은 것. 대화 목록과 핸드오프 큐가 같은 모양을 쓴다.
// id 비교는 DB 콜레이션을 따르지만, 대화 id(소문자 UUID)와 핸드오프 id(cuid, 소문자 영숫자)는 코드 단위 비교와 순서가 같다.

export function afterCursor(after: CursorKey | null): { OR: [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }] } | object {
  if (!after) return {};
  return { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] };
}

/** 최근순 정렬 — afterCursor와 짝이다. */
export const NEWEST_FIRST = [{ createdAt: 'desc' }, { id: 'desc' }] as const;
