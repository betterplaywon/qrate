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
/** 요율 제한 미들웨어는 운영과 같이 지나가되, 상한에는 닿지 않는다. */
const UNREACHED_LIMIT = { max: 1_000_000_000, windowMs: 60_000 };
/** 이벤트 루프 지연 측정 타이머의 간격. 히스토그램은 타이머 사이 간격 전체를 담으므로 이 값을 빼야 밀린 시간이 된다. */
const LOOP_RESOLUTION_MS = 10;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}이 필요하다 (load/README.md)`);
  return value;
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}=${raw}: 0 이상의 정수여야 한다`);
  return n;
}

function loadDatabaseUrl(): string {
  const url = requireEnv('DATABASE_URL');
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.includes('load')) throw new Error(`DB 이름에 load가 없다(${name}). 부하 측정은 전용 DB에서만 돈다`);
  return url;
}

const round = (n: number, digits = 1): number => Number(n.toFixed(digits));
const lagMs = (ns: number): number => round(Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS), 2);

const port = envInt('PORT') ?? 8789;
const delayMs = envInt('QRATE_LOAD_DELAY_MS') ?? 20;
const poolSize = envInt('QRATE_LOAD_POOL');
const databaseUrl = loadDatabaseUrl();
const statsFile = process.env.QRATE_LOAD_STATS_FILE;
const publicOrigin = `http://127.0.0.1:${port}`;

const prisma =
  poolSize === undefined
    ? createPrismaClient(databaseUrl)
    : new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: poolSize }) });
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
  chatRequests: UNREACHED_LIMIT,
  eventRequests: UNREACHED_LIMIT,
  handoffRequests: UNREACHED_LIMIT,
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
    `[load-server] ${publicOrigin} engine=mock delay=${delayMs}ms pool=${poolSize ?? 'default'} tenant=${seed.tenant.apiKey} credits>=${TOP_UP_TO}`,
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
