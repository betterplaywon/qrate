import type { AnswerEngine, EngineEvent, HistoryTurn } from '../engine/types.js';
import type { Repositories } from '../repo/types.js';
import { selectKnowledge } from './knowledge.js';
import { moderateInput, type ModerationResult } from './moderation.js';

// 대화 한 턴의 유스케이스. HTTP를 모른다 — 입력은 이미 모양이 검사된 값이고, 결과는 상태 코드가 아니라 종류(status)로 돌려준다.
// 순서가 곧 비용 순서다: 테넌트 확인 → 모더레이션(토큰을 한 글자라도 내보내기 전) → 대화 이어 가기 → 지식 선택 → 엔진 호출.
// 전송(SSE 헤더, 첫 이벤트 전 실패의 HTTP 상태, Retry-After, 사용량 로그)은 http/chat.ts가 맡는다.

/** 프롬프트에 넣는 이전 메시지 수 상한. 길어질수록 입력 토큰과 TTFT가 늘어난다. */
const HISTORY_MESSAGES = 10;

export interface ChatTurnInput {
  /** 위젯 설치 스니펫의 data-tenant 값. 공개 식별자다. */
  tenantKey: string;
  /** 앞뒤 공백을 뗀, 비어 있지 않은 문자열. 모양 검사는 호출자(HTTP 계층)의 몫이다. */
  message: string;
  /** 위젯이 이전 응답 헤더로 받은 대화 id. 없거나 이 테넌트의 대화가 아니면 새로 만든다. */
  conversationId: string | null;
  /** 호출자가 끊으면 엔진 호출도 즉시 멈춘다. */
  signal: AbortSignal;
}

export type ChatTurn =
  | { status: 'unknown_tenant' }
  | { status: 'blocked'; reasons: string[] }
  | {
      status: 'accepted';
      tenantId: string;
      conversationId: string;
      /** ok 또는 warn. 경고면 호출자가 답변 앞에 알린다. */
      moderation: ModerationResult;
      knowledgeItems: number;
      /** 엔진 이벤트. 끝까지 소비되면 질문과 답변이 대화에 저장되고, 중간에 실패하거나 끊기면 둘 다 저장하지 않는다. */
      events: AsyncIterable<EngineEvent>;
    };

export interface ChatService {
  /** 사용량 로그에 남길 엔진 식별. */
  readonly engine: Pick<AnswerEngine, 'name' | 'model'>;
  start(input: ChatTurnInput): Promise<ChatTurn>;
}

export function createChatService({ engine, repos }: { engine: AnswerEngine; repos: Repositories }): ChatService {
  return {
    engine,

    async start({ tenantKey, message, conversationId: requestedId, signal }) {
      // 질문을 받은 시각. 저장은 답변이 끝난 뒤에 하므로 그때의 시각이 아니라 이 값을 기록한다.
      const receivedAt = new Date();

      // 테넌트 키는 설치 스니펫에 들어가는 공개 식별자다. 여기서는 "있는 테넌트인가"만 본다.
      // "허용된 사이트에서 왔는가"는 두 겹으로 막는다 — 대화창 문서(GET /frame)의 frame-ancestors가 브라우저 쪽에서,
      // 대화 API 앞의 requireOwnOrigin이 서버 쪽에서. (http/frame.ts, origin.ts)
      const tenant = await repos.tenants.findByKey(tenantKey);
      if (!tenant) return { status: 'unknown_tenant' };

      const moderation = moderateInput(message);
      if (moderation.level === 'block') return { status: 'blocked', reasons: moderation.reasons };

      // 대화: 위젯이 보낸 id가 이 테넌트의 대화면 이어 가고, 없거나 다른 테넌트 것이면 새로 만든다.
      const existing = requestedId ? await repos.conversations.find(requestedId, tenant.id) : null;
      const conversation = existing ?? (await repos.conversations.create(tenant.id));
      const history = toHistory(conversation.messages.slice(-HISTORY_MESSAGES));
      const knowledge = await selectKnowledge(repos.knowledge, tenant.id, message);

      // 엔진 호출은 첫 이벤트를 꺼낼 때 시작된다(async generator). 그 시점은 호출자가 정한다.
      const events = engine.stream({ tenantId: tenant.id, tenantName: tenant.name, message, history, knowledge, signal });

      return {
        status: 'accepted',
        tenantId: tenant.id,
        conversationId: conversation.id,
        moderation,
        knowledgeItems: knowledge.length,
        events: recordTurn(events, async (answer) => {
          // 질문은 받은 시각으로, 답변은 저장 시각으로. (W3 Postgres에서는 두 insert를 한 트랜잭션으로 묶는다)
          await repos.conversations.appendMessage(conversation.id, { role: 'user', content: message, createdAt: receivedAt });
          if (answer) await repos.conversations.appendMessage(conversation.id, { role: 'assistant', content: answer });
        }),
      };
    },
  };
}

/**
 * 이벤트를 그대로 흘려보내며 답변을 모으고, 끝까지 받았을 때만 질문과 답변을 함께 저장한다 — 저장 단위는 턴이다.
 * 질문을 먼저 저장하면 실패한 턴의 질문이 대화에 남고, 위젯이 같은 질문을 다시 보내면("다시 보내기") 두 번 들어간다.
 * 그래서 실패·중단한 턴은 대화에 아무것도 남기지 않는다. 그 턴의 기록은 사용량 로그(http/chat.ts)가 맡는다.
 * 끊긴 부분 답은 다음 턴의 문맥을 오염시킬 수 있어 저장하지 않는다 — 실패·중단은 예외로 빠져나가므로 저장 줄에 닿지 않는다.
 * 답변 없이 끝난 턴(정책 거절)은 질문만 저장한다.
 */
async function* recordTurn(
  events: AsyncIterable<EngineEvent>,
  save: (answer: string) => Promise<void>,
): AsyncGenerator<EngineEvent, void, undefined> {
  let answer = '';
  for await (const ev of events) {
    if (ev.type === 'delta') answer += ev.text;
    yield ev;
  }
  await save(answer);
}

// API는 첫 메시지가 user여야 한다. 답변 없이 끝난 턴(거절) 때문에 잘린 구간이 assistant로 시작하면 그 앞을 버린다.
function toHistory(messages: { role: HistoryTurn['role']; content: string }[]): HistoryTurn[] {
  const start = messages.findIndex((m) => m.role === 'user');
  if (start < 0) return [];
  return messages.slice(start).map((m) => ({ role: m.role, text: m.content }));
}
