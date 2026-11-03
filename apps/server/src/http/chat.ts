import { CONVERSATION_ID_HEADER, encodeChatEvent, type ApiErrorBody, type ChatRequestBody } from '@qrate/contracts';
import type { Request, Response } from 'express';
import type { ChatService } from '../chat/service.js';
import { asEngineError, type EngineEvent, type Usage } from '../engine/types.js';
import { sseForEngineEvent } from './sse.js';

// POST /api/chat — 대화 유스케이스(chat/service.ts)를 HTTP와 SSE로 옮기는 어댑터.
// 여기서 정하는 것: 본문 모양 검사(400), 결과 종류 → 상태 코드(404·422), 첫 이벤트 전 실패 → HTTP 상태 + Retry-After,
// 그 뒤 실패 → event: error, 클라이언트 끊김 → 엔진 중단, 요청 1건의 사용량 로그.

/** 요청 1건의 결과 기록. W4에서 이벤트 로그(DB)로 옮기고, 지금은 stdout JSON 한 줄이다. */
export interface UsageLogEntry {
  type: 'chat_usage';
  ts: string;
  tenant: string;
  conversationId: string | null;
  engine: string;
  model: string;
  /** 실제로 답한 모델. 서버 측 폴백이 작동하면 model과 다르다. */
  servedBy: string | null;
  fallbackUsed: boolean;
  outcome: 'done' | 'error' | 'aborted';
  stopReason: string | null;
  errorCode: string | null;
  /** 요청 수신 → 첫 답변 조각 전송(ms). README 지표 TTFT의 원천. */
  ttftMs: number | null;
  durationMs: number;
  knowledgeItems: number;
  usage: Usage | null;
}

export type UsageLogger = (entry: UsageLogEntry) => void;

const logToStdout: UsageLogger = (entry) => {
  console.log(JSON.stringify(entry));
};

/** 요청 본문의 모양은 계약(ChatRequestBody)이지만, 바깥에서 온 값이라 필드마다 unknown으로 받아 검사한다. */
type ChatBody = Partial<Record<keyof ChatRequestBody, unknown>>;

type DoneEvent = Extract<EngineEvent, { type: 'done' }>;

export interface ChatHandlerDeps {
  chat: ChatService;
  logUsage?: UsageLogger;
}

export function createChatHandler({ chat, logUsage = logToStdout }: ChatHandlerDeps) {
  return async function handleChat(req: Request, res: Response): Promise<void> {
    const startedAt = Date.now();
    const body = (req.body ?? {}) as ChatBody;
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    // 테넌트 키는 모든 요청이 명시해야 한다. W1의 'demo' 기본값은 테넌트 검증 단계에서 제거했다.
    const tenantKey = nonEmptyString(body.tenant);
    const requestedConversationId = nonEmptyString(body.conversationId);

    if (!message) {
      res.status(400).json({ error: 'message is required' } satisfies ApiErrorBody);
      return;
    }
    if (!tenantKey) {
      res.status(400).json({ error: 'tenant is required' } satisfies ApiErrorBody);
      return;
    }

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

    const events = turn.events[Symbol.asyncIterator]();
    let ttftMs: number | null = null;
    const finish = (
      outcome: UsageLogEntry['outcome'],
      detail: { done?: DoneEvent | null; errorCode?: string | null },
    ): void => {
      logUsage({
        type: 'chat_usage',
        ts: new Date(startedAt).toISOString(),
        tenant: turn.tenantId,
        conversationId: turn.conversationId,
        engine: chat.engine.name,
        model: chat.engine.model,
        servedBy: detail.done?.servedBy ?? null,
        fallbackUsed: detail.done?.fallbackUsed ?? false,
        outcome,
        stopReason: detail.done?.stopReason ?? null,
        errorCode: detail.errorCode ?? null,
        ttftMs,
        durationMs: Date.now() - startedAt,
        knowledgeItems: turn.knowledgeItems,
        usage: detail.done?.usage ?? null,
      });
    };

    // 첫 이벤트는 SSE 헤더를 보내기 "전에" 기다린다. 여기서 실패하면 HTTP 상태 코드로 답할 수 있어
    // 위젯이 재시도 여부를 상태 코드와 Retry-After로 판단한다. 헤더가 나간 뒤의 실패는 event: error다.
    let first: IteratorResult<EngineEvent>;
    try {
      first = await events.next();
    } catch (err) {
      if (abort.signal.aborted) {
        finish('aborted', {});
        return;
      }
      const e = asEngineError(err);
      if (e.retryable) res.setHeader('Retry-After', '2');
      res.status(e.status).json({ error: e.code, retryable: e.retryable } satisfies ApiErrorBody);
      finish('error', { errorCode: e.code });
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
        if (ev.type === 'delta' && ttftMs === null) ttftMs = Date.now() - startedAt;
        if (ev.type === 'done') done = ev;
        res.write(sseForEngineEvent(ev));
      }
    } catch (err) {
      if (abort.signal.aborted) {
        finish('aborted', {});
        return;
      }
      const e = asEngineError(err);
      res.write(encodeChatEvent({ type: 'error', code: e.code, retryable: e.retryable }));
      res.end();
      finish('error', { errorCode: e.code });
      return;
    }

    // 여기 닿았으면 유스케이스가 질문과 답변을 대화에 저장한 뒤다(chat/service.ts).
    res.write(encodeChatEvent({ type: 'end' }));
    res.end();
    finish('done', { done });
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
