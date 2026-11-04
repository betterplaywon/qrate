// 상담원 연결 요청 API — 방문자가 대화창의 "상담원 연결" 버튼으로 보낸다. 콘솔 결정(2026-11-04) 핸드오프 A: 큐 + 상태 + 연락처.
//
//   POST /api/handoff   HandoffRequestBody → 201 HandoffRequestResponse. 대화 API와 같은 Origin 검사(같은 오리진의 대화창만), IP당 요율 제한.
//                       400 invalid_contact(이메일이 아니거나 너무 긺) · message_too_long · tenant is required, 404 unknown_tenant, 429 too_many_requests
//
// 요청은 콘솔의 미응답 큐에 source=visitor 항목으로 들어가고, 운영자가 밖(이메일 등)에서 답한 뒤 상태를 옮긴다.
// 대화 id는 위젯이 이전 응답 헤더로 받은 값이다. 이 테넌트의 대화가 아니거나 없으면 서버가 새 대화를 만들어 응답에 알려 준다 —
// 질문 전에 눌러도 접수되고, 그 뒤의 질문은 같은 대화로 이어진다.

export const HANDOFF_PATH = '/api/handoff';
export const MAX_HANDOFF_CONTACT_CHARS = 200;
export const MAX_HANDOFF_MESSAGE_CHARS = 500;

export interface HandoffRequestBody {
  /** 위젯 설치 스니펫의 data-tenant 값. */
  tenant: string;
  conversationId?: string | null;
  /** 답을 받을 이메일. */
  contact: string;
  /** 남길 말(선택). 콘솔에는 요약 자리에 보인다. */
  message?: string | null;
}

export interface HandoffRequestResponse {
  id: string;
  /** 요청이 붙은 대화. 위젯은 이 값을 다음 질문에 싣는다. */
  conversationId: string;
}
