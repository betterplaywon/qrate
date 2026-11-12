import { KNOWLEDGE_LIMITS, knowledgeChars } from '@qrate/contracts';
import type { KnowledgeItem, KnowledgeRepository } from '../repo/types.js';

// 콘솔의 FAQ 저장. 저장소는 상한을 모르고, 상한(KNOWLEDGE_LIMITS)은 여기서만 본다.
// 확인과 저장 사이에 같은 회사의 다른 저장이 끼면 상한을 한두 개 넘을 수 있다. 상한은 답이 느려지고 비용이 느는 것을 막는 장치라 그 정도는 받아들인다.

export type SaveKnowledgeResult = { ok: true; created: boolean } | { ok: false; error: 'knowledge_limit' | 'knowledge_too_large' };

export async function saveKnowledge(repo: KnowledgeRepository, item: KnowledgeItem): Promise<SaveKnowledgeResult> {
  const current = await repo.listByTenant(item.tenantId);
  const previous = current.find((k) => k.id === item.id);
  if (!previous && current.length >= KNOWLEDGE_LIMITS.items) return { ok: false, error: 'knowledge_limit' };
  const before = current.reduce((sum, k) => sum + knowledgeChars(k), 0);
  const after = before - (previous ? knowledgeChars(previous) : 0) + knowledgeChars(item);
  // 상한을 이미 넘은 회사(상한이 생기기 전의 자료)도 글자를 줄이는 수정은 받는다. 그래야 콘솔에서 줄여 나갈 수 있다.
  if (after > KNOWLEDGE_LIMITS.totalChars && after > before) return { ok: false, error: 'knowledge_too_large' };
  await repo.put(item);
  return { ok: true, created: !previous };
}
