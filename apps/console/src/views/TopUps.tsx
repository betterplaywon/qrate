import { zodResolver } from '@hookform/resolvers/zod';
import {
  TOP_UP_PACKAGES,
  type ConfirmTopUpResponse,
  type PaymentResult,
  type SimulatePaymentResponse,
  type TopUpCheckout,
  type TopUpDto,
} from '@qrate/contracts';
import { createTopUpSchema, type CreateTopUpInput } from '@qrate/contracts/schemas';
import { useRef } from 'react';
import { useForm } from 'react-hook-form';
import { ApiError } from '../api';
import { LoadMore } from '../components/LoadMore';
import { QueryBoundary } from '../components/QueryBoundary';
import { TOP_UP_STATUS_LABEL, formatTime, formatWon } from '../labels';
import { settledConfirmError, useConfirmTopUp, useCreateTopUp, useSimulatePayment, useTopUps, useTossPaymentWindow } from '../queries';
import { useTossReturn, type TossReturn, type TossSuccess, type TossWindowOutcome } from '../toss';

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

function windowMessage(outcome: TossWindowOutcome | undefined, failed: boolean): string | null {
  if (failed) return '결제창을 열지 못했어요. 다시 누르면 같은 주문으로 열어요.';
  if (outcome === 'canceled') return '결제창을 닫았어요. 주문은 결제 대기로 남아요.';
  if (outcome === 'request_failed') return '결제를 요청하지 못했어요. 주문은 결제 대기로 남아요. 다시 누르면 새 주문으로 결제해요.';
  return null;
}

function failMessage(ret: Exclude<TossReturn, TossSuccess>): string {
  if (ret.kind === 'unreadable') return '결제창에서 돌아온 주소를 읽지 못했어요. 충전 내역에서 상태를 확인해 주세요.';
  if (ret.code === 'PAY_PROCESS_CANCELED' || ret.code === 'USER_CANCEL') return '결제를 취소했어요. 주문은 결제 대기로 남아요.';
  return `결제 인증에 실패했어요(${ret.code}). 주문은 결제 대기로 남아요.`;
}

function confirmMessage(r: Exclude<ConfirmTopUpResponse, { outcome: 'unconfirmed' }>): string {
  if (r.topUp.status === 'paid') {
    return r.outcome === 'applied' && !r.replayed ? `${r.topUp.credits}크레딧을 충전했어요.` : '이미 충전된 결제예요. 크레딧은 한 번만 들어가요.';
  }
  if (r.topUp.status === 'failed') return '결제가 승인되지 않았어요. 잔액은 그대로예요. 다시 충전하면 새 주문으로 결제해요.';
  return '이미 처리된 결제예요. 잔액은 그대로예요.';
}

function TossConfirm({ ret }: { ret: TossSuccess }) {
  const confirm = useConfirmTopUp(ret);
  if (confirm.isPending) return <p className="status">결제를 확인하는 중…</p>;
  const settled = confirm.isError ? settledConfirmError(confirm.error) : null;
  if (settled) {
    return (
      <p className="notice" role="status" data-testid="toss-return">
        {settled}
      </p>
    );
  }
  if (confirm.isError || confirm.data.outcome === 'unconfirmed') {
    return (
      <div className="notice" role="status" data-testid="toss-return">
        <p>토스에서 결제 완료를 아직 확인하지 못했어요.</p>
        <button type="button" className="small" disabled={confirm.isFetching} onClick={() => void confirm.refetch()}>
          다시 확인
        </button>
        <span className="muted"> 같은 결제로 다시 물어봐요. 두 번 결제되지 않아요.</span>
      </div>
    );
  }
  return (
    <p className="notice" role="status" data-testid="toss-return">
      {confirmMessage(confirm.data)}
    </p>
  );
}

function TossReturnNotice({ ret }: { ret: TossReturn }) {
  if (ret.kind === 'success') return <TossConfirm ret={ret} />;
  return (
    <p className="notice" role="status" data-testid="toss-return">
      {failMessage(ret)}
    </p>
  );
}

function TopUpForm({ checkout }: { checkout: TopUpCheckout }) {
  const create = useCreateTopUp();
  const payWindow = useTossPaymentWindow();
  const attempt = useRef<{ packageId: string; key: string } | null>(null);
  const form = useForm<CreateTopUpInput>({ resolver: zodResolver(createTopUpSchema), defaultValues: { packageId: 'credits_100' } });
  const busy = form.formState.isSubmitting || create.isPending || payWindow.isPending;
  const error = requestErrorMessage(create.error);
  const notice = windowMessage(payWindow.data, payWindow.isError);
  const idleLabel = checkout.provider === 'toss' ? '결제하기' : '충전 요청';

  const submit = form.handleSubmit(async ({ packageId }) => {
    const current = attempt.current?.packageId === packageId ? attempt.current : { packageId, key: crypto.randomUUID() };
    attempt.current = current;
    payWindow.reset();
    const topUp: TopUpDto | null = await create.mutateAsync({ body: { packageId }, key: current.key }).catch(() => null);
    if (!topUp) return;
    if (checkout.provider === 'mock') {
      attempt.current = null;
      return;
    }
    const outcome = await payWindow.mutateAsync({ clientKey: checkout.clientKey, topUp }).catch(() => null);
    if (outcome) attempt.current = null;
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
      {notice && (
        <p className="notice" role="status" data-testid="payment-window-notice">
          {notice}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {busy ? '요청하는 중…' : idleLabel}
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
  const tossReturn = useTossReturn();
  const items = topUps.data?.pages.flatMap((p) => p.items) ?? [];
  const page = topUps.data?.pages[0];
  const checkout: TopUpCheckout | null = page && page.provider !== null ? page : null;
  const sent = simulate.variables?.result;

  return (
    <section className="top-ups" aria-labelledby="top-ups-title">
      <h3 id="top-ups-title" className="subhead">
        충전
      </h3>
      {tossReturn && <TossReturnNotice ret={tossReturn} />}
      <QueryBoundary pending={topUps.isPending} error={topUps.isError && '충전 내역을 불러오지 못했어요.'}>
        {checkout ? (
          <TopUpForm checkout={checkout} />
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
                onSimulate={checkout?.provider === 'mock' ? (result) => simulate.mutate({ id: t.id, result }) : null}
              />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore query={topUps} />
    </section>
  );
}
