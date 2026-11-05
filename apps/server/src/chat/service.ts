import { randomUUID } from 'node:crypto';
import type { AnswerEngine, EngineEvent, HandoffReason, HistoryTurn } from '../engine/types.js';
import type { Repositories } from '../repo/types.js';
import { reportToStderr, type ErrorReporter } from '../report.js';
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
  /** 앞뒤 공백을 뗀, 비어 있지 않은 문자열. 모양·길이 검사는 호출자(HTTP 계층)의 몫이다. */
  message: string;
  /** 위젯이 이전 응답 헤더로 받은 대화 id. 없거나 이 테넌트의 대화가 아니면 새로 시작한다. */
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
      /** 이 턴이 속한 대화. 새 대화면 아직 저장소에 없고, 첫 턴이 저장될 때 생긴다. */
      conversationId: string;
      /** ok 또는 warn. 경고면 호출자가 답변 앞에 알린다. */
      moderation: ModerationResult;
      knowledgeItems: number;
      /** 엔진 이벤트. 끝까지 소비되면 턴(질문·답변·핸드오프)이 대화에 저장되고, 중간에 실패하거나 끊기면 아무것도 저장하지 않는다. */
      events: AsyncIterable<EngineEvent>;
    };

export interface ChatService {
  /** 사용량 로그에 남길 엔진 식별. */
  readonly engine: Pick<AnswerEngine, 'name' | 'model'>;
  start(input: ChatTurnInput): Promise<ChatTurn>;
}

export interface ChatServiceDeps {
  engine: AnswerEngine;
  repos: Repositories;
  /** 사용자에게 보이지 않는 실패(저장 실패)의 보고 통로. 기본은 stderr. */
  reportError?: ErrorReporter;
}

/**
 * 이벤트를 그대로 흘려보내며 답변과 핸드오프 신호를 모으고, 끝까지 받았을 때만 턴을 저장한다 — 저장 단위는 턴이다.
 * 질문을 먼저 저장하면 실패한 턴의 질문이 대화에 남고, 위젯이 같은 질문을 다시 보내면("다시 보내기") 두 번 들어간다.
 * 그래서 실패·중단한 턴은 대화에 아무것도 남기지 않는다. 그 턴의 기록은 사용량 로그(http/chat.ts)가 맡는다.
 * 끊긴 부분 답은 다음 턴의 문맥을 오염시킬 수 있어 저장하지 않는다 — 실패·중단은 예외로 빠져나가므로 저장 줄에 닿지 않는다.
 * 공백뿐인 답(도구 호출 전에 줄바꿈만 낸 경우)은 답이 없는 것으로 본다. 저장하면 다음 턴부터 API가 빈 텍스트 블록을 거부한다.
 */
async function* recordTurn(
  events: AsyncIterable<EngineEvent>,
  save: (turn: TurnRecord) => Promise<void>,
): AsyncGenerator<EngineEvent, void, undefined> {
  let answer = '';
  let handoff: TurnRecord['handoff'] = null;
  for await (const ev of events) {
    if (ev.type === 'delta') answer += ev.text;
    if (ev.type === 'handoff') handoff = { reason: ev.reason, summary: ev.summary };
    yield ev;
  }
  await save({ answer: answer.trim(), handoff });
}

/**
 * 프롬프트 문맥은 완결된 턴(user → assistant 쌍)만으로 만든다. API는 첫 메시지가 user여야 하고, 창(lastMessages)이 쌍 사이에서
 * 잘리면 assistant로 시작할 수 있어 그 앞을 버린다.
 * 답 없이 끝난 턴(정책 거절)의 질문은 기록으로는 남지만 문맥에서는 뺀다 — 거절된 내용을 매 턴 다시 보내면
 * 분류기가 같은 내용을 다시 보고 입력 토큰도 매번 낸다.
 */
function toHistory(messages: { role: HistoryTurn['role']; content: string }[]): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const question = messages[i];
    const answer = messages[i + 1];
    if (question?.role !== 'user' || answer?.role !== 'assistant') continue;
    out.push({ role: 'user', text: question.content }, { role: 'assistant', text: answer.content });
    i += 1;
  }
  return out;
}

export function createChatService({ engine, repos, reportError = reportToStderr }: ChatServiceDeps): ChatService {
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

      // 대화: 위젯이 보낸 id가 이 테넌트의 대화면 이어 가고, 없거나 다른 테넌트 것이면 새 id로 시작한다.
      // 새 대화는 지금 만들지 않는다 — 첫 턴이 저장될 때(appendTurn) 생긴다. 그래서 첫 이벤트 전에 실패하거나 끊긴 요청은
      // 빈 대화를 남기지 않는다. 공개 키로 요청을 반복해도 저장소가 늘지 않는다.
      const existing = requestedId
        ? await repos.conversations.find(requestedId, tenant.id, { lastMessages: HISTORY_MESSAGES })
        : null;
      const conversationId = existing?.id ?? randomUUID();
      const history = toHistory(existing?.messages ?? []);
      const knowledge = await selectKnowledge(repos.knowledge, tenant.id, message);

      // 엔진 호출은 첫 이벤트를 꺼낼 때 시작된다(async generator). 그 시점은 호출자가 정한다.
      const events = engine.stream({ tenantId: tenant.id, tenantName: tenant.name, message, history, knowledge, signal });

      return {
        status: 'accepted',
        tenantId: tenant.id,
        conversationId,
        moderation,
        knowledgeItems: knowledge.length,
        events: recordTurn(events, async ({ answer, handoff }) => {
          // 질문은 받은 시각으로, 답변은 저장 시각으로. 구현이 이 한 호출을 한 트랜잭션으로 쓴다.
          // 저장이 실패해도 답은 이미 전달됐다 — 스트림은 정상으로 끝내고 실패는 운영자에게만 알린다.
          // 예외를 흘리면 http 계층이 상류(모델) 오류로 보고하고, 이미 과금된 호출의 사용량 기록까지 잃는다.
          try {
            await repos.conversations.appendTurn(conversationId, tenant.id, {
              question: { role: 'user', content: message, createdAt: receivedAt },
              answer: answer ? { role: 'assistant', content: answer } : null,
              handoff,
            });
          } catch (err) {
            reportError(err, { where: 'appendTurn', tenantId: tenant.id, conversationId });
          }
        }),
      };
    },
  };
}

interface TurnRecord {
  /** 답변 전문. 비어 있으면 답 없이 끝난 턴(정책 거절)이다. */
  answer: string;
  handoff: { reason: HandoffReason; summary: string | null } | null;
}
