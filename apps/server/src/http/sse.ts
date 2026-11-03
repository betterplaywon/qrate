import { encodeChatEvent, type ChatStreamEvent } from '@qrate/contracts';
import type { EngineEvent } from '../engine/types.js';

// 엔진 이벤트 → 위젯에 보내는 전송 이벤트.
// 전송 형식 자체(이벤트 이름·JSON 모양·[DONE])는 @qrate/contracts가 정하고, 여기서는 "무엇을 보내지 않는가"만 정한다:
// done의 토큰 사용량·실제 모델·폴백 여부는 운영자 정보라 빼고 stopReason(과 거절 카테고리)만 보낸다. 사용량은 서버 로그로 남는다.
// 첫 이벤트 전에 실패하면 SSE가 아니라 HTTP 상태 코드와 JSON 본문으로 답한다. (http/chat.ts)

function toChatStreamEvent(ev: EngineEvent): ChatStreamEvent {
  switch (ev.type) {
    case 'delta':
      return { type: 'delta', text: ev.text };
    case 'citation':
      return { type: 'citation', citation: ev.citation };
    case 'handoff':
      return { type: 'handoff', reason: ev.reason, summary: ev.summary };
    case 'done':
      return { type: 'done', stopReason: ev.stopReason, refusalCategory: ev.refusalCategory };
  }
}

export function sseForEngineEvent(ev: EngineEvent): string {
  return encodeChatEvent(toChatStreamEvent(ev));
}
