// SSE(text/event-stream) 전송 형식. 서버는 formatSSE로 쓰고, 위젯은 drainSSEBuffer로 읽는다.
//
// 왜 파서가 필요한가: fetch 스트림의 네트워크 청크는 SSE 이벤트 경계(\n\n)와 무관하게 끊긴다.
// 한 이벤트가 두 청크에 걸쳐 도착할 수 있으므로,
// "완결된 이벤트만 잘라내고 미완결분은 다음 청크와 합치도록 돌려주는" 버퍼링이 필수다.
// 버퍼링 없이 청크마다 바로 JSON.parse를 하면, 경계에 걸린 이벤트에서만 간헐적으로 깨진다.

export interface SSEEvent {
  /** event: 필드. 없으면 SSE 기본값 'message'. */
  event: string;
  /** data: 필드. 여러 줄이면 \n으로 합쳐진다(SSE 스펙). */
  data: string;
}

/** 이벤트 하나를 전송 형식으로 만든다. event가 null이면 event 줄을 생략한다(수신 쪽 기본값 message). */
export function formatSSE(event: string | null, data: string): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${data}\n\n`;
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
      // 그 외 필드(id:, retry:, 주석 ':')는 이 계약에서 쓰지 않아 무시한다.
    }
    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join('\n') });
    }
  }

  return { events, rest };
}
