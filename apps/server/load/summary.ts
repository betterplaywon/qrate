import { z } from 'zod';
import { summarizeTtft, type ConsoleMetrics } from '../src/events/metrics.js';
import type { CpuSample } from './cpu.js';

export const statsSampleSchema = z.object({
  t: z.number(),
  cpuPct: z.number(),
  elu: z.number(),
  rssMb: z.number(),
  heapUsedMb: z.number(),
  loopLagP99Ms: z.number(),
  loopLagMaxMs: z.number(),
  gcMs: z.number(),
  gcMaxMs: z.number(),
  inFlight: z.number(),
  inFlightMax: z.number(),
});
export type StatsSample = z.infer<typeof statsSampleSchema>;

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

export interface K6Step {
  /** k6 setup()이 남긴 시험 시작 시각(epoch ms). 유지 구간은 여기서 램프만큼 뒤에 시작한다. */
  startedAt: number;
  turns: number;
  chatOkRate: number;
  chatFailed: number;
  ttfb: Spread | null;
  stream: Spread | null;
  frame: Spread | null;
  assets: Spread | null;
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
  gcMsPerSAvg: number;
  gcMaxMs: number;
  inFlightMax: number;
}

export interface DbStep {
  ttft: ConsoleMetrics['ttft'];
  ledgerRowsBefore: number;
}

/** [평균, 최대]. allCores는 모든 코어 기준 %(100이 최대), 나머지는 코어 하나 기준 %. */
export interface MachineStep {
  samples: number;
  allCores: [number, number];
  server: [number, number];
  k6: [number, number];
  dbVm: [number, number];
  docker: [number, number];
}

export interface StepResult {
  label: string;
  vus: number;
  from: string;
  to: string;
  holdS: number;
  turnsPerS: number;
  k6: K6Step;
  server: ServerStep | null;
  machine: MachineStep | null;
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
  setup_data: z.object({ startedAt: z.number() }),
  metrics: z.object({
    chat_ttfb: trendSchema.optional(),
    chat_duration: trendSchema.optional(),
    chat_ok: rateSchema.optional(),
    chat_turns: counterSchema.optional(),
    step_frame: trendSchema.optional(),
    step_assets: trendSchema.optional(),
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

export function readK6Export(raw: unknown): K6Step {
  const { setup_data: setupData, metrics } = k6ExportSchema.parse(raw);
  const ok = metrics.chat_ok ?? { passes: 0, fails: 0 };
  const turns = ok.passes + ok.fails;
  return {
    startedAt: setupData.startedAt,
    turns,
    chatOkRate: turns === 0 ? 0 : ok.passes / turns,
    chatFailed: ok.fails,
    ttfb: spread(metrics.chat_ttfb),
    stream: spread(metrics.chat_duration),
    frame: spread(metrics.step_frame),
    assets: spread(metrics.step_assets),
    greeting: spread(metrics.step_greeting),
    event: spread(metrics.step_event),
    stepFailed: metrics.step_ok?.fails ?? 0,
  };
}

/** k6 시험 시작 시각에서 램프 뒤의 유지 구간. visit.js의 inHold()와 같은 구간이다. */
export function holdWindow(startedAt: number, { ramp, hold }: { ramp: number; hold: number }): Window {
  return { from: startedAt + ramp * 1000, to: startedAt + (ramp + hold) * 1000 };
}

function inWindow<T extends { t: number }>(samples: readonly T[], { from, to }: Window): T[] {
  return samples.filter((s) => s.t >= from && s.t < to);
}

function average<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((sum, item) => sum + pick(item), 0) / items.length;
}

export function summarizeServer(samples: readonly StatsSample[], window: Window): ServerStep | null {
  const inside = inWindow(samples, window);
  if (inside.length === 0) return null;
  const max = (pick: (s: StatsSample) => number): number => Math.max(...inside.map(pick));
  return {
    samples: inside.length,
    cpuAvg: round(average(inside, (s) => s.cpuPct)),
    cpuMax: round(max((s) => s.cpuPct)),
    eluAvg: round(average(inside, (s) => s.elu), 3),
    eluMax: round(max((s) => s.elu), 3),
    rssMaxMb: round(max((s) => s.rssMb)),
    lagP99MaxMs: round(max((s) => s.loopLagP99Ms), 2),
    gcMsPerSAvg: round(average(inside, (s) => s.gcMs)),
    gcMaxMs: round(max((s) => s.gcMaxMs)),
    inFlightMax: max((s) => s.inFlightMax),
  };
}

export function summarizeMachine(samples: readonly CpuSample[], window: Window): MachineStep | null {
  const inside = inWindow(samples, window);
  if (inside.length === 0) return null;
  const pair = (pick: (s: CpuSample) => number): [number, number] => [round(average(inside, pick)), round(Math.max(...inside.map(pick)))];
  return {
    samples: inside.length,
    allCores: pair((s) => s.allCoresPct),
    server: pair((s) => s.serverPct),
    k6: pair((s) => s.k6Pct),
    dbVm: pair((s) => s.dbVmPct),
    docker: pair((s) => s.dockerPct),
  };
}

export function summarizeDb(ttftSamples: readonly number[], ledgerRowsBefore: number): DbStep {
  return { ttft: summarizeTtft(ttftSamples), ledgerRowsBefore };
}

const ms = (s: Spread | null, key: 'p50' | 'p95' | 'p99'): string => (s ? String(s[key]) : '-');
const pct = (rate: number): string => `${round(rate * 100, 2)}%`;
const pair = ([avg, max]: [number, number]): string => `${avg} / ${max}`;

export interface ReportMeta {
  title: string;
  lines: readonly string[];
}

function visitorRow(s: StepResult): string[] {
  return [
    s.label,
    String(s.turnsPerS),
    String(s.k6.turns),
    pct(s.k6.chatOkRate),
    `${ms(s.k6.ttfb, 'p50')} / ${ms(s.k6.ttfb, 'p95')} / ${ms(s.k6.ttfb, 'p99')}`,
    `${ms(s.k6.stream, 'p50')} / ${ms(s.k6.stream, 'p95')}`,
    `${ms(s.k6.frame, 'p95')} / ${ms(s.k6.assets, 'p95')} / ${ms(s.k6.greeting, 'p95')} / ${ms(s.k6.event, 'p95')}`,
    String(s.k6.stepFailed),
  ];
}

function serverRow(s: StepResult): string[] {
  const ttft = `${s.db.ttft.p50Ms ?? '-'} / ${s.db.ttft.p95Ms ?? '-'} (${s.db.ttft.samples})`;
  const v = s.server;
  if (!v) return [s.label, '-', '-', '-', '-', '-', '-', ttft, String(s.db.ledgerRowsBefore)];
  return [
    s.label,
    `${v.cpuAvg} / ${v.cpuMax}`,
    `${v.eluAvg} / ${v.eluMax}`,
    String(v.lagP99MaxMs),
    `${v.gcMsPerSAvg} / ${v.gcMaxMs}`,
    String(v.inFlightMax),
    String(v.rssMaxMb),
    ttft,
    String(s.db.ledgerRowsBefore),
  ];
}

function machineRow(s: StepResult): string[] {
  const m = s.machine;
  if (!m) return [s.label, '-', '-', '-', '-', '-'];
  return [s.label, pair(m.allCores), pair(m.server), pair(m.k6), pair(m.dbVm), pair(m.docker)];
}

const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;

export function formatReport({ title, lines }: ReportMeta, steps: readonly StepResult[]): string {
  return [
    `# ${title}`,
    '',
    ...lines.map((l) => `- ${l}`),
    '',
    '## 방문자 쪽(k6, 유지 구간)',
    '',
    '| 단계 | 대화 턴/초 | 대화 턴 | 대화 성공 | 첫 바이트 p50 / p95 / p99 (ms) | 스트림 끝 p50 / p95 (ms) | 문서 / 정적 파일 / 인사말 / 사건 p95 (ms) | 그 밖의 실패 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...steps.map((s) => row(visitorRow(s))),
    '',
    '## 서버 쪽(1초 표본, 유지 구간)',
    '',
    '| 단계 | CPU % 평균 / 최대 | 루프 사용률 평균 / 최대 | 루프 지연 p99 최대 (ms) | GC ms/초 평균 / 한 번 최대 | 처리 중 요청 최대 | RSS 최대 (MB) | 서버 기록 TTFT p50 / p95 (ms, 표본) | 시작 때 원장 행 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...steps.map((s) => row(serverRow(s))),
    '',
    '## 기기 CPU(1초 표본, 유지 구간)',
    '',
    '기기 전체는 모든 코어 기준(100%가 최대), 나머지는 코어 하나 기준(100%가 코어 하나)이다.',
    '',
    '| 단계 | 기기 전체 % 평균 / 최대 | 서버 | k6 | Docker VM(Postgres) | Docker 백엔드(포트 프록시) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...steps.map((s) => row(machineRow(s))),
    '',
  ].join('\n');
}
