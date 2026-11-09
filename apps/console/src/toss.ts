import { CONSOLE_PATH, TOSS_SDK_URL, type TopUpDto } from '@qrate/contracts';
import { confirmTopUpSchema } from '@qrate/contracts/schemas';
import { createContext, useContext } from 'react';
import { z } from 'zod';
import { href } from './route';

/** 성공·실패 주소에 해시를 넣지 않는다 — 토스가 쿼리를 붙이는 자리를 v2 문서가 정하지 않아서(v1 위젯 문서는 해시 라우팅이면 리다이렉트를 처리할 수 없다고 적는다). */
const RETURN_PARAM = 'toss';

/** npm 패키지는 같은 CDN 스크립트를 넣는 로더라 들이지 않는다. */
interface TossPaymentsGlobal {
  (clientKey: string): { widgets(options: { customerKey: string }): TossWidgets };
  readonly ANONYMOUS: string;
}
interface TossWidgets {
  setAmount(amount: { currency: 'KRW'; value: number }): Promise<void>;
  renderPaymentWindow(options: {
    orderName: string;
    variantKey: { paymentMethod: 'DEFAULT'; agreement: 'AGREEMENT' };
  }): Promise<TossPaymentWindow>;
  requestPayment(options: { orderId: string; orderName: string; successUrl: string; failUrl: string }): Promise<void>;
}
interface TossPaymentWindow {
  on(event: 'paymentRequest' | 'cancel', handler: () => void): void;
  destroy(): Promise<void>;
}

export type TossSuccess = { kind: 'success'; orderId: string; paymentKey: string; amount: number };
export type TossReturn = TossSuccess | { kind: 'fail'; code: string } | { kind: 'unreadable' };

const successQuerySchema = z.object({
  orderId: z.string().min(1).max(64),
  paymentKey: confirmTopUpSchema.shape.paymentKey,
  amount: z
    .string()
    .regex(/^\d{1,12}$/)
    .transform(Number),
});
const FAIL_CODE = /^[A-Z0-9_]{1,64}$/;

/** replaceState는 hashchange를 일으키지 않아 해시를 바꾸면 주소와 화면이 어긋난다. */
export function clearTossReturn(location: Pick<Location, 'pathname' | 'hash'>, history: Pick<History, 'replaceState'>): void {
  history.replaceState(null, '', `${location.pathname}${location.hash}`);
}

/** replaceState는 hashchange를 일으키지 않아, 해시를 구독한 라우터가 따라오게 직접 알린다. */
function showBilling(history: Pick<History, 'replaceState'>, url: string): void {
  const oldURL = window.location.href;
  history.replaceState(null, '', url);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
}

export function takeTossReturn(location: Pick<Location, 'pathname' | 'search'>, history: Pick<History, 'replaceState'>): TossReturn | null {
  const query = new URLSearchParams(location.search);
  const marker = query.get(RETURN_PARAM);
  if (marker !== 'success' && marker !== 'fail') return null;
  if (marker === 'success') {
    const parsed = successQuerySchema.safeParse({ orderId: query.get('orderId'), paymentKey: query.get('paymentKey'), amount: query.get('amount') });
    if (parsed.success) {
      showBilling(history, `${location.pathname}${location.search}${href.billing()}`);
      return { kind: 'success', ...parsed.data };
    }
  }
  showBilling(history, `${location.pathname}${href.billing()}`);
  const code = marker === 'fail' ? query.get('code') : null;
  return code && FAIL_CODE.test(code) ? { kind: 'fail', code } : { kind: 'unreadable' };
}

export const TossReturnContext = createContext<TossReturn | null>(null);

export function useTossReturn(): TossReturn | null {
  return useContext(TossReturnContext);
}

let loading: Promise<TossPaymentsGlobal> | null = null;

function loadSdk(): Promise<TossPaymentsGlobal> {
  loading ??= new Promise<TossPaymentsGlobal>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TOSS_SDK_URL;
    script.onload = () => {
      const sdk = (window as Window & { TossPayments?: TossPaymentsGlobal }).TossPayments;
      if (sdk) resolve(sdk);
      else reject(new Error('토스 SDK가 TossPayments를 만들지 않았다'));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('토스 SDK를 불러오지 못했다'));
    };
    document.head.append(script);
  }).catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

export type TossWindowOutcome = 'requested' | 'canceled' | 'request_failed';

export async function openTossPaymentWindow({ clientKey, topUp }: { clientKey: string; topUp: TopUpDto }): Promise<TossWindowOutcome> {
  const TossPayments = await loadSdk();
  const widgets = TossPayments(clientKey).widgets({ customerKey: TossPayments.ANONYMOUS });
  await widgets.setAmount({ currency: 'KRW', value: topUp.amount });
  // renderPaymentWindow와 requestPayment의 orderName이 다르면 SDK가 요청을 거부한다.
  const orderName = `Qrate 크레딧 ${topUp.credits}`;
  const paymentWindow = await widgets.renderPaymentWindow({ orderName, variantKey: { paymentMethod: 'DEFAULT', agreement: 'AGREEMENT' } });
  const origin = window.location.origin;
  return new Promise<TossWindowOutcome>((resolve) => {
    const close = (outcome: TossWindowOutcome) => {
      paymentWindow.destroy().then(
        () => resolve(outcome),
        () => resolve(outcome),
      );
    };
    paymentWindow.on('paymentRequest', () => {
      widgets
        .requestPayment({
          orderId: topUp.id,
          orderName,
          successUrl: `${origin}${CONSOLE_PATH}/?${RETURN_PARAM}=success`,
          failUrl: `${origin}${CONSOLE_PATH}/?${RETURN_PARAM}=fail`,
        })
        .then(
          () => resolve('requested'),
          () => close('request_failed'),
        );
    });
    paymentWindow.on('cancel', () => close('canceled'));
  });
}
