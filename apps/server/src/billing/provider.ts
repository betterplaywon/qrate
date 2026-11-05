import type { PaymentProviderName } from '../repo/types.js';
import type { MockPaymentProvider } from './mock.js';
import type { SettlementEvent } from './settlement.js';

// 검증이 비동기인 이유: 토스 웹훅에는 서명이 없어 어댑터가 결제 조회 API로 상태를 다시 읽어 이벤트를 만든다(다음 PR).

export interface WebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export type WebhookVerification = { ok: true; event: SettlementEvent } | { ok: false; reason: 'signature' | 'malformed' };

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  verifyWebhook(req: WebhookRequest, now: Date): Promise<WebhookVerification>;
}

export interface PaymentProviders {
  mock?: MockPaymentProvider;
}

export function providerNamed(providers: PaymentProviders, name: string): PaymentProvider | null {
  return name === 'mock' ? (providers.mock ?? null) : null;
}
