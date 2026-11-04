import { HANDOFF_STATUSES, type HandoffStatus } from '@qrate/contracts';
import { HandoffCard } from '../components/HandoffCard';
import { LoadMore } from '../components/LoadMore';
import { QueryBoundary } from '../components/QueryBoundary';
import { STATUS_LABEL } from '../labels';
import { useHandoffs } from '../queries';
import { href } from '../route';

// 미응답 큐 = 핸드오프 행(콘솔 결정 2026-11-04, 큐 A). 상태 탭으로 거르고, 줄마다 상태를 옮긴다. 답은 밖(이메일 등)에서 하고 여기선 상태만.

export function Queue({ status }: { status: HandoffStatus }) {
  const list = useHandoffs(status);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

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
      <QueryBoundary
        pending={list.isPending}
        error={list.isError && '큐를 불러오지 못했어요.'}
        empty={
          items.length === 0 && (
            <p className="status" data-testid="queue-empty">
              {STATUS_LABEL[status]} 상태의 요청이 없어요.
            </p>
          )
        }
      >
        <ul className="list" data-testid="queue-list">
          {items.map((h) => (
            <HandoffCard
              key={h.id}
              item={h}
              testId="queue-item"
              footer={
                <a className="preview" href={href.conversation(h.conversationId)}>
                  {h.preview ? `“${h.preview}”` : '(질문 없이 연결 요청만 있는 대화)'} → 대화 보기
                </a>
              }
            />
          ))}
        </ul>
      </QueryBoundary>
      <LoadMore query={list} />
    </section>
  );
}
