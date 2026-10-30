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
| WebSocket (Socket.io) | (채워 넣기 — Beyond Meet에서 직접 써봤다) | (채워 넣기) |
| SSE + EventSource | (채워 넣기) | (채워 넣기 — 힌트: GET 전용, 커스텀 헤더/본문 불가) |
| SSE + fetch 스트림 (선택) | (채워 넣기) | (채워 넣기) |
| HTTP 폴링 | (채워 넣기) | (채워 넣기) |

## 결정

- 전송 형식은 SSE(`text/event-stream`, `data:` 라인, `\n\n` 구분, `[DONE]` 센티널).
- 수신은 `EventSource`가 아니라 `fetch` + `ReadableStream` 수동 파싱
  (`packages/widget/src/sse.ts`의 `drainSSEBuffer`).

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

- `packages/widget/test/sse.test.ts`가 청크 경계 케이스를 고정한다.
- W5 평가셋에서 TTFT(first token time) p50/p95를 측정한다.
