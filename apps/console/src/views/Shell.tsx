import type { ConsoleTenant } from '@qrate/contracts';
import { useLanding, useLogout } from '../queries';
import { href, useRoute, type ScreenRoute } from '../route';
import { Billing } from './Billing';
import { ConversationDetail } from './ConversationDetail';
import { ConversationList } from './ConversationList';
import { FaqEdit } from './FaqEdit';
import { FaqList } from './FaqList';
import { Install } from './Install';
import { Metrics } from './Metrics';
import { Queue } from './Queue';
import { Start } from './Start';

// 로그인 뒤의 틀 — 머리글(테넌트·메뉴·로그아웃)과 해시 라우팅에 따른 화면 하나.

function Screen({ route, tenant }: { route: ScreenRoute; tenant: ConsoleTenant }) {
  switch (route.name) {
    case 'start':
      return <Start tenant={tenant} />;
    case 'install':
      return <Install />;
    case 'queue':
      return <Queue status={route.status} />;
    case 'conversations':
      return <ConversationList />;
    case 'conversation':
      return <ConversationDetail id={route.id} />;
    case 'faq':
      return <FaqList notice={route.notice} />;
    case 'faqItem':
      return <FaqEdit key={route.id ?? 'new'} id={route.id} tenantName={tenant.name} />;
    case 'metrics':
      return <Metrics />;
    case 'billing':
      return <Billing />;
    default: {
      const _exhaustive: never = route;
      return _exhaustive;
    }
  }
}

export function Shell({ tenant }: { tenant: ConsoleTenant }) {
  const hashRoute = useRoute();
  // 해시가 비면 시작하기가 끝났는지 보고 첫 화면을 고른다. 고르는 동안은 null.
  const landing = useLanding(hashRoute.name === 'home');
  const route = hashRoute.name === 'home' ? landing : hashRoute;
  const logout = useLogout();

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="brand-name">Qrate 콘솔</span>
          <span className="tenant" data-testid="tenant-name">{tenant.name}</span>
        </div>
        <nav className="nav" aria-label="주 메뉴">
          <a href={href.start()} className={route?.name === 'start' ? 'active' : ''} data-testid="nav-start">
            시작하기
          </a>
          <a href={href.queue('open')} className={route?.name === 'queue' ? 'active' : ''}>
            미응답 큐
          </a>
          <a href={href.conversations()} className={route?.name === 'conversations' || route?.name === 'conversation' ? 'active' : ''}>
            대화 로그
          </a>
          <a href={href.faq()} className={route?.name === 'faq' || route?.name === 'faqItem' ? 'active' : ''} data-testid="nav-faq">
            FAQ
          </a>
          <a href={href.install()} className={route?.name === 'install' ? 'active' : ''} data-testid="nav-install">
            설치
          </a>
          <a href={href.metrics()} className={route?.name === 'metrics' ? 'active' : ''} data-testid="nav-metrics">
            지표
          </a>
          <a href={href.billing()} className={route?.name === 'billing' ? 'active' : ''} data-testid="nav-billing">
            크레딧
          </a>
        </nav>
        <button type="button" className="ghost" disabled={logout.isPending} onClick={() => logout.mutate()}>
          로그아웃
        </button>
      </header>
      <main className="main">{route === null ? <p className="status">불러오는 중…</p> : <Screen route={route} tenant={tenant} />}</main>
    </div>
  );
}
