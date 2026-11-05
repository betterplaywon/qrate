import { TOP_UP_PACKAGES } from '@qrate/contracts';
import type { ErrorReporter } from '../report.js';
import type { PaymentProviderName, Repositories, SettleResult, TopUp } from '../repo/types.js';
import { providerNamed, type PaymentProviders, type WebhookRequest } from './provider.js';
import { decideSettlement, type IgnoreReason } from './settlement.js';

// 충전 유스케이스 — 콘솔의 충전 요청과 제공자의 웹훅. Express를 모른다(http/payments.ts와 http/console/top-ups.ts가 상태 코드로 옮긴다).

export type TopUpRequestResult =
  | { status: 'created' | 'replayed'; topUp: TopUp }
  | { status: 'key_reused' | 'unknown_package' | 'unavailable' };

export type WebhookResult =
  | { status: 'unknown_provider' }
  | { status: 'rejected'; reason: 'signature' | 'malformed' }
  | { status: 'ignored'; reason: IgnoreReason }
  | { status: 'settled'; result: SettleResult };

export interface BillingService {
  /** 충전을 받을 제공자. 없으면 null — 충전 요청은 unavailable이다. */
  readonly provider: PaymentProviderName | null;
  /** 같은 요청 키로 다시 오면 같은 주문(replayed). 같은 키에 다른 상품이면 key_reused. */
  requestTopUp(tenantId: string, input: { requestKey: string; packageId: string }): Promise<TopUpRequestResult>;
  /** 서명을 확인하기 전에는 DB를 건드리지 않는다. 서명이 맞으면 판정이 무시해도 받았다고 답해야 제공자가 재시도를 멈춘다. */
  receiveWebhook(provider: string, req: WebhookRequest): Promise<WebhookResult>;
}

export interface BillingDeps {
  repos: Pick<Repositories, 'topUps'>;
  providers: PaymentProviders;
  reportError: ErrorReporter;
  now?: () => Date;
}

export function createBillingService({ repos, providers, reportError, now = () => new Date() }: BillingDeps): BillingService {
  const provider: PaymentProviderName | null = providers.mock ? 'mock' : null;

  return {
    provider,

    async requestTopUp(tenantId, { requestKey, packageId }) {
      if (!provider) return { status: 'unavailable' };
      const pkg = TOP_UP_PACKAGES.find((p) => p.id === packageId);
      if (!pkg) return { status: 'unknown_package' };
      const { topUp, created } = await repos.topUps.create(tenantId, {
        requestKey,
        packageId: pkg.id,
        credits: pkg.credits,
        amount: pkg.amount,
        provider,
      });
      if (created) return { status: 'created', topUp };
      return topUp.packageId === packageId ? { status: 'replayed', topUp } : { status: 'key_reused' };
    },

    async receiveWebhook(name, req) {
      const source = providerNamed(providers, name);
      if (!source) return { status: 'unknown_provider' };
      const verified = await source.verifyWebhook(req, now());
      if (!verified.ok) return { status: 'rejected', reason: verified.reason };
      const { event } = verified;
      const decision = decideSettlement(await repos.topUps.findById(event.orderId), event);
      if (decision.kind === 'ignore') {
        // 서명이 맞는데 주문과 맞지 않는 이벤트는 제공자 설정·연동 사고의 신호다. HTTP 상태가 아니라 보고 통로로 알린다.
        reportError(new Error(`payment webhook ignored: ${decision.reason}`), {
          where: 'billing.webhook',
          provider: event.provider,
          eventId: event.eventId,
          orderId: event.orderId,
        });
        return { status: 'ignored', reason: decision.reason };
      }
      return { status: 'settled', result: await repos.topUps.settle(decision.settlement) };
    },
  };
}
