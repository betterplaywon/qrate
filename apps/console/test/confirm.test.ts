import { QueryObserver, focusManager, onlineManager } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api';
import { confirmTopUpOptions } from '../src/queries';
import { queryClient } from '../src/queryClient';
import type { TossSuccess } from '../src/toss';

const ret: TossSuccess = { kind: 'success', orderId: 'order-1', paymentKey: 'tgen_1', amount: 10_000 };

/** 결제 화면 하나가 확정 쿼리를 쓰는 것처럼 구독하고, 이번 확정이 끝날 때까지 기다린다. 돌려준 함수는 화면을 내린다. */
async function mountBilling(): Promise<() => void> {
  const observer = new QueryObserver(queryClient, confirmTopUpOptions(queryClient, ret));
  const unmount = observer.subscribe(() => undefined);
  await vi.waitFor(() => expect(observer.getCurrentResult().fetchStatus).toBe('idle'));
  return unmount;
}

/** 포커스·재연결 뒤의 다시 묻기는 비동기로 시작한다(react-query가 멈춘 변경을 먼저 이어 간다). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeAll(() => {
  // 확정 queryFn은 결과가 정해지면 결제창에서 돌아온 주소를 지운다(clearTossReturn). DOM 없이 돌게 그 둘만 둔다.
  vi.stubGlobal('window', { location: { pathname: '/console/', hash: '#/billing' }, history: { replaceState: () => undefined } });
  queryClient.mount();
});

afterEach(() => {
  queryClient.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

afterAll(() => {
  queryClient.unmount();
  vi.unstubAllGlobals();
});

describe('결제 확정 쿼리', () => {
  it('결과가 정해진 실패(404) 뒤 창에 다시 포커스가 와도 확정 POST를 다시 보내지 않는다', async () => {
    const confirm = vi.spyOn(api, 'confirmTopUp').mockRejectedValue(new ApiError(404, 'not_found'));
    await mountBilling();
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('결과가 정해진 실패(404) 뒤 네트워크가 다시 이어져도 확정 POST를 다시 보내지 않는다', async () => {
    const confirm = vi.spyOn(api, 'confirmTopUp').mockRejectedValue(new ApiError(404, 'not_found'));
    await mountBilling();
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('실패한 확정은 화면이 다시 마운트되면(다시 로그인한 뒤 등) 한 번 더 묻는다', async () => {
    const confirm = vi.spyOn(api, 'confirmTopUp').mockRejectedValue(new ApiError(404, 'not_found'));
    const unmount = await mountBilling();
    unmount();
    await mountBilling();
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
