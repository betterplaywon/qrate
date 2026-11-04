import { HANDOFF_STATUSES, type HandoffStatus } from '@qrate/contracts';
import { REASON_LABEL, SOURCE_LABEL, STATUS_LABEL, formatTime } from '../labels';
import { useHandoffs } from '../queries';
import { href } from '../route';
import { StatusButtons } from './StatusButtons';

// 미응답 큐 = 핸드오프 행(콘솔 결정 2026-11-04, 큐 A). 상태 탭으로 거르고, 줄마다 상태를 옮긴다. 답은 밖(이메일 등)에서 하고 여기선 상태만.

export function Queue({ status }: { status: HandoffStatus }) {
  const list = useHandoffs(status);
  const items = list.data?.pages.flatMap((p) => p.items);

  return (
    <section>
      <div className="section-head">
        <h2>미응답 큐</h2>
        <nav className="tabs" aria-label="상태">
          {HANDOFF_STATUSES.map((s) => (
            <a key={s} href={href.queue(s)} className={s === status ? 'active' : ''} data-testid={`tab-${s}`}>
              {STATUS_LABEL[s]}
            </a>
          ))}
        </nav>
      </div>
      {list.isPending ? (
        <p className="status">불러오는 중…</p>
      ) : list.isError ? (
        <p className="status error">큐를 불러오지 못했어요.</p>
      ) : items && items.length === 0 ? (
        <p className="status" data-testid="queue-empty">
          {STATUS_LABEL[status]} 상태의 요청이 없어요.
        </p>
      ) : (
        <ul className="list" data-testid="queue-list">
          {items?.map((h) => (
            <li key={h.id} className="row" data-testid="queue-item">
              <div className="row-main">
                <div className="row-top">
                  <span className={`badge source-${h.source}`}>{SOURCE_LABEL[h.source]}</span>
                  <span className="badge">{REASON_LABEL[h.reason]}</span>
                  <time className="muted" dateTime={h.createdAt}>
                    {formatTime(h.createdAt)}
                  </time>
                </div>
                {h.summary && <p className="summary">{h.summary}</p>}
                {h.contact && (
                  <p className="contact">
                    연락처 <code>{h.contact}</code>
                  </p>
                )}
                <a className="preview" href={href.conversation(h.conversationId)}>
                  {h.preview ? `“${h.preview}”` : '(질문 없이 연결 요청만 있는 대화)'} → 대화 보기
                </a>
              </div>
              <StatusButtons item={h} />
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <button type="button" className="ghost more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          더 보기
        </button>
      )}
    </section>
  );
}
