import { EVENTS_PATH, type WidgetEventBody } from '@qrate/contracts';

// 위젯 사건 한 건(POST /api/events, 계약 @qrate/contracts/events.ts). DOM을 모르므로 단위 테스트로 고정한다.
// 베스트 에포트다 — 분석용이라 실패해도 방문자 화면은 그대로고 던지지 않는다.
// keepalive: 열자마자 페이지를 떠나도 요청이 끝까지 간다. sendBeacon(문자열)은 text/plain이라 서버의 express.json이 읽지 못한다.
// 대화창은 서버와 같은 오리진이라 상대 경로로 부르고, 브라우저가 붙이는 Origin이 서버의 Origin 검사를 통과한다.

export interface WidgetEventOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function sendWidgetEvent(body: WidgetEventBody, opts: WidgetEventOptions = {}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    await fetchImpl(`${opts.baseUrl ?? ''}${EVENTS_PATH}`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // 닿지 못한 사건은 버린다.
  }
}
