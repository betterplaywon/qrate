import type { KnowledgeSource } from '../engine/types.js';
import type { KnowledgeRepository } from '../repo/types.js';

// 지식 고르기 — 전량 주입 (ADR-0004, 2026-11-02).
// 질문과 무관하게 테넌트의 지식 전부를 항상 같은 순서로 돌려준다. MVP 규모(FAQ 20~30개)에서는
// 검색 실패 위험을 없애는 쪽이 정확도에 유리하고, 비용은 프롬프트 캐싱이 흡수한다.
// 나중에 검색 단계(pg_trgm, 임베딩)를 붙이면 이 함수의 내부만 바뀌고
// 인용 형식·SSE 계약·위젯 표시는 그대로다.
export async function selectKnowledge(
  repo: KnowledgeRepository,
  tenantId: string,
  _question: string,
): Promise<KnowledgeSource[]> {
  const items = await repo.listByTenant(tenantId);
  return items.map((k) => ({ id: k.id, title: k.title, blocks: k.blocks }));
}
