// 부하 측정용 서버(W6). 운영 진입점(src/index.ts)과 같은 createApp 조립이고, 다른 점은 아래뿐이다.
//   엔진       목업. 첫 조각이 지연 없이 나오므로 응답 첫 바이트까지의 시간이 곧 서버 몫(테넌트·잔액·이전 대화·지식 조회와 모더레이션)이다.
//              이후 글자마다 QRATE_LOAD_DELAY_MS(기본 20ms, 목업 기본값)를 쉬어 연결이 실제 답처럼 몇 초 열려 있다.
//   저장소     Postgres만. DB 이름에 load가 들어 있어야 뜬다 — 개발 DB에 수만 행을 쌓지 않게.
//   요율 제한  대화·위젯 사건의 IP당 상한을 크게 올린다. k6는 127.0.0.1 한 곳에서 방문자 수백 명을 흉내 내므로 운영 상한(대화 분당 20)이면 429만 잰다.
//              미들웨어는 그대로 지나가므로 세는 비용은 측정에 들어간다.
//   끈 것      콘솔·결제·Sentry. 방문자 경로가 아니다.
//   더한 것    1초마다 CPU·메모리·이벤트 루프 지연·처리 중 요청 수를 QRATE_LOAD_STATS_FILE에 JSONL로 남긴다.
// 시작할 때 데모 시드를 넣고(멱등) 크레딧을 TOP_UP_TO까지 채운다. 답이 있는 턴마다 1씩 빠진다.
import { PrismaPg } from '@prisma/adapter-pg';
import express from 'express';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { MockEngine } from '../src/engine/mock.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { applySeed, createPrismaClient, createPrismaRepositories } from '../src/repo/prisma.js';
import { DEFAULT_SEED_PATH, loadSeedFile } from '../src/repo/seed.js';
import type { StatsSample } from './summary.js';

const TOP_UP_TO = 1_000_000;
const UNLIMITED = { max: 1_000_000_000, windowMs: 60_000 };
/** 이벤트 루프 지연 측정 타이머의 간격. 히스토그램은 타이머 사이 간격 전체를 담으므로 이 값을 빼야 밀린 시간이 된다. */
const LOOP_RESOLUTION_MS = 10;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}이 필요하다 (load/README.md)`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}=${raw}: 0 이상의 정수여야 한다`);
  return n;
}

/** 전용 DB만 받는다. 이름은 연결 주소의 경로(/qrate_load). */
function loadDatabaseUrl(): string {
  const url = requireEnv('DATABASE_URL');
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.includes('load')) throw new Error(`DB 이름에 load가 없다(${name}). 부하 측정은 전용 DB에서만 돈다`);
  return url;
}

const round = (n: number, digits = 1): number => Number(n.toFixed(digits));
const lagMs = (ns: number): number => round(Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS), 2);

const port = positiveInt('PORT', 8789);
const delayMs = positiveInt('QRATE_LOAD_DELAY_MS', 20);
// 0이면 운영과 같은 클라이언트(createPrismaClient, node-postgres 풀 기본 10개). 숫자를 주면 그 크기의 풀로 비교 실험을 한다.
const poolSize = positiveInt('QRATE_LOAD_POOL', 0);
const databaseUrl = loadDatabaseUrl();
const statsFile = process.env.QRATE_LOAD_STATS_FILE;
const publicOrigin = `http://127.0.0.1:${port}`;

const prisma =
  poolSize > 0 ? new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: poolSize }) }) : createPrismaClient(databaseUrl);
const seed = loadSeedFile(DEFAULT_SEED_PATH);
await applySeed(prisma, seed);
const repos = createPrismaRepositories(prisma);
const balance = await repos.credits.balance(seed.tenant.id);
if (balance < TOP_UP_TO) {
  await repos.credits.append(seed.tenant.id, { delta: TOP_UP_TO - balance, reason: 'adjustment', idempotencyKey: `adj:load-${Date.now()}` });
}

const require = createRequire(import.meta.url);
const frameAssetsDir = path.join(path.dirname(require.resolve('@qrate/widget/package.json')), 'dist', 'frame');
const app = createApp({
  engine: new MockEngine(delayMs),
  repos,
  publicOrigin,
  frameAssetsDir,
  chatRequests: UNLIMITED,
  eventRequests: UNLIMITED,
  handoffRequests: UNLIMITED,
});

let inFlight = 0;
let inFlightMax = 0;
const outer = express();
outer.disable('x-powered-by');
outer.use((_req, res, next) => {
  inFlight += 1;
  inFlightMax = Math.max(inFlightMax, inFlight);
  res.on('close', () => {
    inFlight -= 1;
  });
  next();
});
outer.use(app);

const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loopDelay.enable();
// GC가 JS 실행을 멈춘 시간. 지연이 튈 때 GC 때문인지 가른다.
let gcMs = 0;
let gcMaxMs = 0;
const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcMs += entry.duration;
    gcMaxMs = Math.max(gcMaxMs, entry.duration);
  }
});
gcObserver.observe({ entryTypes: ['gc'] });
const stats = statsFile ? createWriteStream(statsFile, { flags: 'a' }) : null;
let lastCpu = process.cpuUsage();
let lastElu = performance.eventLoopUtilization();
let lastAt = performance.now();
const sampler = setInterval(() => {
  const cpu = process.cpuUsage(lastCpu);
  const elu = performance.eventLoopUtilization(lastElu);
  const now = performance.now();
  const memory = process.memoryUsage();
  const sample: StatsSample = {
    t: Date.now(),
    cpuPct: round(((cpu.user + cpu.system) / 1000 / (now - lastAt)) * 100),
    elu: round(elu.utilization, 3),
    rssMb: round(memory.rss / 1048576),
    heapUsedMb: round(memory.heapUsed / 1048576),
    loopLagP99Ms: lagMs(loopDelay.percentile(99)),
    loopLagMaxMs: lagMs(loopDelay.max),
    gcMs: round(gcMs),
    gcMaxMs: round(gcMaxMs),
    inFlight,
    inFlightMax,
  };
  stats?.write(`${JSON.stringify(sample)}\n`);
  loopDelay.reset();
  gcMs = 0;
  gcMaxMs = 0;
  inFlightMax = inFlight;
  lastCpu = process.cpuUsage();
  lastElu = performance.eventLoopUtilization();
  lastAt = now;
}, 1000);

const server = outer.listen(port, '127.0.0.1', () => {
  console.log(
    `[load-server] ${publicOrigin} engine=mock delay=${delayMs}ms pool=${poolSize > 0 ? poolSize : 'default'} tenant=${seed.tenant.apiKey} credits>=${TOP_UP_TO}`,
  );
});

const shutdown = (): void => {
  clearInterval(sampler);
  loopDelay.disable();
  gcObserver.disconnect();
  server.close(() => {
    void prisma.$disconnect().finally(() => stats?.end());
  });
  server.closeAllConnections();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
