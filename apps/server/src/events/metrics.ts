import { METRICS_WINDOW_DAYS } from '@qrate/contracts';
import type {
  AppEvent,
  ConversationOutcome,
  ConversationRepository,
  EventCount,
  EventRepository,
  TimeWindow,
} from '../repo/types.js';

// 콘솔 지표의 정의가 사는 유일한 곳. 저장소는 사실(값 목록·대화별 사실·개수)만 돌려주고 백분위·해결 판정·비율은 여기서 정한다 —
// 메모리와 Postgres가 같은 값을 내는 까닭이 "같은 정의를 두 번 구현해서"가 아니라 "정의가 한 곳에 있어서"가 되게.
// 원천은 지표마다 하나다: TTFT는 사건 로그(chat_request), 자동 해결률은 대화·핸드오프 표, 위젯 열림은 사건 로그(widget_open).

export interface ConsoleMetrics {
  window: TimeWindow;
  ttft: { samples: number; p50Ms: number | null; p95Ms: number | null };
  autoResolution: { conversations: number; resolved: number; rate: number | null; handoffOnly: number };
  widget: { opens: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * nearest-rank 백분위: 오름차순 n개에서 k = ⌈p·n/100⌉번째(1부터). 빈 목록은 null.
 * p가 정수라 p·n도 정수 — 나눗셈 올림에 부동소수 오차가 없다. Postgres percentile_disc(p/100)과 같은 값이고,
 * 보간하지 않으므로 값은 언제나 실제 한 행의 ttftMs다(README 수치를 행까지 따라갈 수 있다).
 */
function nearestRank(sortedAsc: readonly number[], percent: 50 | 95): number | null {
  if (sortedAsc.length === 0) return null;
  return sortedAsc[Math.ceil((percent * sortedAsc.length) / 100) - 1] ?? null;
}

function summarizeTtft(values: readonly number[]): ConsoleMetrics['ttft'] {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50Ms: nearestRank(sorted, 50), p95Ms: nearestRank(sorted, 95) };
}

/**
 * 분모는 창 안에 시작해 질문이 있었던 대화(봇에게 물어본 대화), 해결은 그중 답이 하나 이상이고 상담원 연결 요청이 없는 대화.
 * 질문 없이 연결만 요청한 대화는 분모·분자 모두에서 뺀다 — 봇이 답할 기회가 없었고, 넣으면 공개 POST /api/handoff만으로
 * 분모를 부풀릴 수 있다. 대신 handoffOnly로 따로 세어, 비율에서 뺀 대화를 콘솔이 숨기지 않게 한다.
 * 정책 거절로 답 없이 끝난 대화는 질문이 있으니 분모에 든다.
 */
function summarizeResolution(outcomes: readonly ConversationOutcome[]): ConsoleMetrics['autoResolution'] {
  const asked = outcomes.filter((o) => o.asked);
  const resolved = asked.filter((o) => o.answered && !o.handedOff).length;
  const handoffOnly = outcomes.filter((o) => !o.asked && o.handedOff).length;
  return { conversations: asked.length, resolved, rate: asked.length === 0 ? null : resolved / asked.length, handoffOnly };
}

function countOf(counts: readonly EventCount[], type: AppEvent['type']): number {
  return counts.reduce((sum, c) => (c.type === type ? sum + c.count : sum), 0);
}

/** 창 [now − METRICS_WINDOW_DAYS×24h, now)의 테넌트 지표. */
export async function computeMetrics(
  repos: { events: Pick<EventRepository, 'ttftSamples' | 'counts'>; conversations: Pick<ConversationRepository, 'outcomes'> },
  tenantId: string,
  now: Date,
): Promise<ConsoleMetrics> {
  const window = { from: new Date(now.getTime() - METRICS_WINDOW_DAYS * DAY_MS), to: now };
  const [ttft, outcomes, counts] = await Promise.all([
    repos.events.ttftSamples(tenantId, window),
    repos.conversations.outcomes(tenantId, window),
    repos.events.counts(tenantId, window),
  ]);
  return {
    window,
    ttft: summarizeTtft(ttft),
    autoResolution: summarizeResolution(outcomes),
    widget: { opens: countOf(counts, 'widget_open') },
  };
}
