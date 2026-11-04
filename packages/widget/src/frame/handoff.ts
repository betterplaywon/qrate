import { HANDOFF_PATH, parseApiErrorBody, type HandoffRequestBody, type HandoffRequestResponse } from '@qrate/contracts';

// 상담원 연결 요청 한 번(POST /api/handoff). DOM을 모르므로 단위 테스트로 고정한다. 전송 형식은 @qrate/contracts/handoff.ts.
// 대화창은 서버와 같은 오리진이라 상대 경로로 부르고, 브라우저가 붙이는 Origin이 서버의 Origin 검사를 통과한다.

export type HandoffResult =
  | { ok: true; id: string; conversationId: string }
  /** 서버가 거절했거나(code = 계약의 오류 코드) 닿지 못했다(status·code null). */
  | { ok: false; status: number | null; code: string | null };

export interface HandoffOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function requestHandoff(body: HandoffRequestBody, opts: HandoffOptions = {}): Promise<HandoffResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl ?? ''}${HANDOFF_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: null, code: null };
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // 본문이 JSON이 아니면(프록시 오류 페이지 등) 상태 코드만 남긴다.
  }
  if (!res.ok) return { ok: false, status: res.status, code: parseApiErrorBody(json)?.error ?? null };

  const data = json as Partial<HandoffRequestResponse> | null;
  if (typeof data?.id !== 'string' || typeof data.conversationId !== 'string') return { ok: false, status: res.status, code: null };
  return { ok: true, id: data.id, conversationId: data.conversationId };
}
