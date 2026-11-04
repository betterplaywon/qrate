import {
  CONSOLE_API_PATH,
  type ConsoleLoginBody,
  type ConsoleSessionResponse,
  type ConversationDetailResponse,
  type ConversationListResponse,
  type HandoffListResponse,
  type HandoffQueueItemDto,
  type HandoffStatus,
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

function toApiError(err: HTTPError): ApiError {
  const body: unknown = err.data;
  const code =
    typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : 'unknown_error';
  return new ApiError(err.response.status, code);
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
  handoffs: (status: HandoffStatus | null, cursor: string | null) =>
    run(client.get('handoffs', { searchParams: search({ status, cursor }) }).json<HandoffListResponse>()),
  updateHandoff: (id: string, status: HandoffStatus) =>
    run(
      client
        .patch(`handoffs/${encodeURIComponent(id)}`, { json: { status } satisfies UpdateHandoffBody })
        .json<HandoffQueueItemDto>(),
    ),
};
