import type { CreditEntryDto } from '@qrate/contracts';
import { LoadMore } from '../components/LoadMore';
import { QueryBoundary } from '../components/QueryBoundary';
import { CREDIT_REASON_LABEL, formatTime } from '../labels';
import { useCredits } from '../queries';
import { TopUps } from './TopUps';

function Entry({ entry }: { entry: CreditEntryDto }) {
  const sign = entry.delta > 0 ? '+' : '';
  return (
    <li className="row" data-testid="credit-entry">
      <div className="row-main">
        <div className="row-top">
          <span className="badge">{CREDIT_REASON_LABEL[entry.reason]}</span>
          <time className="muted" dateTime={entry.createdAt}>
            {formatTime(entry.createdAt)}
          </time>
          <code className="muted">{entry.idempotencyKey}</code>
        </div>
      </div>
      <span className={`delta ${entry.delta < 0 ? 'minus' : 'plus'}`}>
        {sign}
        {entry.delta}
      </span>
    </li>
  );
}

export function Billing() {
  const credits = useCredits();
  const items = credits.data?.pages.flatMap((p) => p.items) ?? [];
  const balance = credits.data?.pages[0]?.balance;

  return (
    <section>
      <div className="section-head">
        <h2>크레딧</h2>
      </div>
      <QueryBoundary pending={credits.isPending} error={credits.isError && '크레딧을 불러오지 못했어요.'}>
        <p className="balance">
          잔액 <strong data-testid="credit-balance">{balance}</strong> 크레딧
          <span className="muted"> · 답변 한 번에 1크레딧. 0이 되면 위젯이 "운영자에게 알려 달라"고 안내해요.</span>
        </p>
        <TopUps />
        <h3 className="subhead">원장</h3>
        {items.length === 0 ? (
          <p className="status">원장이 비어 있어요.</p>
        ) : (
          <ul className="list" data-testid="credit-list">
            {items.map((e) => (
              <Entry key={e.id} entry={e} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore query={credits} />
    </section>
  );
}
