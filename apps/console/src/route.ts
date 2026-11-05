import { isHandoffStatus, type HandoffStatus } from '@qrate/contracts';
import { useSyncExternalStore } from 'react';

// 해시 라우팅. 서버가 /console/ 아래를 정적 파일로만 서빙하므로(SPA 폴백 없음) 화면 상태는 해시에 둔다.
//   #/queue/open · #/queue/in_progress · #/queue/done · #/conversations · #/conversations/<id> · #/billing
// location.hash는 React 밖의 상태라 useSyncExternalStore로 구독한다(useEffect + useState 대신).

export type Route =
  | { name: 'queue'; status: HandoffStatus }
  | { name: 'conversations' }
  | { name: 'conversation'; id: string }
  | { name: 'billing' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'conversations') {
    return parts[1] ? { name: 'conversation', id: decodeURIComponent(parts[1]) } : { name: 'conversations' };
  }
  if (parts[0] === 'queue') {
    return { name: 'queue', status: isHandoffStatus(parts[1]) ? parts[1] : 'open' };
  }
  if (parts[0] === 'billing') return { name: 'billing' };
  return { name: 'queue', status: 'open' };
}

export const href = {
  queue: (status: HandoffStatus): string => `#/queue/${status}`,
  conversations: (): string => '#/conversations',
  conversation: (id: string): string => `#/conversations/${encodeURIComponent(id)}`,
  billing: (): string => '#/billing',
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
