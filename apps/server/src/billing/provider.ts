import type { PaymentProviderName } from '../repo/types.js';
import type { MockPaymentProvider } from './mock.js';
import type { SettlementEvent } from './settlement.js';

// 결제 제공자 경계. 제공자마다 웹훅 서명 방식이 달라 검증은 어댑터가 하고, 결과는 제공자 중립의 SettlementEvent 하나로 모인다.
// 그 뒤(판정·저장)는 제공자를 모른다. 토스 어댑터는 서명 대신 결제 조회 API로 상태를 다시 읽어 이벤트를 만든다 — 그래서 검증이 비동기다.

export interface WebhookRequest {
  /** 받은 바이트 그대로. 서명은 원문에 걸려 있어 JSON으로 다시 직렬화하면 맞지 않는다. */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

/** 실패 이유는 둘뿐이다. 서명 쪽은 어느 단계(헤더·시각·값)에서 걸렸는지 알리지 않는다. */
export type WebhookVerification = { ok: true; event: SettlementEvent } | { ok: false; reason: 'signature' | 'malformed' };

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  verifyWebhook(req: WebhookRequest, now: Date): Promise<WebhookVerification>;
}

/** 설정된 제공자만 들어 있다. mock이 없으면 mock 웹훅·결제 시뮬레이션이 열리지 않는다. */
export interface PaymentProviders {
  mock?: MockPaymentProvider;
}

/** 웹훅 경로의 제공자 이름(외부 입력) → 설정된 제공자. 모르는 이름이거나 설정되지 않았으면 null. */
export function providerNamed(providers: PaymentProviders, name: string): PaymentProvider | null {
  return name === 'mock' ? (providers.mock ?? null) : null;
}
