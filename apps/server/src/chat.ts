import type { Request, Response } from 'express';
import { asEngineError, type AnswerEngine, type EngineEvent, type HistoryTurn, type Usage } from './engine/types.js';
import { selectKnowledge } from './knowledge/select.js';
import { moderateInput } from './moderation.js';
import type { Repositories } from './repo/types.js';
import { SSE_DONE, formatSSE, sseForEngineEvent } from './sse.js';

/** 프롬프트에 넣는 이전 메시지 수 상한. 길어질수록 입력 토큰과 TTFT가 늘어난다. */
const HISTORY_MESSAGES = 10;

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

interface ChatBody {
  message?: unknown;
  tenant?: unknown;
  conversationId?: unknown;
}

type DoneEvent = Extract<EngineEvent, { type: 'done' }>;

export interface ChatHandlerDeps {
  engine: AnswerEngine;
  repos: Repositories;
  logUsage?: UsageLogger;
}

export function createChatHandler({ engine, repos, logUsage = logToStdout }: ChatHandlerDeps) {
  return async function handleChat(req: Request, res: Response): Promise<void> {
    const startedAt = Date.now();
    const body = (req.body ?? {}) as ChatBody;
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    // 테넌트 키는 모든 요청이 명시해야 한다. W1의 'demo' 기본값은 테넌트 검증 단계에서 제거했다.
    const tenantKey = typeof body.tenant === 'string' && body.tenant ? body.tenant : null;
    const requestedConversationId =
      typeof body.conversationId === 'string' && body.conversationId ? body.conversationId : null;

    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    if (!tenantKey) {
      res.status(400).json({ error: 'tenant is required' });
      return;
    }

    // 테넌트 키는 설치 스니펫에 들어가는 공개 식별자다. 여기서는 "있는 테넌트인가"만 본다(없으면 404).
    // "허용된 사이트에서 왔는가"는 두 겹으로 막는다 — 대화창 문서(GET /frame)의 frame-ancestors가 브라우저 쪽에서,
    // 이 라우트 앞의 requireOwnOrigin이 서버 쪽에서. (src/frame.ts, src/origin.ts)
    const tenant = await repos.tenants.findByKey(tenantKey);
    if (!tenant) {
      res.status(404).json({ error: 'unknown_tenant' });
      return;
    }

    // 모더레이션은 토큰을 한 글자라도 내보내기 전에 수행한다.
    const moderation = moderateInput(message);
    if (moderation.level === 'block') {
      // 422: 요청 형식은 맞지만 내용 정책 위반. (400과 구분 — 면접 소재)
      res.status(422).json({ error: 'blocked_by_moderation', reasons: moderation.reasons });
      return;
    }

    // 대화: 위젯이 보낸 id가 이 테넌트의 대화면 이어 가고, 없거나 다른 테넌트 것이면 새로 만든다.
    const existing = requestedConversationId
      ? await repos.conversations.find(requestedConversationId, tenant.id)
      : null;
    const conversation = existing ?? (await repos.conversations.create(tenant.id));
    const history = toHistory(conversation.messages.slice(-HISTORY_MESSAGES));
    const knowledge = await selectKnowledge(repos.knowledge, tenant.id, message);
    await repos.conversations.appendMessage(conversation.id, { role: 'user', content: message });

    // 클라이언트가 먼저 끊으면 모델 호출도 즉시 중단한다 — 출력 토큰 비용과 연결 누수를 거기서 멈춘다.
    // req가 아니라 res의 'close'여야 한다. 최신 Node에서 req의 'close'는 요청 본문 수신 완료 시점에 발생한다.
    // (W1 스모크 테스트에서 잡은 버그 — docs/reviews.md 2번 항목)
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const stream = engine.stream({
      tenantId: tenant.id,
      tenantName: tenant.name,
      message,
      history,
      knowledge,
      signal: abort.signal,
    });
    const events = stream[Symbol.asyncIterator]();

    let ttftMs: number | null = null;
    const finish = (
      outcome: UsageLogEntry['outcome'],
      detail: { done?: DoneEvent | null; errorCode?: string | null },
    ): void => {
      logUsage({
        type: 'chat_usage',
        ts: new Date(startedAt).toISOString(),
        tenant: tenant.id,
        conversationId: conversation.id,
        engine: engine.name,
        model: engine.model,
        servedBy: detail.done?.servedBy ?? null,
        fallbackUsed: detail.done?.fallbackUsed ?? false,
        outcome,
        stopReason: detail.done?.stopReason ?? null,
        errorCode: detail.errorCode ?? null,
        ttftMs,
        durationMs: Date.now() - startedAt,
        knowledgeItems: knowledge.length,
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
      res.status(e.status).json({ error: e.code, retryable: e.retryable });
      finish('error', { errorCode: e.code });
      return;
    }

    // SSE 헤더. EventSource가 아니라 fetch 스트림으로 읽으므로 POST가 가능하다. (ADR-0002)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 위젯은 이 id를 다음 요청에 실어 대화를 이어 간다.
    res.setHeader('X-Conversation-Id', conversation.id);
    res.flushHeaders();

    if (moderation.level === 'warn') {
      // 경고 레벨은 응답을 계속하되, 위젯과 콘솔이 알 수 있게 첫 조각 전에 별도 이벤트로 알린다.
      res.write(formatSSE('moderation', moderation));
    }

    let done: DoneEvent | null = null;
    let answer = '';
    try {
      for (let r = first; !r.done; r = await events.next()) {
        const ev = r.value;
        if (ev.type === 'delta') {
          if (ttftMs === null) ttftMs = Date.now() - startedAt;
          answer += ev.text;
        }
        if (ev.type === 'done') done = ev;
        res.write(sseForEngineEvent(ev));
      }
    } catch (err) {
      if (abort.signal.aborted) {
        finish('aborted', {});
        return;
      }
      const e = asEngineError(err);
      res.write(formatSSE('error', { code: e.code, retryable: e.retryable }));
      res.end();
      finish('error', { errorCode: e.code });
      return;
    }

    res.write(SSE_DONE);
    res.end();
    // 끝까지 받은 답만 대화에 남긴다. 끊긴 부분 답은 다음 턴의 문맥을 오염시킬 수 있어 저장하지 않는다.
    if (answer) await repos.conversations.appendMessage(conversation.id, { role: 'assistant', content: answer });
    finish('done', { done });
  };
}

// API는 첫 메시지가 user여야 한다. 실패한 턴 때문에 잘린 구간이 assistant로 시작하면 그 앞을 버린다.
function toHistory(messages: { role: HistoryTurn['role']; content: string }[]): HistoryTurn[] {
  const start = messages.findIndex((m) => m.role === 'user');
  if (start < 0) return [];
  return messages.slice(start).map((m) => ({ role: m.role, text: m.content }));
}
