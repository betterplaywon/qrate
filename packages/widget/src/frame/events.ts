import { EVENTS_PATH, type WidgetEventBody } from '@qrate/contracts';

export interface WidgetEventOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function sendWidgetEvent(body: WidgetEventBody, opts: WidgetEventOptions = {}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    await fetchImpl(`${opts.baseUrl ?? ''}${EVENTS_PATH}`, {
      method: 'POST',
      // keepalive: 열자마자 페이지를 떠나도 요청이 끝까지 간다. sendBeacon(문자열)은 text/plain이라 서버의 express.json이 읽지 못한다.
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // 닿지 못한 사건은 버린다.
  }
}
