import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../src/events/metrics.js';
import type { ConversationOutcome, EventCount, TimeWindow } from '../src/repo/types.js';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const TENANT = 'tenant-1';

function sources(facts: { ttft?: number[]; outcomes?: ConversationOutcome[]; counts?: EventCount[] } = {}) {
  const calls: { method: string; tenantId: string; window: TimeWindow }[] = [];
  const repos = {
    events: {
      ttftSamples: async (tenantId: string, window: TimeWindow) => {
        calls.push({ method: 'ttftSamples', tenantId, window });
        return facts.ttft ?? [];
      },
      counts: async (tenantId: string, window: TimeWindow) => {
        calls.push({ method: 'counts', tenantId, window });
        return facts.counts ?? [];
      },
    },
    conversations: {
      outcomes: async (tenantId: string, window: TimeWindow) => {
        calls.push({ method: 'outcomes', tenantId, window });
        return facts.outcomes ?? [];
      },
    },
  };
  return { repos, calls };
}

async function ttftOf(values: number[]) {
  return (await computeMetrics(sources({ ttft: values }).repos, TENANT, NOW)).ttft;
}

describe('computeMetrics — TTFT (nearest-rank)', () => {
  it('표본이 없으면 p50·p95 모두 null', async () => {
    expect(await ttftOf([])).toEqual({ samples: 0, p50Ms: null, p95Ms: null });
  });

  it('1건이면 둘 다 그 값, 2건이면 p50은 작은 쪽·p95는 큰 쪽(입력 순서 무관)', async () => {
    expect(await ttftOf([42])).toEqual({ samples: 1, p50Ms: 42, p95Ms: 42 });
    expect(await ttftOf([30, 10])).toEqual({ samples: 2, p50Ms: 10, p95Ms: 30 });
  });

  it('1..20을 섞어 넣으면 p50=10, p95=19 — ⌈p·n/100⌉번째', async () => {
    const shuffled = [7, 20, 1, 14, 3, 18, 9, 11, 2, 16, 5, 13, 19, 8, 4, 12, 17, 6, 15, 10];
    expect(await ttftOf(shuffled)).toEqual({ samples: 20, p50Ms: 10, p95Ms: 19 });
  });

  it('1..37이면 p50=19, p95=36 — 순위는 올림이다(반올림이면 35)', async () => {
    const values = Array.from({ length: 37 }, (_, i) => i + 1);
    expect(await ttftOf(values)).toEqual({ samples: 37, p50Ms: 19, p95Ms: 36 });
  });

  it('1..100을 거꾸로 넣으면 p50=50, p95=95', async () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(await ttftOf(values)).toEqual({ samples: 100, p50Ms: 50, p95Ms: 95 });
  });

  it('숫자로 정렬한다(문자열 순이 아니다), 동률은 그대로 센다', async () => {
    expect(await ttftOf([1000, 9, 100, 10])).toEqual({ samples: 4, p50Ms: 10, p95Ms: 1000 });
    expect(await ttftOf([5, 9, 5, 5])).toEqual({ samples: 4, p50Ms: 5, p95Ms: 9 });
  });
});

describe('computeMetrics — 자동 해결률', () => {
  it('분모는 질문이 있었던 대화, 분자는 그중 답이 있고 연결 요청이 없는 대화. 반올림하지 않는다', async () => {
    const outcomes: ConversationOutcome[] = [
      { asked: true, answered: true, handedOff: false },
      { asked: true, answered: true, handedOff: false },
      { asked: true, answered: true, handedOff: true },
      { asked: true, answered: false, handedOff: false },
      { asked: true, answered: false, handedOff: true },
      { asked: true, answered: true, handedOff: false },
    ];
    const { autoResolution } = await computeMetrics(sources({ outcomes }).repos, TENANT, NOW);
    expect(autoResolution).toEqual({ conversations: 6, resolved: 3, rate: 0.5 });
  });

  it('질문 없이 연결만 요청한 대화는 몇 건이든 분모·분자 어디에도 들지 않는다', async () => {
    const handoffOnly: ConversationOutcome = { asked: false, answered: false, handedOff: true };
    const outcomes: ConversationOutcome[] = [{ asked: true, answered: true, handedOff: false }, ...Array.from({ length: 20 }, () => handoffOnly)];
    const { autoResolution } = await computeMetrics(sources({ outcomes }).repos, TENANT, NOW);
    expect(autoResolution).toEqual({ conversations: 1, resolved: 1, rate: 1 });
  });

  it('대화가 없거나 연결만 요청한 대화뿐이면 rate는 null(0%가 아니다)', async () => {
    expect((await computeMetrics(sources().repos, TENANT, NOW)).autoResolution).toEqual({ conversations: 0, resolved: 0, rate: null });
    const outcomes: ConversationOutcome[] = [{ asked: false, answered: false, handedOff: true }];
    expect((await computeMetrics(sources({ outcomes }).repos, TENANT, NOW)).autoResolution).toEqual({ conversations: 0, resolved: 0, rate: null });
  });

  it('비율은 그대로 — 1/3은 0.333…', async () => {
    const outcomes: ConversationOutcome[] = [
      { asked: true, answered: true, handedOff: false },
      { asked: true, answered: true, handedOff: true },
      { asked: true, answered: true, handedOff: true },
    ];
    const { autoResolution } = await computeMetrics(sources({ outcomes }).repos, TENANT, NOW);
    expect(autoResolution.rate).toBe(1 / 3);
  });
});

describe('computeMetrics — 위젯 열림과 창', () => {
  it('widget_open 수는 변형을 합친다. 다른 종류는 세지 않는다', async () => {
    const counts: EventCount[] = [
      { type: 'chat_request', variant: null, count: 5 },
      { type: 'widget_open', variant: null, count: 2 },
      { type: 'widget_open', variant: 'b', count: 1 },
    ];
    expect((await computeMetrics(sources({ counts }).repos, TENANT, NOW)).widget).toEqual({ opens: 3 });
  });

  it('창은 [now − 7일, now)이고 세 사실 모두 같은 테넌트·같은 창으로 묻는다', async () => {
    const { repos, calls } = sources();
    const { window } = await computeMetrics(repos, TENANT, NOW);
    expect(window).toEqual({ from: new Date('2026-10-29T12:00:00.000Z'), to: NOW });
    expect(calls.map((c) => c.method).sort()).toEqual(['counts', 'outcomes', 'ttftSamples']);
    for (const c of calls) expect(c).toMatchObject({ tenantId: TENANT, window });
  });
});
