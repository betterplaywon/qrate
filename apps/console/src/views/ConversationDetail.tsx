import type { ConversationDetailResponse, MessageDto } from '@qrate/contracts';
import { ApiError } from '../api';
import { HandoffCard } from '../components/HandoffCard';
import { QueryBoundary } from '../components/QueryBoundary';
import { formatTime } from '../labels';
import { useConversation } from '../queries';
import { href } from '../route';

// 대화 상세 — 메시지 전문과 그 대화의 연결 요청. 요청의 상태는 여기서도 옮길 수 있다(바꾸면 이 쿼리가 다시 읽힌다).

function detailError(error: unknown): string {
  return error instanceof ApiError && error.status === 404 ? '그 대화를 찾을 수 없어요.' : '대화를 불러오지 못했어요.';
}

function Messages({ messages }: { messages: MessageDto[] }) {
  if (messages.length === 0) return <p className="status">메시지 없이 연결 요청만 있는 대화예요.</p>;
  return (
    <ol className="messages" data-testid="messages">
      {messages.map((m, i) => (
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
  );
}

function Detail({ conversation }: { conversation: ConversationDetailResponse }) {
  return (
    <>
      <p className="muted">
        시작 <time dateTime={conversation.createdAt}>{formatTime(conversation.createdAt)}</time> ·{' '}
        <code className="muted">{conversation.id}</code>
      </p>
      {conversation.handoffs.length > 0 && (
        <ul className="list handoffs" data-testid="detail-handoffs">
          {conversation.handoffs.map((h) => (
            <HandoffCard key={h.id} item={h} />
          ))}
        </ul>
      )}
      <Messages messages={conversation.messages} />
    </>
  );
}

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
      <QueryBoundary pending={detail.isPending} error={detail.isError && detailError(detail.error)}>
        {detail.data && <Detail conversation={detail.data} />}
      </QueryBoundary>
    </section>
  );
}
