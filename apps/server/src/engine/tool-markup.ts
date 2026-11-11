import { HANDOFF_TOOL_NAME, readHandoff } from './handoff.js';
import type { EngineEvent } from './types.js';

// 모델이 신호용 도구 호출을 tool_use 블록이 아니라 본문 글자(<invoke name="request_handoff"> …)로 쓰는 일이 있다
// (W5 평가에서 Sonnet 답 60개 중 1개). 그 글이 방문자에게 그대로 보이고, 신호는 서버에 닿지 않아 상담원 연결도 안 된다.
// 이 필터는 표지가 시작될 수 있는 꼬리만 잠깐 붙잡아 두고 나머지 조각은 바로 내보낸다. 표지가 확인되면 거기서부터 끝까지
// 내보내지 않고 모아 둔다 — 표지 뒤에 이어지는 글이 있어도 버린다(드문 경우라 닫는 태그를 찾아 다시 여는 복잡함을 들이지 않는다).

const MARKERS = ['<function_calls', '<invoke', '<parameter'] as const;

function firstMarker(text: string): number {
  let first = -1;
  for (const marker of MARKERS) {
    const at = text.indexOf(marker);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  return first;
}

/** 끝부분이 어떤 표지의 앞부분("<", "<inv" …)이면 그 길이. 아니면 0. */
function pendingMarkerLength(text: string): number {
  const lt = text.lastIndexOf('<');
  if (lt === -1) return 0;
  const tail = text.slice(lt);
  return MARKERS.some((marker) => marker.startsWith(tail)) ? tail.length : 0;
}

export class ToolMarkupFilter {
  private held = '';
  private leaked: string | null = null;

  /** 텍스트 조각을 받아 지금 방문자에게 내보내도 되는 부분을 돌려준다(빈 문자열일 수 있다). */
  push(chunk: string): string {
    if (this.leaked !== null) {
      this.leaked += chunk;
      return '';
    }
    const text = this.held + chunk;
    const at = firstMarker(text);
    if (at !== -1) {
      this.leaked = text.slice(at);
      this.held = '';
      return text.slice(0, at);
    }
    const pending = pendingMarkerLength(text);
    this.held = text.slice(text.length - pending);
    return text.slice(0, text.length - pending);
  }

  /** 스트림이 끝났을 때: 붙잡아 두었지만 표지가 아니었던 꼬리와, 내보내지 않은 표지 글. */
  end(): { rest: string; leaked: string | null } {
    const rest = this.leaked === null ? this.held : '';
    this.held = '';
    return { rest, leaked: this.leaked };
  }
}

function parameter(markup: string, name: string): string | undefined {
  // 끝까지 닫히지 않은 태그도 읽는다 — 글자로 쓴 호출은 닫는 태그 전에 끝나기도 한다(W5 h01).
  const match = new RegExp(`<parameter\\s+name="${name}">([\\s\\S]*?)(?:</parameter>|<parameter|$)`).exec(markup);
  return match?.[1]?.trim();
}

/** 글자로 쓴 호출에서 핸드오프 신호를 살린다. request_handoff 호출이 아니면 null. 사유·요약 검증은 진짜 도구 호출과 같다. */
export function handoffFromMarkup(markup: string): Extract<EngineEvent, { type: 'handoff' }> | null {
  if (!new RegExp(`<invoke\\s+name="${HANDOFF_TOOL_NAME}"`).test(markup)) return null;
  const input = { reason: parameter(markup, 'reason'), summary: parameter(markup, 'summary') };
  return readHandoff([{ type: 'tool_use', name: HANDOFF_TOOL_NAME, input }]);
}
