import {
  CHAT_PATH,
  CONVERSATION_ID_HEADER,
  drainSSEBuffer,
  parseApiErrorBody,
  parseChatEvent,
  type ChatRequestBody,
  type Citation,
  type HandoffReason,
  type StopReason,
} from '@qrate/contracts';

// 대화 API 호출 한 번을 사건(ChatEvent)의 흐름으로 바꾼다. DOM을 모르므로 단위 테스트로 고정할 수 있다.
//
// 전송 형식(이벤트 이름·JSON 모양·[DONE]·오류 본문)은 @qrate/contracts가 정한다. 여기서는 HTTP 단계를 보탠다:
//   - 요청이 서버에 닿지 못함(connect) / 첫 조각 전 HTTP 오류(response, Retry-After) / 422 차단(blocked)
//   - 스트림 도중 event: error 또는 [DONE] 없이 끊김(stream)
//   - 응답 헤더 X-Conversation-Id → conversation 사건. 다음 요청 본문에 실으면 이전 턴이 문맥으로 들어간다
//
// 대화창은 서버와 같은 오리진에서 돌기 때문에 상대 경로(/api/chat)로 부른다. CORS가 없고, 브라우저가 붙이는 Origin이
// 서버 자신의 오리진이라 서버의 Origin 검사(apps/server/src/origin.ts)를 통과한다.

/** 화면에 그릴 인용. 서버가 보내는 Citation에서 표시에 필요한 필드만 쓴다. */
export type SourceCitation = Pick<Citation, 'sourceId' | 'title' | 'citedText'>;

export type FailureStage =
  /** 요청이 서버에 닿지 못함(네트워크, 서버 꺼짐). */
  | 'connect'
  /** 첫 조각 전에 서버가 HTTP 오류로 답함. */
  | 'response'
  /** 스트림 도중 실패(event: error) 또는 [DONE] 없이 끊김. 부분 답변이 화면에 남아 있을 수 있다. */
  | 'stream';

export type ChatEvent =
  | { type: 'conversation'; id: string }
  /** 입력이 경고 레벨. 답변은 계속된다. */
  | { type: 'moderation' }
  | { type: 'delta'; text: string }
  | { type: 'citation'; citation: SourceCitation }
  /** 모델이 "자료에 없는 질문"으로 판단해 상담원 연결을 권했다. 안내 문장은 delta로 이미 왔고, 이 사건은 연결로 이어 주는 길을 보이는 신호다. */
  | { type: 'handoff'; reason: HandoffReason; summary: string | null }
  /** 정상 종료([DONE]). stopReason은 그 앞의 event: done 값이다(없으면 null). */
  | { type: 'end'; stopReason: StopReason | null }
  /** 422 — 모더레이션 차단. 같은 메시지를 다시 보내도 같은 결과다. */
  | { type: 'blocked' }
  | { type: 'failed'; stage: FailureStage; status: number | null; retryable: boolean; retryAfterMs: number | null };

export interface StreamOptions {
  /** 대화 API의 기준 주소. 대화창은 같은 오리진이라 기본값 ''(상대 경로)을 쓴다. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 호출자가 끊으면(abort) failed를 내지 않고 조용히 끝난다. 의도한 중단은 실패가 아니다. */
  signal?: AbortSignal;
}

/** Retry-After 상한. 서버는 지금 2초를 보낸다. 엉뚱하게 큰 값에 버튼이 오래 잠기지 않게 자른다. */
const MAX_RETRY_AFTER_MS = 60_000;

export async function* streamChat(
  req: ChatRequestBody,
  opts: StreamOptions = {},
): AsyncGenerator<ChatEvent, void, undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lost: ChatEvent = { type: 'failed', stage: 'stream', status: null, retryable: true, retryAfterMs: null };

  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl ?? ''}${CHAT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: opts.signal,
    });
  } catch {
    if (opts.signal?.aborted) return;
    yield { type: 'failed', stage: 'connect', status: null, retryable: true, retryAfterMs: null };
    return;
  }

  if (res.status === 422) {
    yield { type: 'blocked' };
    return;
  }
  if (!res.ok || !res.body) {
    // 본문의 retryable이 기준이다. 본문이 계약의 오류 본문이 아니면(프록시 오류 페이지 등) 상태 코드로 짐작한다.
    let retryable = res.status === 429 || res.status === 503;
    try {
      retryable = parseApiErrorBody(await res.json())?.retryable ?? retryable;
    } catch {
      // JSON이 아니면 위의 짐작을 쓴다.
    }
    yield {
      type: 'failed',
      stage: 'response',
      status: res.status,
      retryable,
      retryAfterMs: retryable ? parseRetryAfter(res.headers.get('Retry-After')) : null,
    };
    return;
  }

  const conversationId = res.headers.get(CONVERSATION_ID_HEADER);
  if (conversationId) yield { type: 'conversation', id: conversationId };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stopReason: StopReason | null = null;

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        // 스트림 도중 연결이 끊김(네트워크, 서버 재시작).
        if (opts.signal?.aborted) return;
        yield lost;
        return;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      const { events, rest } = drainSSEBuffer(buffer);
      buffer = rest;

      for (const raw of events) {
        // 모르는 이벤트·형식이 다른 데이터는 건너뛴다. 서버가 이벤트 종류를 늘려도 이전 대화창이 깨지지 않게.
        const ev = parseChatEvent(raw);
        if (!ev) continue;
        switch (ev.type) {
          case 'end':
            yield { type: 'end', stopReason };
            return;
          case 'delta':
            if (ev.text) yield { type: 'delta', text: ev.text };
            break;
          case 'citation':
            yield { type: 'citation', citation: ev.citation };
            break;
          case 'handoff':
            yield { type: 'handoff', reason: ev.reason, summary: ev.summary };
            break;
          case 'moderation':
            yield { type: 'moderation' };
            break;
          case 'done':
            stopReason = ev.stopReason;
            break;
          case 'error':
            // 이 뒤에는 [DONE] 없이 연결이 끝난다(서버 계약). 재시도 여부는 서버가 정한다.
            yield { type: 'failed', stage: 'stream', status: null, retryable: ev.retryable, retryAfterMs: null };
            return;
        }
      }
    }
  } finally {
    // 소비자가 중간에 멈춰도(for await 탈출) 연결을 붙잡고 있지 않게 한다. 이미 끝난 스트림에는 아무 일도 없다.
    reader.cancel().catch(() => undefined);
  }

  // 서버 계약상 정상 종료에는 항상 [DONE]이 온다. 없이 끝났다면 중간에 끊긴 것이다.
  if (opts.signal?.aborted) return;
  yield lost;
}

/** Retry-After는 초(정수) 또는 HTTP 날짜다. 서버는 초를 보낸다. 날짜 형식은 지금 쓰지 않아 null로 둔다. */
export function parseRetryAfter(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return Math.min(Number(raw.trim()) * 1000, MAX_RETRY_AFTER_MS);
}
