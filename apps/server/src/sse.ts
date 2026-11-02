import type { EngineEvent } from './engine/types.js';

// SSE 전송 계약 (ADR-0002 + W2 확장). 위젯 파서(packages/widget/src/sse.ts)와 짝이다.
//
//   data: {"delta":"..."}                        답변 조각. event 필드 없음(= message)
//   event: moderation  data: {level, reasons}    입력이 경고 레벨일 때, 첫 조각 전에 1회
//   event: citation    data: {...}               인용 (지식 연결). 답변 조각 사이에 끼어 온다
//   event: done        data: {stopReason, ...}   정상 종료 직전의 메타. 토큰 사용량은 보내지 않는다(운영자 정보)
//   event: error       data: {code, retryable}   스트림 시작 후 실패. 이 뒤에는 [DONE] 없이 연결이 끝난다
//   data: [DONE]                                  종료 센티널
//
// 첫 이벤트 전에 실패하면 SSE가 아니라 HTTP 상태 코드(503 등)와 JSON 본문으로 답한다. (src/chat.ts)

export const SSE_DONE = 'data: [DONE]\n\n';

export function formatSSE(event: string | null, data: unknown): string {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return `${event ? `event: ${event}\n` : ''}data: ${body}\n\n`;
}

export function sseForEngineEvent(ev: EngineEvent): string {
  switch (ev.type) {
    case 'delta':
      return formatSSE(null, { delta: ev.text });
    case 'citation':
      return formatSSE('citation', ev.citation);
    case 'done':
      return formatSSE('done', {
        stopReason: ev.stopReason,
        ...(ev.refusalCategory ? { refusalCategory: ev.refusalCategory } : {}),
      });
  }
}
