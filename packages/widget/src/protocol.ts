// 런처(고객 사이트 문서의 Shadow DOM)와 대화창(서버 오리진의 iframe) 사이의 postMessage 계약.
// 두 번들이 이 파일 하나를 함께 쓴다. 메시지 모양이 양쪽에서 어긋나지 않게 하기 위해서다.
//
// 싣는 것 (D1, 2026-11-02): 열림·닫힘·안 읽은 수뿐이다. 대화 내용·테넌트 정보·방문자 정보는 싣지 않는다.
// 런처 쪽 메시지는 고객 사이트의 어떤 스크립트든 볼 수 있다고 가정하고 설계한다.
//
// 받는 쪽은 세 가지를 모두 확인한다.
//   1. event.origin — 보낸 문서의 오리진. 브라우저가 채우므로 꾸밀 수 없다.
//   2. event.source — 보낸 창. 같은 페이지의 다른 iframe(광고 등)도 메시지를 보낼 수 있다.
//   3. 아래 parse 함수 — 이름표(ns·v)와 type, 필드 타입. 통과한 필드만 새 객체로 옮긴다.

export const MESSAGE_NS = 'qrate';
export const MESSAGE_VERSION = 1;

/** 대화창 → 런처 */
export type FrameMessage =
  /** 대화창 앱이 떴다. 런처는 이 메시지를 받은 뒤에야 열림 상태를 보낸다(그 전에 보내면 받을 리스너가 없다). */
  | { type: 'ready' }
  /** 대화창 안의 닫기 버튼이나 Esc. 열림 상태의 주인은 런처라서, 대화창은 닫아 달라고 요청만 한다. */
  | { type: 'close' }
  /** 패널이 닫힌 동안 끝난 답변 수. 열리면 0이 된다. */
  | { type: 'unread'; count: number };

/** 런처 → 대화창 */
export type LauncherMessage = { type: 'visibility'; open: boolean };

export type WireMessage<T extends FrameMessage | LauncherMessage> = T & {
  ns: typeof MESSAGE_NS;
  v: typeof MESSAGE_VERSION;
};

/** 안 읽은 수의 상한. 배지는 9+로 줄여 그리고, 이보다 큰 값은 잘못된 메시지로 본다. */
export const MAX_UNREAD = 999;

export function toWire<T extends FrameMessage | LauncherMessage>(msg: T): WireMessage<T> {
  return { ...msg, ns: MESSAGE_NS, v: MESSAGE_VERSION };
}

/** 이름표가 맞으면 필드를 읽을 수 있는 객체로, 아니면 null. 배열·null·원시값은 전부 null이다. */
function readEnvelope(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.ns !== MESSAGE_NS || d.v !== MESSAGE_VERSION || typeof d.type !== 'string') return null;
  return d;
}

/** 런처가 대화창에서 받은 데이터를 검증한다. 모르는 type, 틀린 필드 타입은 null(무시). */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  const d = readEnvelope(data);
  if (!d) return null;
  switch (d.type) {
    case 'ready':
      return { type: 'ready' };
    case 'close':
      return { type: 'close' };
    case 'unread': {
      const count = d.count;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > MAX_UNREAD) return null;
      return { type: 'unread', count };
    }
    default:
      return null;
  }
}

/** 대화창이 런처에서 받은 데이터를 검증한다. */
export function parseLauncherMessage(data: unknown): LauncherMessage | null {
  const d = readEnvelope(data);
  if (!d || d.type !== 'visibility' || typeof d.open !== 'boolean') return null;
  return { type: 'visibility', open: d.open };
}
