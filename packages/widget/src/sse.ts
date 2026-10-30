// SSE 수신 버퍼 파서.
//
// 왜 필요한가: fetch 스트림의 네트워크 청크는 SSE 이벤트 경계(\n\n)와 무관하게 끊긴다.
// 한 이벤트가 두 청크에 걸쳐 도착할 수 있으므로,
// "완결된 이벤트만 잘라내고 미완결분은 다음 청크와 합치도록 돌려주는" 버퍼링이 필수다.
// (면접 질문 12번 — 이 함수가 없으면 어떤 버그가 나는가?)

export interface SSEEvent {
  /** event: 필드. 없으면 SSE 기본값 'message'. */
  event: string;
  /** data: 필드. 여러 줄이면 \n으로 합쳐진다(SSE 스펙). */
  data: string;
}

export function drainSSEBuffer(buffer: string): { events: SSEEvent[]; rest: string } {
  const events: SSEEvent[] = [];
  const parts = buffer.split('\n\n');
  // 마지막 조각은 아직 \n\n으로 닫히지 않은 미완결 이벤트 — 호출자가 보관한다.
  const rest = parts.pop() ?? '';

  for (const part of parts) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
      // 그 외 필드(id:, retry:, 주석 ':')는 이 위젯에선 사용하지 않아 무시한다.
    }
    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join('\n') });
    }
  }

  return { events, rest };
}
