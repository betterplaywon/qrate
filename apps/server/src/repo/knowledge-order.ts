/**
 * 지식 항목의 고정 순서 — id 오름차순, 코드 단위 비교.
 * 요청마다 같은 순서여야 프롬프트 캐시 접두사가 유지된다(ADR-0004). 로캘·DB 콜레이션에 기대지 않는다:
 * Postgres의 ORDER BY는 DB 콜레이션에 따라 `:`·`-` 같은 구두점을 다르게 다룰 수 있어, 메모리·Prisma 두 구현 모두 여기서 정렬한다.
 */
export function sortKnowledgeById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
