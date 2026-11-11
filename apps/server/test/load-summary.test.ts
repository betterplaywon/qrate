import { describe, expect, it } from 'vitest';
import { parsePsTime, type CpuSample } from '../load/cpu.js';
import { groupOf, groupProfile } from '../load/profile.js';
import { formatReport, readK6Export, summarizeMachine, summarizeServer, summarizeTtft, type StatsSample } from '../load/summary.js';

const trend = (med: number, p95: number, count: number) => ({ avg: med, min: 1, med, 'p(95)': p95, 'p(99)': p95 + 1, max: p95 + 2, count });

function stats(t: number, over: Partial<StatsSample> = {}): StatsSample {
  return {
    t,
    cpuPct: 10,
    elu: 0.1,
    rssMb: 100,
    heapUsedMb: 30,
    loopLagP99Ms: 1,
    loopLagMaxMs: 2,
    gcMs: 3,
    gcMaxMs: 1,
    inFlight: 4,
    inFlightMax: 5,
    ...over,
  };
}

describe('readK6Export', () => {
  it('k6 요약에서 대화 턴·성공률·첫 바이트 분포와 그 밖의 실패를 꺼낸다', () => {
    const step = readK6Export({
      metrics: {
        chat_ttfb: trend(4, 9, 98),
        chat_duration: trend(2300, 2400, 98),
        chat_ok: { passes: 98, fails: 2, value: 0.98 },
        chat_turns: { count: 100, rate: 1.6 },
        step_frame: trend(3, 5, 50),
        step_greeting: trend(2, 4, 50),
        step_event: trend(2, 3, 100),
        step_ok: { passes: 199, fails: 1, value: 0.995 },
        http_reqs: { count: 300, rate: 5 },
      },
    });
    expect(step).toMatchObject({ turns: 100, chatOkRate: 0.98, chatFailed: 2, stepFailed: 1 });
    expect(step.ttfb).toEqual({ p50: 4, p95: 9, p99: 10, max: 11, count: 98 });
  });

  it('대화가 모두 실패해 표본이 없는 지표는 null로 둔다', () => {
    const step = readK6Export({ metrics: { chat_ok: { passes: 0, fails: 5, value: 0 } } });
    expect(step).toMatchObject({ turns: 5, chatOkRate: 0, chatFailed: 5, ttfb: null, stream: null });
  });

  it('모양이 다른 요약은 읽지 않는다', () => {
    expect(() => readK6Export({ metrics: { chat_ttfb: { med: '4' } } })).toThrow();
  });
});

describe('summarizeServer', () => {
  it('구간 [from, to) 안의 표본만 평균·최대로 줄인다', () => {
    const samples = [stats(999, { cpuPct: 99 }), stats(1000, { cpuPct: 20, elu: 0.2, gcMaxMs: 7 }), stats(1500, { cpuPct: 40, elu: 0.4, inFlightMax: 9 }), stats(2000, { cpuPct: 99 })];
    expect(summarizeServer(samples, { from: 1000, to: 2000 })).toMatchObject({
      samples: 2,
      cpuAvg: 30,
      cpuMax: 40,
      eluAvg: 0.3,
      eluMax: 0.4,
      gcMaxMs: 7,
      inFlightMax: 9,
    });
  });

  it('구간에 표본이 없으면 samples=0을 돌려준다', () => {
    expect(summarizeServer([stats(5)], { from: 10, to: 20 }).samples).toBe(0);
  });
});

describe('summarizeMachine', () => {
  it('프로세스 묶음마다 평균 / 최대를 낸다', () => {
    const cpu = (t: number, machinePct: number, dbVmPct: number): CpuSample => ({ t, machinePct, serverPct: 50, k6Pct: 10, dbVmPct, dockerPct: 5 });
    const step = summarizeMachine([cpu(0, 20, 100), cpu(1000, 40, 300)], { from: 0, to: 2000 });
    expect(step).toMatchObject({ samples: 2, machine: [30, 40], dbVm: [200, 300], server: [50, 50] });
  });
});

describe('summarizeTtft', () => {
  it('콘솔 지표와 같은 nearest-rank로 p50·p95를 낸다', () => {
    expect(summarizeTtft([5, 1, 4, 2, 3])).toEqual({ ttftSamples: 5, ttftP50: 3, ttftP95: 5 });
    expect(summarizeTtft([])).toEqual({ ttftSamples: 0, ttftP50: null, ttftP95: null });
  });
});

describe('formatReport', () => {
  it('단계마다 방문자·서버·기기 표에 한 줄씩 쓴다', () => {
    const k6 = readK6Export({ metrics: { chat_ttfb: trend(4, 9, 10), chat_ok: { passes: 10, fails: 0, value: 1 } } });
    const report = formatReport({ title: 't', lines: ['기기'] }, [
      {
        label: '100',
        vus: 100,
        from: '2026-11-11T00:00:00.000Z',
        to: '2026-11-11T00:01:00.000Z',
        holdS: 60,
        turnsPerS: 15,
        k6,
        server: summarizeServer([], { from: 0, to: 1 }),
        machine: summarizeMachine([], { from: 0, to: 1 }),
        db: { ttftSamples: 10, ttftP50: 3, ttftP95: 8, ledgerRowsBefore: 1 },
      },
    ]);
    expect(report).toContain('| 100 | 15 | 10 | 100% | 4 / 9 / 10 |');
    expect(report).toContain('3 / 8 (10)');
    expect(report.match(/^\| 100 \|/gm)).toHaveLength(3);
  });
});

describe('parsePsTime', () => {
  it('ps 누적 CPU 시간을 초로 바꾼다(분이 60을 넘는 macOS 형식과 일·시 형식)', () => {
    expect(parsePsTime('0:01.50')).toBeCloseTo(1.5);
    expect(parsePsTime('282:19.78')).toBeCloseTo(282 * 60 + 19.78);
    expect(parsePsTime('01:02:03')).toBe(3723);
    expect(parsePsTime('2-00:00:01')).toBe(2 * 86_400 + 1);
  });
});

describe('profile', () => {
  it('호출 프레임을 패키지·Node 영역·레포 파일로 묶는다', () => {
    expect(groupOf('findMany', 'file:///x/node_modules/.pnpm/@prisma+client@7.10.1_x/node_modules/@prisma/client/runtime/client.js')).toBe('pkg prisma/client');
    expect(groupOf('write', 'node:internal/streams/writable')).toBe('node streams');
    expect(groupOf('stream', 'file:///x/qrate/apps/server/src/engine/mock.ts')).toBe('app apps/server/src/engine/mock');
    expect(groupOf('(garbage collector)', '')).toBe('GC');
  });

  it('자체 시간을 묶음별로 더하고 쉬는 시간은 비율에서 뺀다', () => {
    const profile = {
      nodes: [
        { id: 1, callFrame: { functionName: '(idle)', url: '' } },
        { id: 2, callFrame: { functionName: 'q', url: 'file:///x/node_modules/.pnpm/pg@8.23.1/node_modules/pg/lib/client.js' } },
        { id: 3, callFrame: { functionName: '(garbage collector)', url: '' } },
      ],
      samples: [1, 2, 2, 3],
      timeDeltas: [5000, 3000, 3000, 2000],
    };
    expect(groupProfile(profile)).toEqual({
      busyMs: 8,
      idleMs: 5,
      groups: [
        { group: 'pkg pg', ms: 6, share: 75 },
        { group: 'GC', ms: 2, share: 25 },
      ],
    });
  });
});
