import {
  CONSOLE_API_PATH,
  IDEMPOTENCY_KEY_HEADER,
  parseApiErrorBody,
  type ConsoleLoginBody,
  type ConsoleMetricsResponse,
  type ConsoleSessionResponse,
  type ConversationDetailResponse,
  type ConversationListResponse,
  type CreateTopUpBody,
  type CreditsResponse,
  type HandoffListResponse,
  type HandoffQueueItemDto,
  type HandoffStatus,
  type SimulatePaymentBody,
  type SimulatePaymentResponse,
  type TopUpDto,
  type TopUpListResponse,
  type UpdateHandoffBody,
} from '@qrate/contracts';
import ky, { HTTPError } from 'ky';

// 콘솔 API 클라이언트(ky). 페이지와 API가 같은 오리진이라 세션 쿠키는 브라우저가 알아서 싣는다.
// 4xx·5xx는 ky가 HTTPError로 던지고(본문은 ky가 미리 읽어 error.data에 둔다), 여기서 계약의 오류 코드를 읽어
// ApiError(상태 + 코드)로 바꾼다. 재시도는 하지 않는다 — 401은 "로그인 필요"라는 뜻이고(queries.ts가 처리), 그 밖의 실패를 조용히 반복할 이유가 없다.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
  }
}

const client = ky.create({ prefix: CONSOLE_API_PATH, retry: 0, headers: { accept: 'application/json' } });

/** ky가 미리 읽어 둔 오류 본문(error.data)에서 계약의 오류 코드를. 계약 모양이 아니면(프록시 오류 페이지 등) unknown_error. */
function toApiError(err: HTTPError): ApiError {
  return new ApiError(err.response.status, parseApiErrorBody(err.data)?.error ?? 'unknown_error');
}

async function run<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (err) {
    throw err instanceof HTTPError ? toApiError(err) : err;
  }
}

const search = (params: Record<string, string | null | undefined>): URLSearchParams => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return q;
};

export const api = {
  login: (body: ConsoleLoginBody) => run(client.post('login', { json: body }).json<ConsoleSessionResponse>()),
  logout: () => run(client.post('logout').then(() => undefined)),
  me: () => run(client.get('me').json<ConsoleSessionResponse>()),
  conversations: (cursor: string | null) =>
    run(client.get('conversations', { searchParams: search({ cursor }) }).json<ConversationListResponse>()),
  conversation: (id: string) => run(client.get(`conversations/${encodeURIComponent(id)}`).json<ConversationDetailResponse>()),
  credits: (cursor: string | null) => run(client.get('credits', { searchParams: search({ cursor }) }).json<CreditsResponse>()),
  metrics: () => run(client.get('metrics').json<ConsoleMetricsResponse>()),
  handoffs: (status: HandoffStatus | null, cursor: string | null) =>
    run(client.get('handoffs', { searchParams: search({ status, cursor }) }).json<HandoffListResponse>()),
  updateHandoff: (id: string, status: HandoffStatus) =>
    run(
      client
        .patch(`handoffs/${encodeURIComponent(id)}`, { json: { status } satisfies UpdateHandoffBody })
        .json<HandoffQueueItemDto>(),
    ),
  topUps: (cursor: string | null) => run(client.get('top-ups', { searchParams: search({ cursor }) }).json<TopUpListResponse>()),
  createTopUp: (body: CreateTopUpBody, key: string) =>
    run(client.post('top-ups', { json: body, headers: { [IDEMPOTENCY_KEY_HEADER]: key } }).json<TopUpDto>()),
  simulatePayment: (id: string, body: SimulatePaymentBody) =>
    run(client.post(`top-ups/${encodeURIComponent(id)}/simulate`, { json: body }).json<SimulatePaymentResponse>()),
};
