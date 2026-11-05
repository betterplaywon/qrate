import { zodResolver } from '@hookform/resolvers/zod';
import { TOP_UP_PACKAGES, type PaymentResult, type SimulatePaymentResponse, type TopUpDto } from '@qrate/contracts';
import { createTopUpSchema, type CreateTopUpInput } from '@qrate/contracts/schemas';
import { useRef } from 'react';
import { useForm } from 'react-hook-form';
import { ApiError } from '../api';
import { LoadMore } from '../components/LoadMore';
import { QueryBoundary } from '../components/QueryBoundary';
import { TOP_UP_STATUS_LABEL, formatTime, formatWon } from '../labels';
import { useCreateTopUp, useSimulatePayment, useTopUps } from '../queries';

function requestErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ApiError && error.status === 503) return '이 서버에는 결제 제공자가 없어 충전할 수 없어요.';
  return '충전 요청을 보내지 못했어요. 다시 누르면 같은 요청으로 보내요 — 주문이 두 번 생기지 않아요.';
}

function simulateMessage(r: SimulatePaymentResponse, sent: PaymentResult): string {
  if (r.replayed) return '같은 이벤트가 다시 왔어요. 처리 결과는 처음과 같고 잔액은 그대로예요.';
  if (r.outcome === 'stale') return '이미 처리된 주문이라 상태가 바뀌지 않았어요.';
  if (r.outcome === 'applied') return sent === 'paid' ? `${r.topUp.credits}크레딧을 충전했어요.` : '결제 실패를 기록했어요. 잔액은 그대로예요.';
  return '주문과 맞지 않는 이벤트라 무시했어요.';
}

function TopUpForm() {
  const create = useCreateTopUp();
  // 성공할 때까지 같은 상품의 재제출은 같은 멱등 키로 보낸다 — 응답만 끊긴 요청을 다시 보내도 주문은 하나다.
  const attempt = useRef<{ packageId: string; key: string } | null>(null);
  const form = useForm<CreateTopUpInput>({ resolver: zodResolver(createTopUpSchema), defaultValues: { packageId: 'credits_100' } });
  const busy = form.formState.isSubmitting || create.isPending;
  const error = requestErrorMessage(create.error);

  const submit = form.handleSubmit(({ packageId }) => {
    const current = attempt.current?.packageId === packageId ? attempt.current : { packageId, key: crypto.randomUUID() };
    attempt.current = current;
    return create.mutateAsync({ body: { packageId }, key: current.key }).then(
      () => {
        attempt.current = null;
      },
      () => undefined,
    );
  });

  return (
    <form className="top-up-form" onSubmit={submit} noValidate>
      <fieldset className="packages">
        <legend>충전할 크레딧</legend>
        {TOP_UP_PACKAGES.map((p) => (
          <label key={p.id} className="package">
            <input type="radio" value={p.id} data-testid={`package-${p.id}`} {...form.register('packageId')} />
            {p.credits}크레딧 <span className="muted">· {formatWon(p.amount)}</span>
          </label>
        ))}
      </fieldset>
      {error && (
        <p className="error" role="alert" data-testid="top-up-error">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {busy ? '요청하는 중…' : '충전 요청'}
      </button>
    </form>
  );
}

function TopUpRow({ topUp, onSimulate, busy }: { topUp: TopUpDto; onSimulate: ((result: PaymentResult) => void) | null; busy: boolean }) {
  return (
    <li className="row" data-testid="top-up-item">
      <div className="row-main">
        <div className="row-top">
          <span className={`pill top-up-${topUp.status}`} data-testid="top-up-status">
            {TOP_UP_STATUS_LABEL[topUp.status]}
          </span>
          <strong>{topUp.credits}크레딧</strong>
          <span className="muted">{formatWon(topUp.amount)}</span>
          <time className="muted" dateTime={topUp.createdAt}>
            {formatTime(topUp.createdAt)}
          </time>
        </div>
        <code className="muted">주문 {topUp.id}</code>
      </div>
      {onSimulate && (
        <div className="actions" role="group" aria-label="결제 결과 흉내">
          <button type="button" className="small" disabled={busy} onClick={() => onSimulate('paid')}>
            결제 성공(테스트)
          </button>
          <button type="button" className="small" disabled={busy} onClick={() => onSimulate('failed')}>
            결제 실패(테스트)
          </button>
        </div>
      )}
    </li>
  );
}

export function TopUps() {
  const topUps = useTopUps();
  const simulate = useSimulatePayment();
  const items = topUps.data?.pages.flatMap((p) => p.items) ?? [];
  const provider = topUps.data?.pages[0]?.provider ?? null;
  const sent = simulate.variables?.result;

  return (
    <section className="top-ups" aria-labelledby="top-ups-title">
      <h3 id="top-ups-title" className="subhead">
        충전
      </h3>
      <QueryBoundary pending={topUps.isPending} error={topUps.isError && '충전 내역을 불러오지 못했어요.'}>
        {provider ? (
          <TopUpForm />
        ) : (
          <p className="status" data-testid="payments-unavailable">
            이 서버에는 결제 제공자가 설정되지 않아 충전할 수 없어요.
          </p>
        )}
        {simulate.data && sent && (
          <p className="notice" role="status" data-testid="simulate-result">
            {simulateMessage(simulate.data, sent)}
          </p>
        )}
        {simulate.isError && <p className="error">결제 결과를 보내지 못했어요. 다시 시도해 주세요.</p>}
        {items.length > 0 && (
          <ul className="list" data-testid="top-up-list">
            {items.map((t) => (
              <TopUpRow
                key={t.id}
                topUp={t}
                busy={simulate.isPending}
                onSimulate={provider === 'mock' ? (result) => simulate.mutate({ id: t.id, result }) : null}
              />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore query={topUps} />
    </section>
  );
}
