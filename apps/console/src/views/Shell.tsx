import type { ConsoleTenant } from '@qrate/contracts';
import { useLogout } from '../queries';
import { href, useRoute } from '../route';
import { Billing } from './Billing';
import { ConversationDetail } from './ConversationDetail';
import { ConversationList } from './ConversationList';
import { FaqEdit } from './FaqEdit';
import { FaqList } from './FaqList';
import { Metrics } from './Metrics';
import { Queue } from './Queue';

// 로그인 뒤의 틀 — 머리글(테넌트·메뉴·로그아웃)과 해시 라우팅에 따른 화면 하나.

export function Shell({ tenant }: { tenant: ConsoleTenant }) {
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
          <a href={href.conversations()} className={route.name === 'conversations' || route.name === 'conversation' ? 'active' : ''}>
            대화 로그
          </a>
          <a href={href.faq()} className={route.name === 'faq' || route.name === 'faqItem' ? 'active' : ''} data-testid="nav-faq">
            FAQ
          </a>
          <a href={href.metrics()} className={route.name === 'metrics' ? 'active' : ''} data-testid="nav-metrics">
            지표
          </a>
          <a href={href.billing()} className={route.name === 'billing' ? 'active' : ''} data-testid="nav-billing">
            크레딧
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
        {route.name === 'faq' && <FaqList notice={route.notice} />}
        {route.name === 'faqItem' && <FaqEdit key={route.id ?? 'new'} id={route.id} tenantName={tenant.name} />}
        {route.name === 'metrics' && <Metrics />}
        {route.name === 'billing' && <Billing />}
      </main>
    </div>
  );
}
