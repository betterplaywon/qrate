import { HANDOFF_STATUSES, type HandoffDto } from '@qrate/contracts';
import { MOVE_TO_LABEL, STATUS_LABEL } from '../labels';
import { useUpdateHandoff } from '../queries';

// 상태 전이 버튼. 지금 상태를 뺀 나머지로 옮긴다(전이 제한 없음 — 되돌리기도 같은 버튼). 끝나면 큐·상세 쿼리가 다시 읽힌다(queries.ts).

export function StatusButtons({ item }: { item: Pick<HandoffDto, 'id' | 'status'> }) {
  const update = useUpdateHandoff();
  const pendingTo = update.isPending ? update.variables?.status : null;

  return (
    <div className="actions" role="group" aria-label="상태 바꾸기">
      <span className={`pill status-${item.status}`} data-testid="status">
        {STATUS_LABEL[item.status]}
      </span>
      {HANDOFF_STATUSES.filter((s) => s !== item.status).map((s) => (
        <button
          key={s}
          type="button"
          className="small"
          disabled={update.isPending}
          onClick={() => update.mutate({ id: item.id, status: s })}
          data-testid={`move-${s}`}
        >
          {pendingTo === s ? '…' : MOVE_TO_LABEL[s]}
        </button>
      ))}
      {update.isError && <span className="error">바꾸지 못했어요. 다시 시도해 주세요.</span>}
    </div>
  );
}
