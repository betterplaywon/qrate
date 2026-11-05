import { useMe } from './queries';
import { Login } from './views/Login';
import { Shell } from './views/Shell';

// 운영 콘솔(W3). 세션(me 쿼리) → 로그인 또는 셸(미응답 큐 · 대화 로그). 데이터는 전부 /api/console/* (apps/server/src/http/console/).

export function App() {
  const me = useMe();
  if (me.isPending) return <p className="status">세션을 확인하는 중…</p>;
  if (me.isError) return <p className="status error">서버에 연결할 수 없어요. 잠시 뒤 새로고침해 주세요.</p>;
  if (!me.data) return <Login />;
  return <Shell tenant={me.data} />;
}
