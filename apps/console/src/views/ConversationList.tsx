import { formatTime } from '../labels';
import { useConversations } from '../queries';
import { href } from '../route';

// 대화 로그 — 테넌트의 대화를 최근 시작순으로. 커서 페이지네이션("더 보기")은 useInfiniteQuery가 든다.

export function ConversationList() {
  const list = useConversations();
  const items = list.data?.pages.flatMap((p) => p.items);

  return (
    <section>
      <div className="section-head">
        <h2>대화 로그</h2>
      </div>
      {list.isPending ? (
        <p className="status">불러오는 중…</p>
      ) : list.isError ? (
        <p className="status error">대화 로그를 불러오지 못했어요.</p>
      ) : items && items.length === 0 ? (
        <p className="status" data-testid="conversations-empty">
          아직 대화가 없어요. 위젯에서 질문이 오면 여기 쌓여요.
        </p>
      ) : (
        <ul className="list" data-testid="conversation-list">
          {items?.map((c) => (
            <li key={c.id} className="row" data-testid="conversation-item">
              <a className="row-main" href={href.conversation(c.id)}>
                <div className="row-top">
                  <time className="muted" dateTime={c.createdAt}>
                    {formatTime(c.createdAt)}
                  </time>
                  <span className="muted">메시지 {c.messageCount}</span>
                  {c.handoffCount > 0 && <span className="badge">연결 요청 {c.handoffCount}</span>}
                </div>
                <p className="summary">{c.preview || '(질문 없이 연결 요청만 있는 대화)'}</p>
              </a>
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
