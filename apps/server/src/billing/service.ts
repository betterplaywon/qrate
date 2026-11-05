import { TOP_UP_PACKAGES } from '@qrate/contracts';
import type { ErrorReporter } from '../report.js';
import type { PaymentProviderName, Repositories, SettleResult, TopUp } from '../repo/types.js';
import { providerNamed, type PaymentProviders, type WebhookRequest } from './provider.js';
import { decideSettlement, type IgnoreReason } from './settlement.js';

export type TopUpRequestResult =
  | { status: 'created' | 'replayed'; topUp: TopUp }
  | { status: 'key_reused' | 'unknown_package' | 'unavailable' };

export type WebhookResult =
  | { status: 'unknown_provider' }
  | { status: 'rejected'; reason: 'signature' | 'malformed' }
  | { status: 'ignored'; reason: IgnoreReason }
  | { status: 'settled'; result: SettleResult };

export interface BillingService {
  readonly provider: PaymentProviderName | null;
  requestTopUp(tenantId: string, input: { requestKey: string; packageId: string }): Promise<TopUpRequestResult>;
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
