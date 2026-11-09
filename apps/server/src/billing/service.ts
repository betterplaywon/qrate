import { TOP_UP_PACKAGES } from '@qrate/contracts';
import type { ErrorReporter } from '../report.js';
import type { Repositories, SettleResult, TopUp } from '../repo/types.js';
import type { PaymentProvider, PaymentReading, WebhookRequest } from './provider.js';
import { decideSettlement, matchOrder, type IgnoreReason } from './settlement.js';

export type TopUpRequestResult =
  | { status: 'created' | 'replayed'; topUp: TopUp }
  | { status: 'key_reused' | 'unknown_package' | 'unavailable' };

/** 읽음을 판정·반영한 결과. 확정과 웹훅이 같은 함수(settleReading)로 끝나서 같은 모양을 쓴다. */
type ReadingOutcome =
  | { status: 'ignored'; reason: IgnoreReason }
  | { status: 'settled'; result: SettleResult }
  /** 제공자의 결제가 아직이거나 범위 밖이다. 주문은 그대로. */
  | { status: 'unsettled' }
  /** 제공자가 그런 결제는 없다고 했다. 사건 행을 만들지 않는다. */
  | { status: 'unverified' }
  /** 제공자에게 묻지 못했다. 주문은 그대로. */
  | { status: 'unavailable' };

export type WebhookResult = { status: 'unknown_provider' } | { status: 'rejected'; reason: 'signature' | 'malformed' } | ReadingOutcome;

export type ConfirmResult =
  /** 주문 없음·다른 테넌트·토스 주문 아님, 또는 토스 제공자가 꺼져 있음. */
  | { status: 'not_found' }
  /** 돌아온 금액이 주문 금액과 다르다(토스 호출 0). 또는 토스가 알려 준 결제가 이 주문·금액의 것이 아니다. */
  | { status: 'mismatch' }
  /** 토스가 확인해 준 결과를 반영했다(재확정·웹훅과 겹치면 replayed). */
  | { status: 'settled'; result: SettleResult }
  /** 토스가 아직 결제를 끝내지 않았거나 답을 받지 못했다. 같은 요청을 다시 보내면 된다. */
  | { status: 'unconfirmed' };

export interface BillingService {
  requestTopUp(tenantId: string, input: { requestKey: string; packageId: string }): Promise<TopUpRequestResult>;
  /**
   * 결제창 성공 주소로 돌아온 결제를 확정한다. 토스 제공자일 때만 뜻이 있다(라우트도 그때만 있다).
   * 순서: 테넌트의 토스 주문인가 → 돌아온 금액 = 주문 금액인가(아니면 토스를 부르지 않는다) → 토스 승인(애매하면 조회) → 판정·반영.
   * 같은 (주문, 결제 키)는 토스에 같은 멱등 키, 같은 사건 id, 같은 원장 키라서 몇 번 불러도 원장은 한 줄이다.
   */
  confirmTopUp(tenantId: string, input: { orderId: string; paymentKey: string; amount: number }): Promise<ConfirmResult>;
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
  /** 반영하는 길은 이것 하나다. 사건이 아닌 읽음은 반영하지 않고 보고만 한다(취소 알림은 기록만 한다는 결정도 여기다). */
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
        return { status: 'unsettled' };
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
      // 승인에는 어차피 주문 금액을 쓰지만, 돌아온 금액이 다르다는 것 자체가 주소 조작이나 버그의 신호라 토스를 부르지 않는다.
      if (amount !== matched.order.amount) {
        reportError(new Error('payment confirm refused: amount_mismatch'), { where: 'billing.confirm', provider: 'toss', orderId: matched.order.id });
        return { status: 'mismatch' };
      }
      const outcome = await settleReading(matched.order, await payments.confirm(matched.order, paymentKey), 'billing.confirm');
      switch (outcome.status) {
        case 'settled':
          return outcome;
        // 주문을 맞춰 본 뒤라, 판정이 무시하는 경우는 토스가 알려 준 결제가 이 주문·금액의 것이 아닐 때뿐이다.
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
        // 우리 장부의 이 제공자 주문이 아니면 제공자에게 묻지 않는다 — 위조 웹훅이 토스 조회를 불러내지 못하게.
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
