import { z } from 'zod';
import { nearestRank } from '../src/events/metrics.js';
import type { CpuSample } from './cpu.js';

// 부하 측정 사다리의 집계(순수 함수). 입력은 넷이다: k6 --summary-export JSON, 측정 서버의 1초 표본, 기기 CPU 표본, DB의 서버 기록 TTFT.

/** 측정 서버(load/server.ts)가 1초마다 남기는 표본. CPU는 한 코어 기준 %(프로세스 전체 — GC·I/O 스레드도 들어간다). */
export interface StatsSample {
  t: number;
  cpuPct: number;
  /** 이벤트 루프가 일한 시간의 비율(0~1). 1에 붙으면 요청이 루프 차례를 기다린다. */
  elu: number;
  rssMb: number;
  heapUsedMb: number;
  /** 타이머가 예정보다 늦게 깬 시간(지난 1초). */
  loopLagP99Ms: number;
  loopLagMaxMs: number;
  /** 지난 1초 동안 GC가 JS 실행을 멈춘 시간의 합과 가장 긴 한 번. */
  gcMs: number;
  gcMaxMs: number;
  /** 표본 순간 처리 중인 HTTP 요청(SSE 스트림 포함). */
  inFlight: number;
  /** 지난 1초 동안 가장 많았던 처리 중 요청. */
  inFlightMax: number;
}

/** 밀리초 epoch 구간 [from, to). */
export interface Window {
  from: number;
  to: number;
}

export interface Spread {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  count: number;
}

/** k6가 잰 것(방문자 쪽). 시간은 ms. */
export interface K6Step {
  turns: number;
  /** 성공한 대화 턴(200, 종료 센티널까지, event: error 없음)의 비율. */
  chatOkRate: number;
  chatFailed: number;
  /** 대화 응답 첫 바이트. 목업 엔진은 첫 조각이 바로 나오므로 서버 몫이다. 성공한 응답만. */
  ttfb: Spread | null;
  /** 대화 스트림 끝까지(목업의 글자당 지연 포함). */
  stream: Spread | null;
  frame: Spread | null;
  greeting: Spread | null;
  event: Spread | null;
  stepFailed: number;
}

export interface ServerStep {
  samples: number;
  cpuAvg: number;
  cpuMax: number;
  eluAvg: number;
  eluMax: number;
  rssMaxMb: number;
  lagP99MaxMs: number;
  /** 1초당 GC 정지 합의 평균, 가장 긴 GC 한 번. */
  gcMsPerSAvg: number;
  gcMaxMs: number;
  inFlightMax: number;
}

export interface DbStep {
  /** 대화 요청 사건에 서버가 적은 첫 조각 시간(콘솔 지표와 같은 값, nearest-rank). */
  ttftSamples: number;
  ttftP50: number | null;
  ttftP95: number | null;
  /** 단계 시작 때 그 테넌트의 크레딧 원장 행 수. 잔액이 원장 합계라 행이 늘면 잔액 조회가 무거워진다. */
  ledgerRowsBefore: number;
}

/** 기기 CPU(유지 구간 평균 / 최대). 기기 전체는 모든 코어 기준 %, 나머지는 코어 하나 기준 %. */
export interface MachineStep {
  samples: number;
  machine: [number, number];
  server: [number, number];
  k6: [number, number];
  dbVm: [number, number];
  docker: [number, number];
}

export interface StepResult {
  label: string;
  vus: number;
  /** 측정 구간(램프 뒤 유지 구간). ISO 문자열. */
  from: string;
  to: string;
  holdS: number;
  turnsPerS: number;
  k6: K6Step;
  server: ServerStep;
  machine: MachineStep;
  db: DbStep;
}

const trendSchema = z.object({
  med: z.number(),
  'p(95)': z.number(),
  'p(99)': z.number(),
  max: z.number(),
  count: z.number(),
});
const rateSchema = z.object({ passes: z.number(), fails: z.number() });
const counterSchema = z.object({ count: z.number() });
// 표본이 하나도 없던 지표(예: 대화가 모두 실패)는 k6가 내보내지 않는다.
const k6ExportSchema = z.object({
  metrics: z.object({
    chat_ttfb: trendSchema.optional(),
    chat_duration: trendSchema.optional(),
    chat_ok: rateSchema.optional(),
    chat_turns: counterSchema.optional(),
    step_frame: trendSchema.optional(),
    step_greeting: trendSchema.optional(),
    step_event: trendSchema.optional(),
    step_ok: rateSchema.optional(),
  }),
});

const round = (n: number, digits = 1): number => Number(n.toFixed(digits));

function spread(trend: z.infer<typeof trendSchema> | undefined): Spread | null {
  if (!trend || trend.count === 0) return null;
  return { p50: round(trend.med), p95: round(trend['p(95)']), p99: round(trend['p(99)']), max: round(trend.max), count: trend.count };
}

/** k6 --summary-export JSON(바깥 입력)을 읽는다. 모양이 다르면 여기서 실패한다. */
export function readK6Export(raw: unknown): K6Step {
  const { metrics } = k6ExportSchema.parse(raw);
  const ok = metrics.chat_ok ?? { passes: 0, fails: 0 };
  const turns = ok.passes + ok.fails;
  return {
    turns,
    chatOkRate: turns === 0 ? 0 : ok.passes / turns,
    chatFailed: ok.fails,
    ttfb: spread(metrics.chat_ttfb),
    stream: spread(metrics.chat_duration),
    frame: spread(metrics.step_frame),
    greeting: spread(metrics.step_greeting),
    event: spread(metrics.step_event),
    stepFailed: metrics.step_ok?.fails ?? 0,
  };
}

/** 구간 안의 서버 표본을 요약한다. 표본이 없으면 0으로 채우고 samples=0으로 알린다. */
export function summarizeServer(samples: readonly StatsSample[], { from, to }: Window): ServerStep {
  const inside = samples.filter((s) => s.t >= from && s.t < to);
  if (inside.length === 0) {
    return { samples: 0, cpuAvg: 0, cpuMax: 0, eluAvg: 0, eluMax: 0, rssMaxMb: 0, lagP99MaxMs: 0, gcMsPerSAvg: 0, gcMaxMs: 0, inFlightMax: 0 };
  }
  const avg = (pick: (s: StatsSample) => number): number => inside.reduce((sum, s) => sum + pick(s), 0) / inside.length;
  const max = (pick: (s: StatsSample) => number): number => Math.max(...inside.map(pick));
  return {
    samples: inside.length,
    cpuAvg: round(avg((s) => s.cpuPct)),
    cpuMax: round(max((s) => s.cpuPct)),
    eluAvg: round(avg((s) => s.elu), 3),
    eluMax: round(max((s) => s.elu), 3),
    rssMaxMb: round(max((s) => s.rssMb)),
    lagP99MaxMs: round(max((s) => s.loopLagP99Ms), 2),
    gcMsPerSAvg: round(avg((s) => s.gcMs)),
    gcMaxMs: round(max((s) => s.gcMaxMs)),
    inFlightMax: max((s) => s.inFlightMax),
  };
}

/** 구간 안의 기기 CPU 표본을 평균 / 최대로 줄인다. */
export function summarizeMachine(samples: readonly CpuSample[], { from, to }: Window): MachineStep {
  const inside = samples.filter((s) => s.t >= from && s.t < to);
  const pair = (pick: (s: CpuSample) => number): [number, number] =>
    inside.length === 0 ? [0, 0] : [round(inside.reduce((sum, s) => sum + pick(s), 0) / inside.length), round(Math.max(...inside.map(pick)))];
  return {
    samples: inside.length,
    machine: pair((s) => s.machinePct),
    server: pair((s) => s.serverPct),
    k6: pair((s) => s.k6Pct),
    dbVm: pair((s) => s.dbVmPct),
    docker: pair((s) => s.dockerPct),
  };
}

/** 서버가 적은 TTFT 표본(ms) → nearest-rank p50·p95(콘솔 지표와 같은 계산). */
export function summarizeTtft(samples: readonly number[]): Pick<DbStep, 'ttftSamples' | 'ttftP50' | 'ttftP95'> {
  const sorted = [...samples].sort((a, b) => a - b);
  return { ttftSamples: sorted.length, ttftP50: nearestRank(sorted, 50), ttftP95: nearestRank(sorted, 95) };
}

const ms = (s: Spread | null, key: 'p50' | 'p95' | 'p99'): string => (s ? String(s[key]) : '-');
const pct = (rate: number): string => `${round(rate * 100, 2)}%`;

export interface ReportMeta {
  title: string;
  lines: readonly string[];
}

/** 사다리 결과 표(report.md). 숫자는 모두 이 실행 폴더의 파일에서 다시 셀 수 있다. */
export function formatReport({ title, lines }: ReportMeta, steps: readonly StepResult[]): string {
  const visitor = steps.map((s) =>
    [
      s.label,
      s.turnsPerS,
      s.k6.turns,
      pct(s.k6.chatOkRate),
      `${ms(s.k6.ttfb, 'p50')} / ${ms(s.k6.ttfb, 'p95')} / ${ms(s.k6.ttfb, 'p99')}`,
      `${ms(s.k6.stream, 'p50')} / ${ms(s.k6.stream, 'p95')}`,
      `${ms(s.k6.frame, 'p95')} / ${ms(s.k6.greeting, 'p95')} / ${ms(s.k6.event, 'p95')}`,
      s.k6.stepFailed,
    ].join(' | '),
  );
  const server = steps.map((s) =>
    [
      s.label,
      `${s.server.cpuAvg} / ${s.server.cpuMax}`,
      `${s.server.eluAvg} / ${s.server.eluMax}`,
      s.server.lagP99MaxMs,
      `${s.server.gcMsPerSAvg} / ${s.server.gcMaxMs}`,
      s.server.inFlightMax,
      s.server.rssMaxMb,
      `${s.db.ttftP50 ?? '-'} / ${s.db.ttftP95 ?? '-'} (${s.db.ttftSamples})`,
      s.db.ledgerRowsBefore,
    ].join(' | '),
  );
  const machine = steps.map((s) =>
    [s.label, ...[s.machine.machine, s.machine.server, s.machine.k6, s.machine.dbVm, s.machine.docker].map(([a, m]) => `${a} / ${m}`)].join(' | '),
  );
  return [
    `# ${title}`,
    '',
    ...lines.map((l) => `- ${l}`),
    '',
    '## 방문자 쪽(k6, 유지 구간)',
    '',
    '| 단계 | 대화 턴/초 | 대화 턴 | 대화 성공 | 첫 바이트 p50 / p95 / p99 (ms) | 스트림 끝 p50 / p95 (ms) | 문서 / 인사말 / 사건 p95 (ms) | 그 밖의 실패 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...visitor.map((row) => `| ${row} |`),
    '',
    '## 서버 쪽(1초 표본, 유지 구간)',
    '',
    '| 단계 | CPU % 평균 / 최대 | 루프 사용률 평균 / 최대 | 루프 지연 p99 최대 (ms) | GC ms/초 평균 / 한 번 최대 | 처리 중 요청 최대 | RSS 최대 (MB) | 서버 기록 TTFT p50 / p95 (ms, 표본) | 시작 때 원장 행 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...server.map((row) => `| ${row} |`),
    '',
    '## 기기 CPU(1초 표본, 유지 구간)',
    '',
    '기기 전체는 모든 코어 기준(100%가 최대), 나머지는 코어 하나 기준(100%가 코어 하나)이다.',
    '',
    '| 단계 | 기기 전체 % 평균 / 최대 | 서버 | k6 | Docker VM(Postgres) | Docker 백엔드(포트 프록시) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...machine.map((row) => `| ${row} |`),
    '',
  ].join('\n');
}
