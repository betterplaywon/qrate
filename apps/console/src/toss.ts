import { CONSOLE_PATH, type TopUpDto } from '@qrate/contracts';
import { confirmTopUpSchema } from '@qrate/contracts/schemas';
import { createContext, useContext } from 'react';
import { z } from 'zod';
import { href } from './route';

// 콘솔이 토스에 대해 아는 것은 전부 여기 있다: SDK를 불러오는 법, 결제창을 여는 순서, 결제창에서 돌아온 주소를 읽는 법.

/** 결제창형 SDK v2. 버전 없는 주소라 SRI를 걸 수 없다. 콘솔 CSP의 script-src가 이 호스트를 연다(서버 http/console/static.ts). */
const SDK_URL = 'https://js.tosspayments.com/v2/standard';
/** 성공·실패 주소의 표지. 해시 라우팅은 리다이렉트를 받을 수 없어서(토스 문서) # 없는 /console/?toss=… 로 돌아온다. */
const RETURN_PARAM = 'toss';
const BILLING_URL = `${CONSOLE_PATH}/${href.billing()}`;

/** 우리가 부르는 SDK 표면만 적은 타입. npm 패키지는 같은 CDN 스크립트를 넣는 로더라 들이지 않는다. */
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
export type TossReturn =
  | TossSuccess
  /**
   * code는 토스 오류 코드 모양만 받는다(null = 주소를 읽지 못함). 주소의 message는 받지 않는다 —
   * 누구나 이 주소를 만들어 운영자에게 보낼 수 있어, 화면에 쓰면 콘솔에 남의 문장이 뜬다.
   */
  | { kind: 'fail'; code: string | null };

const successQuerySchema = z.object({
  orderId: z.string().min(1).max(64),
  paymentKey: confirmTopUpSchema.shape.paymentKey,
  amount: z
    .string()
    .regex(/^\d{1,12}$/)
    .transform(Number),
});
const FAIL_CODE = /^[A-Z0-9_]{1,64}$/;

/** 확정 결과가 정해지면 돌아온 주소의 쿼리를 지운다. 그 뒤의 새로고침은 같은 결제를 다시 묻지 않는다. */
export function clearTossReturn(history: Pick<History, 'replaceState'>): void {
  history.replaceState(null, '', BILLING_URL);
}

/**
 * 부팅 때 한 번(main.tsx, 첫 렌더 전): 결제창에서 돌아온 주소면 읽고 해시를 #/billing으로 바꾼다. 첫 렌더 전이어야 해시 라우팅이 충전 화면을 고른다.
 * 성공 주소의 쿼리는 확정 결과가 정해질 때까지 남긴다 — 응답을 잃은 확정을 새로고침으로 같은 결제에 다시 묻는 길이다(웹훅 없는 개발 환경).
 * 실패 주소는 바로 지운다. 돌아온 주소가 아니면 null이고 주소를 건드리지 않는다.
 */
export function takeTossReturn(location: Pick<Location, 'pathname' | 'search'>, history: Pick<History, 'replaceState'>): TossReturn | null {
  const query = new URLSearchParams(location.search);
  const marker = query.get(RETURN_PARAM);
  if (marker !== 'success' && marker !== 'fail') return null;
  if (marker === 'success') {
    const parsed = successQuerySchema.safeParse({ orderId: query.get('orderId'), paymentKey: query.get('paymentKey'), amount: query.get('amount') });
    if (parsed.success) {
      history.replaceState(null, '', `${location.pathname}${location.search}${href.billing()}`);
      return { kind: 'success', ...parsed.data };
    }
  }
  clearTossReturn(history);
  const code = marker === 'fail' ? query.get('code') : null;
  return { kind: 'fail', code: code && FAIL_CODE.test(code) ? code : null };
}

/** 부팅 때 읽은 돌아온 주소. 한 번 정해지고 바뀌지 않는 값이라 컨텍스트로 둔다(App·Shell·Billing을 거치는 props 대신). */
export const TossReturnContext = createContext<TossReturn | null>(null);

export function useTossReturn(): TossReturn | null {
  return useContext(TossReturnContext);
}

let loading: Promise<TossPaymentsGlobal> | null = null;

/** 스크립트는 처음 부를 때 한 번만 넣는다. 진행 중인 Promise를 재사용해 두 번 불러도 태그는 하나다. 실패하면 다음 클릭에 다시 시도한다. */
function loadSdk(): Promise<TossPaymentsGlobal> {
  loading ??= new Promise<TossPaymentsGlobal>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK_URL;
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

/** requested = 결제를 요청해 곧 성공·실패 주소로 떠난다. canceled = 결제창을 닫았다. request_failed = 결제창은 떴는데 요청이 실패했다. */
export type TossWindowOutcome = 'requested' | 'canceled' | 'request_failed';

/**
 * 결제창을 띄운다. 결제하기를 누를 때만 SDK를 불러온다. 창이 뜨면 onShown을 부른다 — 그 뒤로 이 주문은 토스에 넘어갈 수 있어,
 * 폼은 그때 충전 요청의 멱등 키를 버린다(다음 클릭은 새 주문). SDK를 못 불러오거나 창을 못 그리면 onShown 없이 거부한다.
 * 결제창은 한 번에 하나만 그릴 수 있어서, 닫히거나 요청이 실패하면 창을 치운다.
 */
export async function openTossPaymentWindow({
  clientKey,
  topUp,
  onShown,
}: {
  clientKey: string;
  topUp: TopUpDto;
  onShown: () => void;
}): Promise<TossWindowOutcome> {
  const TossPayments = await loadSdk();
  const widgets = TossPayments(clientKey).widgets({ customerKey: TossPayments.ANONYMOUS });
  await widgets.setAmount({ currency: 'KRW', value: topUp.amount });
  // renderPaymentWindow와 requestPayment의 orderName이 다르면 SDK가 요청을 거부한다.
  const orderName = `Qrate 크레딧 ${topUp.credits}`;
  const paymentWindow = await widgets.renderPaymentWindow({ orderName, variantKey: { paymentMethod: 'DEFAULT', agreement: 'AGREEMENT' } });
  onShown();
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
