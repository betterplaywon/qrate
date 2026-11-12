import { KNOWLEDGE_LIMITS, type KnowledgeItemDto } from '@qrate/contracts';
import { ApiError } from './api';

// FAQ 화면의 규칙. 목록(FaqList)과 고치기(FaqEdit)가 같이 쓴다.

/**
 * "지원하지 않는 것" 항목의 id. 엔진에는 다른 FAQ와 같지만, 위젯이 "지원하지 않아요"라고 단정하는 근거라 목록에서 따로 보여 준다.
 * 데모 시드의 두 회사가 이 id를 쓴다. 없는 회사는 콘솔에서 처음 저장할 때 이 id로 생긴다.
 */
export const UNSUPPORTED_ID = 'faq:unsupported-features';
export const UNSUPPORTED_DEFAULTS = { title: '지원하지 않는 것', category: '안내' } as const;

/** 새 질문의 id(faq: + 16진수 12자리). 화면을 열 때 한 번 만들고 저장을 몇 번 눌러도 같은 id로 보낸다. 그래서 같은 질문이 두 개 생기지 않는다. */
export function newKnowledgeId(): string {
  // randomUUID는 https·localhost에서만 있다. getRandomValues는 어디서나 된다.
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `faq:${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const collator = new Intl.Collator('ko-KR');

export interface FaqGroup {
  category: string;
  items: KnowledgeItemDto[];
}

/** 분류별로 묶고 분류와 질문을 가나다순으로 놓는다. "지원하지 않는 것"은 따로 보여 주므로 뺀다. */
export function groupByCategory(items: readonly KnowledgeItemDto[]): FaqGroup[] {
  const groups = new Map<string, KnowledgeItemDto[]>();
  for (const item of items) {
    if (item.id !== UNSUPPORTED_ID) groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
  }
  return [...groups]
    .map(([category, list]) => ({ category, items: list.sort((a, b) => collator.compare(a.title, b.title)) }))
    .sort((a, b) => collator.compare(a.category, b.category));
}

export function categoriesOf(items: readonly KnowledgeItemDto[]): string[] {
  return [...new Set(items.map((k) => k.category))].sort((a, b) => collator.compare(a, b));
}

/** 찾기. 질문·분류·답 문단 어디든 낱말이 들어 있으면 보인다. 대소문자는 가리지 않는다. */
export function matchesQuery(item: KnowledgeItemDto, query: string): boolean {
  const q = query.trim().toLocaleLowerCase('ko-KR');
  return !q || [item.title, item.category, ...item.blocks].some((text) => text.toLocaleLowerCase('ko-KR').includes(q));
}

export function saveErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ApiError && error.code === 'knowledge_limit') {
    return `FAQ는 ${KNOWLEDGE_LIMITS.items}개까지 넣을 수 있어요. 안 쓰는 질문을 지운 뒤 추가해 주세요.`;
  }
  if (error instanceof ApiError && error.code === 'knowledge_too_large') {
    return `FAQ 전체 글자가 ${KNOWLEDGE_LIMITS.totalChars.toLocaleString('ko-KR')}자를 넘어서 저장하지 않았어요. 문단을 줄이거나 안 쓰는 질문을 지워 주세요.`;
  }
  if (error instanceof ApiError && error.status === 400) return '저장할 수 없는 내용이 있어요. 칸마다 안내를 확인해 주세요.';
  return '저장하지 못했어요. 다시 눌러 주세요. 같은 질문으로 다시 보내므로 두 개가 생기지 않아요.';
}
