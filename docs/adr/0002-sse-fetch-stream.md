# ADR-0002: 응답 스트리밍은 SSE, 수신은 fetch + ReadableStream

- 상태: proposed → 본인이 근거를 채운 뒤 accepted로 변경할 것
- 날짜: 2026-10-30
- 작성: 강지원

## 맥락

AI 응답은 수 초가 걸리므로 "다 되면 한 번에"가 아니라 토큰 단위로 흘려보내야 한다.
서버→위젯 전송 방식을 정해야 한다.

## 고려한 대안

| 대안 | 장점 | 단점 |
| --- | --- | --- |
| WebSocket (Socket.io) | 한 연결로 양방향(클라이언트발 이벤트도 같은 연결로), 자동 재연결·끊긴 동안 패킷 버퍼링·응답 확인(ack), Beyond Meet에서 직접 써 봄 | Socket.IO는 WebSocket 구현이 아니라 위젯에 Socket.IO 클라이언트가 따로 필요, 서버가 여럿이면 sticky session(롱 폴링 폴백을 쓸 때)과 브로드캐스트용 어댑터(Redis 등)가 필요 |
| SSE + EventSource | 브라우저 내장이라 파서 없이 이벤트를 받음, 끊기면 자동으로 다시 연결하고 `Last-Event-ID`로 이어 받음 | GET만 되고 요청 헤더·본문을 못 실음(생성자 옵션은 `withCredentials`뿐), 실패 응답의 상태 코드·헤더를 스크립트가 못 읽음(422·402·429와 `X-Conversation-Id`를 알 수 없음) |
| SSE + fetch 스트림 (선택) | POST 본문(`message`·`tenant`·`conversationId`)을 실음, 첫 조각 전 실패를 상태 코드·`Retry-After`로 받고 `X-Conversation-Id` 헤더를 읽음, 보통 HTTP 요청이라 Origin 검사·IP 요율 제한·32kb 본문 상한이 그대로 걸림 | SSE 파싱과 청크 경계 버퍼링을 직접 구현(`drainSSEBuffer`), 자동 재연결·`Last-Event-ID`가 없어 재시도를 위젯이 정함(서버가 retryable이라 한 실패에만 다시 보내기 버튼) |
| HTTP 폴링 | 평범한 요청·응답이라 연결을 붙잡지 않음, 스트림 파서가 필요 없음 | 새 조각이 다음 요청까지 서버에 쌓여 폴링 간격만큼 늦게 보임, 새 데이터가 없어도 요청·응답 왕복이 생김, 요청 사이에 생성 중인 답을 서버가 보관해야 함 |

## 결정

- 전송 형식은 SSE(`text/event-stream`, `data:` 라인, `\n\n` 구분, `[DONE]` 센티널).
- 수신은 `EventSource`가 아니라 `fetch` + `ReadableStream` 수동 파싱
  (`packages/contracts/src/sse.ts`의 `drainSSEBuffer` — 서버·위젯이 함께 쓰는 계약 패키지).

## 스스로 답해볼 유도 질문

1. Beyond Meet에서는 Socket.io를 골랐고(매칭 취소 등 **클라이언트발 이벤트** 필요)
   여기서는 SSE를 골랐다. 두 상황의 결정 기준 차이를 한 문장으로 말하면?
   — 이 비교가 "같은 사람이 상황에 따라 다른 선택을 한다"는 최고의 면접 답변이 된다.
2. EventSource를 못 쓰는 직접적 이유는? (메시지 본문을 실어야 하는 POST)
3. 네트워크 청크가 이벤트 경계와 어긋날 수 있는데(`drainSSEBuffer`가 존재하는 이유),
   버퍼링 없이 구현하면 실제로 어떤 증상이 나는가? (JSON.parse 간헐 실패)
4. 재연결은 누구 책임인가? EventSource는 자동 재연결이 있지만 fetch 스트림은 없다 —
   W2에서 재시도 정책을 어디(위젯)에 어떻게 넣을 것인가?

## 트레이드오프

(본인 작성)

## 결과 확인 방법

- `packages/contracts/test/sse.test.ts`가 청크 경계 케이스를, `packages/contracts/test/chat.test.ts`가 이벤트 encode↔parse 왕복을 고정한다.
- W5 평가셋에서 TTFT(first token time) p50/p95를 측정한다.
