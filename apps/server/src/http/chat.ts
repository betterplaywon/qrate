import { CONVERSATION_ID_HEADER, encodeChatEvent, type ApiErrorBody, type ApiErrorCode } from '@qrate/contracts';
import { chatRequestSchema } from '@qrate/contracts/schemas';
import type { Request, Response } from 'express';
import type { ChatService } from '../chat/service.js';
import { asEngineError, type EngineError, type EngineErrorCode, type EngineEvent, type HandoffReason } from '../engine/types.js';
import type { EventSink } from '../events/sink.js';
import { reportToStderr, type ErrorReporter } from '../report.js';
import type { ChatRequestPayload, EngineRunFacts } from '../repo/types.js';
import { sseForEngineEvent } from './sse.js';

// POST /api/chat — 대화 유스케이스(chat/service.ts)를 HTTP와 SSE로 옮기는 어댑터.
// 여기서 정하는 것: 본문 모양·길이 검사(400), 결과 종류 → 상태 코드(404·422·402), 엔진 실패 코드 → 상태 코드(statusFor),
// 첫 이벤트 전 실패 → HTTP 상태 + Retry-After, 그 뒤 실패 → event: error, 클라이언트 끊김 → 엔진 중단, 엔진을 부른 요청 1건의 chat_request 사건.

type DoneEvent = Extract<EngineEvent, { type: 'done' }>;

export interface ChatHandlerDeps {
  chat: ChatService;
  /**
   * 엔진을 부른 요청마다 chat_request 사건 정확히 한 건. 거절(422·402)은 남기지 않는다 — 모델을 부르지 않아 비용이 0이고,
   * 남기면 공개 키만으로 행을 쌓을 수 있다(app.ts의 IP당 요율 제한은 IP 하나의 속도만 누른다). app.ts가 기본값(저장소 통로)을 넣는다.
   */
  recordEvent: EventSink;
  /** 예상 밖의 엔진 실패(인증·잘못된 요청·미분류)의 보고 통로. 요율 제한·일시 장애는 chat_request 사건으로 충분해 보내지 않는다. */
  reportError?: ErrorReporter;
}

/** 엔진 실패 코드 → 첫 이벤트 전 실패의 HTTP 상태. 엔진은 코드와 재시도 여부만 말하고(engine/types.ts), 상태는 여기서만 정한다. */
export function statusFor(code: EngineErrorCode): number {
  switch (code) {
    case 'rate_limited':
    case 'upstream_unavailable':
      return 503;
    case 'upstream_auth':
    case 'upstream_error':
      return 502;
    case 'upstream_bad_request':
      return 500;
    case 'aborted':
      return 499; // 응답할 상대가 없다 — 실제로 보내지는 않는다
  }
}

const REPORTED_CODES: ReadonlySet<EngineErrorCode> = new Set(['upstream_auth', 'upstream_bad_request', 'upstream_error']);

/** 스키마 위반 → 계약의 오류 코드. 메시지 문제가 테넌트 문제보다 먼저고, 너무 긴 메시지는 따로 알린다(위젯이 안내 문구를 나눈다). */
function chatBodyError(issues: readonly { path: PropertyKey[]; code: string }[]): ApiErrorCode {
  const message = issues.filter((i) => i.path[0] === 'message');
  if (message.some((i) => i.code === 'too_big')) return 'message_too_long';
  if (message.length > 0) return 'message is required';
  return 'tenant is required';
}

export function createChatHandler({ chat, recordEvent, reportError = reportToStderr }: ChatHandlerDeps) {
  return async function handleChat(req: Request, res: Response): Promise<void> {
    const receivedAt = new Date();
    // 본문 모양은 계약의 zod 스키마(@qrate/contracts/schemas). 메시지 길이 상한은 본문 32kb 상한(app.ts)과 별개다 —
    // 테넌트 키는 공개값이라 긴 입력은 곧 요청당 입력 토큰 비용이다. 테넌트 키는 모든 요청이 명시한다(W1의 'demo' 기본값은 제거).
    const parsed = chatRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: chatBodyError(parsed.error.issues) } satisfies ApiErrorBody);
      return;
    }
    const { message, tenant: tenantKey } = parsed.data;
    const requestedConversationId = parsed.data.conversationId || null;

    // 클라이언트가 먼저 끊으면 모델 호출도 즉시 중단한다 — 출력 토큰 비용과 연결 누수를 거기서 멈춘다.
    // req가 아니라 res의 'close'여야 한다. 최신 Node에서 req의 'close'는 요청 본문 수신 완료 시점에 발생한다.
    // (W1 스모크 테스트에서 잡은 버그 — docs/reviews.md 2번 항목)
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const turn = await chat.start({ tenantKey, message, conversationId: requestedConversationId, signal: abort.signal });
    if (turn.status === 'unknown_tenant') {
      res.status(404).json({ error: 'unknown_tenant' } satisfies ApiErrorBody);
      return;
    }
    if (turn.status === 'blocked') {
      // 422: 요청 형식은 맞지만 내용 정책 위반. (400과 구분 — 면접 소재)
      res.status(422).json({ error: 'blocked_by_moderation', reasons: turn.reasons } satisfies ApiErrorBody);
      return;
    }
    if (turn.status === 'insufficient_credits') {
      // 402: 테넌트의 크레딧이 없다. 방문자가 고칠 수 없는 상태라 재시도 불가 — 위젯은 "운영자에게 알려 달라"고 안내한다.
      res.status(402).json({ error: 'insufficient_credits', retryable: false } satisfies ApiErrorBody);
      return;
    }

    const events = turn.events[Symbol.asyncIterator]();
    let ttftMs: number | null = null;
    let handoff: HandoffReason | null = null;
    let citations = 0;
    const facts = (): EngineRunFacts => ({
      engine: chat.engine.name,
      model: chat.engine.model,
      durationMs: Date.now() - receivedAt.getTime(),
      knowledgeItems: turn.knowledgeItems,
      citations,
      handoff,
      moderation: turn.moderation.level === 'warn' ? turn.moderation.reasons : [],
    });
    const finish = (payload: ChatRequestPayload): void => {
      recordEvent({ type: 'chat_request', tenantId: turn.tenantId, conversationId: turn.conversationId, createdAt: receivedAt, ttftMs, payload });
    };
    const report = (e: EngineError): void => {
      if (REPORTED_CODES.has(e.code)) {
        reportError(e, { where: 'engine', code: e.code, tenant: turn.tenantId, conversationId: turn.conversationId });
      }
    };

    // 첫 이벤트는 SSE 헤더를 보내기 "전에" 기다린다. 여기서 실패하면 HTTP 상태 코드로 답할 수 있어
    // 위젯이 재시도 여부를 상태 코드와 Retry-After로 판단한다. 헤더가 나간 뒤의 실패는 event: error다.
    let first: IteratorResult<EngineEvent>;
    try {
      first = await events.next();
    } catch (err) {
      if (abort.signal.aborted) {
        finish({ ...facts(), outcome: 'aborted' });
        return;
      }
      const e = asEngineError(err);
      report(e);
      if (e.retryable) res.setHeader('Retry-After', '2');
      res.status(statusFor(e.code)).json({ error: e.code, retryable: e.retryable } satisfies ApiErrorBody);
      finish({ ...facts(), outcome: 'error', errorCode: e.code });
      return;
    }

    // SSE 헤더. EventSource가 아니라 fetch 스트림으로 읽으므로 POST가 가능하다. (ADR-0002)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 위젯은 이 id를 다음 요청에 실어 대화를 이어 간다.
    res.setHeader(CONVERSATION_ID_HEADER, turn.conversationId);
    res.flushHeaders();

    if (turn.moderation.level === 'warn') {
      // 경고 레벨은 응답을 계속하되, 위젯과 콘솔이 알 수 있게 첫 조각 전에 별도 이벤트로 알린다.
      res.write(encodeChatEvent({ type: 'moderation', reasons: turn.moderation.reasons }));
    }

    let done: DoneEvent | null = null;
    try {
      for (let r = first; !r.done; r = await events.next()) {
        const ev = r.value;
        // 공백뿐인 조각은 첫 응답이 아니다 — 유스케이스도 공백뿐인 답을 답 없음으로 저장한다(chat/service.ts recordTurn).
        if (ev.type === 'delta' && ttftMs === null && ev.text.trim() !== '') ttftMs = Date.now() - receivedAt.getTime();
        if (ev.type === 'citation') citations += 1;
        if (ev.type === 'handoff') handoff = ev.reason;
        if (ev.type === 'done') done = ev;
        res.write(sseForEngineEvent(ev));
      }
    } catch (err) {
      if (abort.signal.aborted) {
        finish({ ...facts(), outcome: 'aborted' });
        return;
      }
      const e = asEngineError(err);
      report(e);
      res.write(encodeChatEvent({ type: 'error', code: e.code, retryable: e.retryable }));
      res.end();
      finish({ ...facts(), outcome: 'error', errorCode: e.code });
      return;
    }

    // 여기 닿았으면 유스케이스가 턴을 대화에 저장한 뒤다(chat/service.ts). 저장 실패는 거기서 보고하고 여기로 오지 않는다.
    res.write(encodeChatEvent({ type: 'end' }));
    res.end();
    finish({
      ...facts(),
      outcome: 'done',
      stopReason: done?.stopReason ?? null,
      servedBy: done?.servedBy ?? null,
      fallbackUsed: done?.fallbackUsed ?? false,
      usage: done?.usage ?? null,
    });
  };
}
