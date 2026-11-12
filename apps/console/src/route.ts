import { HANDOFF_STATUSES, isOneOf, type HandoffStatus } from '@qrate/contracts';
import { useSyncExternalStore } from 'react';

// 해시 라우팅. 서버가 /console/ 아래를 정적 파일로만 서빙하므로(SPA 폴백 없음) 화면 상태는 해시에 둔다.
//   #/queue/open · #/queue/in_progress · #/queue/done · #/conversations · #/conversations/<id> · #/metrics · #/billing
//   #/faq · #/faq/new · #/faq/<id> · 저장·지우기 뒤의 목록은 #/faq?saved=<id> · #/faq?deleted=1 · #/start · #/install
//   해시가 비면 home이다. 시작하기가 끝났는지에 따라 Shell이 시작하기나 미응답 큐를 보여 준다(queries.ts useLanding).
// location.hash는 React 밖의 상태라 useSyncExternalStore로 구독한다(useEffect + useState 대신).

/** FAQ 목록 위에 한 번 보이는 알림. 저장·지우기 뒤 목록으로 돌아올 때 해시 쿼리로 넘긴다. */
export type FaqNotice = { kind: 'saved'; id: string } | { kind: 'deleted' };

export type Route =
  | { name: 'home' }
  | { name: 'start' }
  | { name: 'install' }
  | { name: 'queue'; status: HandoffStatus }
  | { name: 'conversations' }
  | { name: 'conversation'; id: string }
  | { name: 'faq'; notice: FaqNotice | null }
  /** id가 null이면 새 질문. */
  | { name: 'faqItem'; id: string | null }
  | { name: 'metrics' }
  | { name: 'billing' };

/** 손으로 고친 주소의 깨진 퍼센트 문자(%E0%A4%A)는 decodeURIComponent가 던져 화면 전체가 멈춘다. 그대로 두면 그런 id는 없어서 "찾을 수 없음"이 된다. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseFaqNotice(query: URLSearchParams): FaqNotice | null {
  const saved = query.get('saved');
  if (saved) return { kind: 'saved', id: saved };
  return query.has('deleted') ? { kind: 'deleted' } : null;
}

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'conversations') {
    return parts[1] ? { name: 'conversation', id: decodeSegment(parts[1]) } : { name: 'conversations' };
  }
  if (parts[0] === 'queue') {
    return { name: 'queue', status: isOneOf(HANDOFF_STATUSES, parts[1]) ? parts[1] : 'open' };
  }
  if (parts[0] === 'faq') {
    if (!parts[1]) return { name: 'faq', notice: parseFaqNotice(new URLSearchParams(query)) };
    return { name: 'faqItem', id: parts[1] === 'new' ? null : decodeSegment(parts[1]) };
  }
  if (parts[0] === 'metrics') return { name: 'metrics' };
  if (parts[0] === 'billing') return { name: 'billing' };
  if (parts[0] === 'start') return { name: 'start' };
  if (parts[0] === 'install') return { name: 'install' };
  return { name: 'home' };
}

export const href = {
  queue: (status: HandoffStatus): string => `#/queue/${status}`,
  conversations: (): string => '#/conversations',
  conversation: (id: string): string => `#/conversations/${encodeURIComponent(id)}`,
  faq: (notice: FaqNotice | null = null): string => {
    if (notice?.kind === 'saved') return `#/faq?saved=${encodeURIComponent(notice.id)}`;
    return notice?.kind === 'deleted' ? '#/faq?deleted=1' : '#/faq';
  },
  faqNew: (): string => '#/faq/new',
  faqItem: (id: string): string => `#/faq/${encodeURIComponent(id)}`,
  metrics: (): string => '#/metrics',
  billing: (): string => '#/billing',
  start: (): string => '#/start',
  install: (): string => '#/install',
};

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};
const getHash = (): string => window.location.hash;

export function useRoute(): Route {
  // 해시 문자열(원시값)을 구독하고 파싱은 렌더에서 — 스냅샷이 매번 새 객체면 무한 렌더가 된다.
  return parseRoute(useSyncExternalStore(subscribe, getHash, getHash));
}
