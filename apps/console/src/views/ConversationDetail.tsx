import { ApiError } from '../api';
import { REASON_LABEL, SOURCE_LABEL, formatTime } from '../labels';
import { useConversation } from '../queries';
import { href } from '../route';
import { StatusButtons } from './StatusButtons';

// 대화 상세 — 메시지 전문과 그 대화의 연결 요청. 요청의 상태는 여기서도 옮길 수 있다(바꾸면 이 쿼리가 다시 읽힌다).

export function ConversationDetail({ id }: { id: string }) {
  const detail = useConversation(id);

  return (
    <section>
      <div className="section-head">
        <h2>대화</h2>
        <a className="back" href={href.conversations()}>
          ← 대화 로그
        </a>
      </div>
      {detail.isPending ? (
        <p className="status">불러오는 중…</p>
      ) : detail.isError ? (
        <p className="status">
          {detail.error instanceof ApiError && detail.error.status === 404 ? '그 대화를 찾을 수 없어요.' : '대화를 불러오지 못했어요.'}
        </p>
      ) : (
        <>
          <p className="muted">
            시작 <time dateTime={detail.data.createdAt}>{formatTime(detail.data.createdAt)}</time> ·{' '}
            <code className="muted">{detail.data.id}</code>
          </p>
          {detail.data.handoffs.length > 0 && (
            <ul className="list handoffs" data-testid="detail-handoffs">
              {detail.data.handoffs.map((h) => (
                <li key={h.id} className="row">
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
                  </div>
                  <StatusButtons item={h} />
                </li>
              ))}
            </ul>
          )}
          {detail.data.messages.length === 0 ? (
            <p className="status">메시지 없이 연결 요청만 있는 대화예요.</p>
          ) : (
            <ol className="messages" data-testid="messages">
              {detail.data.messages.map((m, i) => (
                <li key={i} className={`message ${m.role}`}>
                  <div className="message-meta">
                    <span>{m.role === 'user' ? '방문자' : 'AI'}</span>
                    <time className="muted" dateTime={m.createdAt}>
                      {formatTime(m.createdAt)}
                    </time>
                  </div>
                  <p>{m.content}</p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
