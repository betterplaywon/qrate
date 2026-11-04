import type { ConsoleTenant } from '@qrate/contracts';
import { useLogout, useMe } from './queries';
import { href, useRoute } from './route';
import { ConversationDetail } from './views/ConversationDetail';
import { ConversationList } from './views/ConversationList';
import { Login } from './views/Login';
import { Queue } from './views/Queue';

// 운영 콘솔(W3). 세션(me 쿼리) → 로그인 또는 셸(미응답 큐 · 대화 로그). 데이터는 전부 /api/console/* (apps/server/src/http/console.ts).

export function App() {
  const me = useMe();
  if (me.isPending) return <p className="status">세션을 확인하는 중…</p>;
  if (me.isError) return <p className="status error">서버에 연결할 수 없어요. 잠시 뒤 새로고침해 주세요.</p>;
  if (!me.data) return <Login />;
  return <Shell tenant={me.data} />;
}

function Shell({ tenant }: { tenant: ConsoleTenant }) {
  const route = useRoute();
  const logout = useLogout();

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="brand-name">Qrate 콘솔</span>
          <span className="tenant" data-testid="tenant-name">{tenant.name}</span>
        </div>
        <nav className="nav" aria-label="주 메뉴">
          <a href={href.queue('open')} className={route.name === 'queue' ? 'active' : ''}>
            미응답 큐
          </a>
          <a href={href.conversations()} className={route.name !== 'queue' ? 'active' : ''}>
            대화 로그
          </a>
        </nav>
        <button type="button" className="ghost" disabled={logout.isPending} onClick={() => logout.mutate()}>
          로그아웃
        </button>
      </header>
      <main className="main">
        {route.name === 'queue' && <Queue status={route.status} />}
        {route.name === 'conversations' && <ConversationList />}
        {route.name === 'conversation' && <ConversationDetail id={route.id} />}
      </main>
    </div>
  );
}
