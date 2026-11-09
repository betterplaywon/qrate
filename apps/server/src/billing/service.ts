import { TOP_UP_PACKAGES } from '@qrate/contracts';
import type { ErrorReporter } from '../report.js';
import type { Repositories, SettleResult, TopUp } from '../repo/types.js';
import type { PaymentProvider, PaymentReading, WebhookRequest } from './provider.js';
import { decideSettlement, matchOrder, type IgnoreReason } from './settlement.js';

export type TopUpRequestResult =
  | { status: 'created' | 'replayed'; topUp: TopUp }
  | { status: 'key_reused' | 'unknown_package' | 'unavailable' };

/** 읽음을 판정·반영한 결과. */
type ReadingOutcome = { status: 'ignored'; reason: IgnoreReason } | { status: 'settled'; result: SettleResult };

export type WebhookResult = { status: 'unknown_provider' } | { status: 'rejected'; reason: 'signature' | 'malformed' } | ReadingOutcome;

export interface BillingService {
  requestTopUp(tenantId: string, input: { requestKey: string; packageId: string }): Promise<TopUpRequestResult>;
  /** 순서: 켜진 제공자인가 → 원문 읽기(바깥 호출 없음) → 우리 장부의 그 제공자 주문인가 → 그때만 결과를 읽는다 → 판정·반영. */
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
    const { event } = reading;
    const decision = decideSettlement(order, event);
    if (decision.kind === 'ignore') {
      reportError(new Error(`payment ignored: ${decision.reason}`), {
        where,
        provider: event.provider,
        eventId: event.eventId,
        orderId: order.id,
      });
      return { status: 'ignored', reason: decision.reason };
    }
    return { status: 'settled', result: await repos.topUps.settle(decision.settlement) };
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
