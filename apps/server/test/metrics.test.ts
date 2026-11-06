import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../src/events/metrics.js';
import { defineGreetingExperiment } from '../src/greeting/experiment.js';
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
  return (await computeMetrics(sources({ ttft: values }).repos, TENANT, NOW, null)).ttft;
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
    const { autoResolution } = await computeMetrics(sources({ outcomes }).repos, TENANT, NOW, null);
    expect(autoResolution).toEqual({ conversations: 6, resolved: 3, rate: 0.5, handoffOnly: 0 });
  });

  it('질문 없이 연결만 요청한 대화는 몇 건이든 분모·분자 어디에도 들지 않고 handoffOnly로 따로 센다', async () => {
    const handoffOnly: ConversationOutcome = { asked: false, answered: false, handedOff: true };
    const outcomes: ConversationOutcome[] = [{ asked: true, answered: true, handedOff: false }, ...Array.from({ length: 20 }, () => handoffOnly)];
    const { autoResolution } = await computeMetrics(sources({ outcomes }).repos, TENANT, NOW, null);
    expect(autoResolution).toEqual({ conversations: 1, resolved: 1, rate: 1, handoffOnly: 20 });
  });

  it('handoffOnly는 질문이 없고 연결 요청이 있는 대화만 센다 — 질문 뒤 연결은 분모 쪽, 질문도 연결도 없는 대화는 어디에도 없다', async () => {
    const outcomes: ConversationOutcome[] = [
      { asked: true, answered: true, handedOff: true },
      { asked: true, answered: false, handedOff: true },
      { asked: false, answered: false, handedOff: false },
      { asked: false, answered: false, handedOff: true },
    ];
    const { autoResolution } = await computeMetrics(sources({ outcomes }).repos, TENANT, NOW, null);
    expect(autoResolution).toEqual({ conversations: 2, resolved: 0, rate: 0, handoffOnly: 1 });
  });

  it('대화가 없거나 연결만 요청한 대화뿐이면 rate는 null(0%가 아니다) — 연결만 요청한 대화는 그래도 센다', async () => {
    expect((await computeMetrics(sources().repos, TENANT, NOW, null)).autoResolution).toEqual({ conversations: 0, resolved: 0, rate: null, handoffOnly: 0 });
    const outcomes: ConversationOutcome[] = [{ asked: false, answered: false, handedOff: true }];
    expect((await computeMetrics(sources({ outcomes }).repos, TENANT, NOW, null)).autoResolution).toEqual({
      conversations: 0,
      resolved: 0,
      rate: null,
      handoffOnly: 1,
    });
  });

  it('비율은 그대로 — 1/3은 0.333…', async () => {
    const outcomes: ConversationOutcome[] = [
      { asked: true, answered: true, handedOff: false },
      { asked: true, answered: true, handedOff: true },
      { asked: true, answered: true, handedOff: true },
    ];
    const { autoResolution } = await computeMetrics(sources({ outcomes }).repos, TENANT, NOW, null);
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
    expect((await computeMetrics(sources({ counts }).repos, TENANT, NOW, null)).widget).toEqual({ opens: 3 });
  });

  it('창은 [now − 7일, now)이고 세 사실 모두 같은 테넌트·같은 창으로 묻는다', async () => {
    const { repos, calls } = sources();
    const { window } = await computeMetrics(repos, TENANT, NOW, null);
    expect(window).toEqual({ from: new Date('2026-10-29T12:00:00.000Z'), to: NOW });
    expect(calls.map((c) => c.method).sort()).toEqual(['counts', 'outcomes', 'ttftSamples']);
    for (const c of calls) expect(c).toMatchObject({ tenantId: TENANT, window });
  });
});

describe('computeMetrics — 인사말 A/B', () => {
  const EXPERIMENT = defineGreetingExperiment({
    id: 'exp',
    variants: [
      { key: 'a', label: 'A · 기본', weight: 1, text: '가' },
      { key: 'b', label: 'B · 자료 안내', weight: 1, text: '나' },
    ],
  });
  const summarize = async (counts: EventCount[]) => computeMetrics(sources({ counts }).repos, TENANT, NOW, EXPERIMENT);

  it('변형별 노출(widget_open)·첫 질문(first_question)·비율. 행은 정의 순서이고 비율은 반올림하지 않는다', async () => {
    const counts: EventCount[] = [
      { type: 'first_question', variant: 'exp.a', count: 1 },
      { type: 'first_question', variant: 'exp.b', count: 3 },
      { type: 'widget_open', variant: 'exp.a', count: 3 },
      { type: 'widget_open', variant: 'exp.b', count: 4 },
    ];
    expect((await summarize(counts)).greeting).toEqual({
      experiment: 'exp',
      variants: [
        { id: 'exp.a', label: 'A · 기본', text: '가', exposures: 3, firstQuestions: 1, rate: 1 / 3 },
        { id: 'exp.b', label: 'B · 자료 안내', text: '나', exposures: 4, firstQuestions: 3, rate: 0.75 },
      ],
      outside: { opens: 0, questions: 0 },
    });
  });

  it('사건이 없는 변형도 0으로 나오고 비율은 null(0%가 아니다)', async () => {
    const { greeting } = await summarize([]);
    expect(greeting?.variants.map((v) => [v.id, v.exposures, v.firstQuestions, v.rate])).toEqual([
      ['exp.a', 0, 0, null],
      ['exp.b', 0, 0, null],
    ]);
  });

  it('변형 없는 사건·옛 실험의 행은 어느 행에도 들지 않고 실험 밖 수로 따로 센다. 위젯 열림 수는 그대로 전부', async () => {
    const counts: EventCount[] = [
      { type: 'chat_request', variant: null, count: 5 },
      { type: 'first_question', variant: null, count: 2 },
      { type: 'first_question', variant: 'exp.a', count: 1 },
      { type: 'first_question', variant: 'old.a', count: 1 },
      { type: 'widget_open', variant: null, count: 2 },
      { type: 'widget_open', variant: 'exp.a', count: 2 },
      { type: 'widget_open', variant: 'old.b', count: 3 },
    ];
    const metrics = await summarize(counts);
    expect(metrics.greeting?.variants.map((v) => [v.id, v.exposures, v.firstQuestions])).toEqual([
      ['exp.a', 2, 1],
      ['exp.b', 0, 0],
    ]);
    expect(metrics.greeting?.outside).toEqual({ opens: 5, questions: 3 });
    expect(metrics.widget).toEqual({ opens: 7 });
  });

  it('첫 질문이 노출보다 많아도 자르지 않는다 — 1을 넘는 비율은 열림 사건 유실이나 위조를 드러낸다', async () => {
    const counts: EventCount[] = [
      { type: 'first_question', variant: 'exp.a', count: 3 },
      { type: 'widget_open', variant: 'exp.a', count: 1 },
    ];
    expect((await summarize(counts)).greeting?.variants[0]?.rate).toBe(3);
  });

  it('실험이 꺼져 있으면 greeting은 null', async () => {
    const counts: EventCount[] = [{ type: 'widget_open', variant: 'exp.a', count: 1 }];
    expect((await computeMetrics(sources({ counts }).repos, TENANT, NOW, null)).greeting).toBeNull();
  });
});
