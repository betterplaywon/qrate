import { TOP_UP_PACKAGES } from '@qrate/contracts';
import type { ErrorReporter } from '../report.js';
import type { Repositories, SettleResult, TopUp } from '../repo/types.js';
import type { PaymentProvider, PaymentReading, WebhookRequest } from './provider.js';
import { decideSettlement, matchOrder, type EventMismatch, type OrderMatchFailure } from './settlement.js';

export type TopUpRequestResult =
  | { status: 'created' | 'replayed'; topUp: TopUp }
  | { status: 'key_reused' | 'unknown_package' | 'unavailable' };

type ReadingOutcome =
  | { status: 'ignored'; reason: EventMismatch }
  | { status: 'settled'; result: SettleResult }
  | { status: 'unsettled'; scope: 'open' | 'out_of_scope' }
  | { status: 'unverified' }
  | { status: 'unavailable' };

export type WebhookResult =
  | { status: 'unknown_provider' }
  | { status: 'rejected'; reason: 'signature' | 'malformed' }
  | { status: 'ignored'; reason: OrderMatchFailure }
  | ReadingOutcome;

export type ConfirmResult =
  | { status: 'not_found' }
  | { status: 'mismatch' }
  | { status: 'settled'; result: SettleResult }
  | { status: 'unconfirmed' };

export interface BillingService {
  requestTopUp(tenantId: string, input: { requestKey: string; packageId: string }): Promise<TopUpRequestResult>;
  confirmTopUp(tenantId: string, input: { orderId: string; paymentKey: string; amount: number }): Promise<ConfirmResult>;
  receiveWebhook(provider: string, req: WebhookRequest): Promise<WebhookResult>;
}

export interface BillingDeps {
  repos: Pick<Repositories, 'topUps'>;
  payments: PaymentProvider | null;
  reportError: ErrorReporter;
  now?: () => Date;
}

export function createBillingService({ repos, payments, reportError, now = () => new Date() }: BillingDeps): BillingService {
  async function settleReading(order: TopUp, reading: PaymentReading, where: string): Promise<ReadingOutcome> {
    const context = { where, provider: order.provider, orderId: order.id };
    switch (reading.kind) {
      case 'event': {
        const { event } = reading;
        const decision = decideSettlement(order, event);
        if (decision.kind === 'settle') return { status: 'settled', result: await repos.topUps.settle(decision.settlement) };
        reportError(new Error(`payment ignored: ${decision.reason}`), { ...context, provider: event.provider, eventId: event.eventId });
        return { status: 'ignored', reason: decision.reason };
      }
      case 'unsettled':
        reportError(new Error(`payment unsettled: ${reading.status}`), {
          ...context,
          status: reading.status,
          scope: reading.scope,
          detail: reading.detail,
        });
        return { status: 'unsettled', scope: reading.scope };
      case 'not_found':
        reportError(new Error('payment not found at provider'), { ...context, detail: reading.detail });
        return { status: 'unverified' };
      case 'unavailable':
        reportError(new Error('payment provider unavailable'), { ...context, detail: reading.detail });
        return { status: 'unavailable' };
    }
  }

  return {
    async requestTopUp(tenantId, { requestKey, packageId }) {
      if (!payments) return { status: 'unavailable' };
      const pkg = TOP_UP_PACKAGES.find((p) => p.id === packageId);
      if (!pkg) return { status: 'unknown_package' };
      const { topUp, created } = await repos.topUps.create(tenantId, {
        requestKey,
        packageId: pkg.id,
        credits: pkg.credits,
        amount: pkg.amount,
        provider: payments.name,
      });
      if (created) return { status: 'created', topUp };
      if (topUp.packageId !== packageId) return { status: 'key_reused' };
      // 재요청에는 처음 응답과 같은 주문을 준다. 그 사이 결제가 끝났어도 그렇다 — 처음 응답은 늘 만든 직후의 주문이고,
      // 그 뒤에 바뀌는 것은 상태와 시각뿐이라 저장 없이 되살릴 수 있다. 지금 상태는 목록 조회가 맡는다.
      return { status: 'replayed', topUp: { ...topUp, status: 'pending', settledAt: null, updatedAt: topUp.createdAt } };
    },

    async confirmTopUp(tenantId, { orderId, paymentKey, amount }) {
      if (payments?.name !== 'toss') return { status: 'not_found' };
      const matched = matchOrder(await repos.topUps.findForTenant(orderId, tenantId), payments.name);
      if (!matched.ok) return { status: 'not_found' };
      if (amount !== matched.order.amount) {
        reportError(new Error('payment confirm refused: amount_mismatch'), { where: 'billing.confirm', provider: 'toss', orderId: matched.order.id });
        return { status: 'mismatch' };
      }
      const outcome = await settleReading(matched.order, await payments.confirm(matched.order, paymentKey), 'billing.confirm');
      switch (outcome.status) {
        case 'settled':
          return outcome;
        case 'ignored':
          return { status: 'mismatch' };
        case 'unsettled':
        case 'unverified':
        case 'unavailable':
          return { status: 'unconfirmed' };
      }
    },

    async receiveWebhook(name, req) {
      if (!payments || payments.name !== name) return { status: 'unknown_provider' };
      const notice = payments.readWebhook(req, now());
      if (!notice.ok) return { status: 'rejected', reason: notice.reason };
      const matched = matchOrder(await repos.topUps.findById(notice.orderId), payments.name);
      if (!matched.ok) {
        reportError(new Error(`payment ignored: ${matched.reason}`), {
          where: 'billing.webhook',
          provider: payments.name,
          orderId: notice.orderId,
        });
        return { status: 'ignored', reason: matched.reason };
      }
      return settleReading(matched.order, await notice.read(), 'billing.webhook');
    },
  };
}
