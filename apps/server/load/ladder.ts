// 부하 측정 사다리(W6). 측정 서버(load/server.ts)를 띄우고, 데우기 한 번 뒤 동시 방문자 수마다 k6 시나리오(load/visit.js)를 돌려
// 실행 폴더에 원본(k6 요약·서버 표본·로그)과 표(report.md)를 남긴다. 사용법과 전제는 load/README.md.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { applySeed, createPrismaClient, createPrismaRepositories } from '../src/repo/prisma.js';
import { DEFAULT_SEED_PATH, loadSeedFile } from '../src/repo/seed.js';
import { sampleCpu, type CpuSample } from './cpu.js';
import { formatReport, readK6Export, summarizeMachine, summarizeServer, summarizeTtft, type StatsSample, type StepResult } from './summary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');

const { values: args } = parseArgs({
  options: {
    run: { type: 'string' },
    vus: { type: 'string', default: '10,50,100,200,400' },
    ramp: { type: 'string', default: '15' },
    hold: { type: 'string', default: '60' },
    think: { type: 'string', default: '3' },
    pool: { type: 'string', default: '0' },
    delay: { type: 'string', default: '20' },
    port: { type: 'string', default: '8789' },
    'repeat-first': { type: 'boolean', default: false },
    /** 단계마다 새 테넌트의 크레딧 원장에 미리 넣을 행 수(차감 기록). 잔액이 원장 합계라 행 수가 잔액 조회 비용을 정한다. */
    'ledger-rows': { type: 'string', default: '0' },
    /** 측정 서버를 node --cpu-prof로 띄워 실행 폴더에 server.cpuprofile을 남긴다(프로파일러 비용이 측정에 들어간다). */
    profile: { type: 'boolean', default: false },
  },
});

function int(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name}=${raw}: 0 이상의 정수여야 한다`);
  return n;
}

if (!args.run) throw new Error('--run <실행 폴더>가 필요하다 (load/README.md)');
const runDir = path.resolve(serverDir, args.run);
const vusList = args.vus.split(',').map((v) => int('vus', v.trim()));
const rampS = int('ramp', args.ramp);
const holdS = int('hold', args.hold);
const thinkS = Number(args.think);
const ledgerRows = int('ledger-rows', args['ledger-rows']);
const port = int('port', args.port);
const base = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL이 필요하다(이름에 load가 들어간 전용 DB)');
if (existsSync(path.join(runDir, 'steps.json'))) throw new Error(`${runDir}에 이미 결과가 있다. 새 폴더를 쓴다`);
mkdirSync(runDir, { recursive: true });

function k6Version(): string {
  const r = spawnSync('k6', ['version'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('k6가 PATH에 없다 (brew install k6)');
  return r.stdout.trim();
}

/** 이 셸에서 연 프로세스가 열 수 있는 파일 수. 낮으면(256) 방문자가 많을 때 소켓이 모자라 서버가 아니라 환경이 막힌다. */
function fileLimit(): string {
  return spawnSync('/bin/sh', ['-c', 'ulimit -n'], { encoding: 'utf8' }).stdout.trim();
}

async function waitForExit(child: ReturnType<typeof spawn>, what: string): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', (err) => reject(new Error(`${what}: ${err.message}`)));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

async function waitForHealth(child: ReturnType<typeof spawn>, logPath: string): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) throw new Error(`측정 서버가 시작 중에 끝났다 — ${logPath}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
      // 아직 듣지 않는다
    }
    await sleep(500);
  }
  throw new Error(`측정 서버가 60초 안에 뜨지 않았다 — ${logPath}`);
}

interface K6Run {
  label: string;
  vus: number;
  ramp: number;
  hold: number;
  /** k6가 부를 테넌트 키. */
  tenant: string;
}

async function runK6({ label, vus, ramp, hold, tenant }: K6Run): Promise<{ exportPath: string; startedAt: number }> {
  const exportPath = path.join(runDir, `k6-${label}.json`);
  const log = openSync(path.join(runDir, `k6-${label}.log`), 'a');
  const env = [`VUS=${vus}`, `RAMP_S=${ramp}`, `HOLD_S=${hold}`, `THINK_S=${thinkS}`, `BASE_URL=${base}`, `TENANT=${tenant}`];
  const startedAt = Date.now();
  const child = spawn('k6', ['run', '--quiet', '--summary-export', exportPath, ...env.flatMap((e) => ['-e', e]), path.join(here, 'visit.js')], {
    stdio: ['ignore', log, log],
  });
  const code = await waitForExit(child, 'k6');
  if (code !== 0) throw new Error(`k6 ${label} 종료 코드 ${code} — ${path.join(runDir, `k6-${label}.log`)}`);
  return { exportPath, startedAt };
}

/** 이 실행이 직접 쓴 JSONL(측정 서버의 표본, 기기 CPU 표본)을 읽는다. */
function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

const seed = loadSeedFile(DEFAULT_SEED_PATH);
const prisma = createPrismaClient(databaseUrl);
const repos = createPrismaRepositories(prisma);
const runStamp = Date.now().toString(36);
const FILL_CHUNK = 10_000;

/**
 * 단계 전용 테넌트(데모와 같은 지식·허용 오리진, 키 = id). 단계마다 원장이 비어 있어야 앞 단계가 쌓은 행이 뒤 단계의 잔액 조회를
 * 무겁게 하지 않는다. ledgerRows만큼 차감 기록을 미리 넣고, 잔액은 그만큼 더 지급해 백만으로 맞춘다.
 */
async function stepTenant(label: string): Promise<{ id: string; ledgerRowsBefore: number }> {
  const id = `load-${runStamp}-${label}`;
  await applySeed(prisma, { ...seed, tenant: { ...seed.tenant, id, apiKey: id }, initialCredits: 1_000_000 + ledgerRows });
  for (let offset = 0; offset < ledgerRows; offset += FILL_CHUNK) {
    const size = Math.min(FILL_CHUNK, ledgerRows - offset);
    await prisma.creditLedger.createMany({
      data: Array.from({ length: size }, (_, i) => ({ tenantId: id, delta: -1, reason: 'turn' as const, idempotencyKey: `turn:fill-${offset + i}` })),
    });
  }
  return { id, ledgerRowsBefore: await prisma.creditLedger.count({ where: { tenantId: id } }) };
}
const statsPath = path.join(runDir, 'server-stats.jsonl');
const cpuPath = path.join(runDir, 'cpu.jsonl');
const serverLogPath = path.join(runDir, 'server.log');

const k6 = k6Version();
const postgres = (await prisma.$queryRaw<{ version: string }[]>`select version()`)[0]?.version ?? '?';
const meta = {
  date: new Date().toISOString(),
  machine: `${os.cpus()[0]?.model ?? '?'} ${os.cpus().length}코어, 메모리 ${Math.round(os.totalmem() / 2 ** 30)}GB, ${os.type()} ${os.release()}`,
  node: process.version,
  k6,
  postgres: postgres.split(' on ')[0] ?? postgres,
  fileLimit: fileLimit(),
  settings: {
    vus: vusList,
    rampS,
    holdS,
    thinkS,
    mockDelayMs: int('delay', args.delay),
    pool: int('pool', args.pool) || 'default(10)',
    ledgerRows,
    profile: args.profile,
  },
};
writeFileSync(path.join(runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

const serverLog = openSync(serverLogPath, 'a');
const profileArgs = args.profile ? ['--cpu-prof', `--cpu-prof-dir=${runDir}`, '--cpu-prof-name=server.cpuprofile'] : [];
const server = spawn(process.execPath, [...profileArgs, '--conditions=source', '--import', 'tsx', path.join(here, 'server.ts')], {
  cwd: serverDir,
  env: {
    ...process.env,
    PORT: String(port),
    QRATE_LOAD_DELAY_MS: args.delay,
    QRATE_LOAD_POOL: args.pool,
    QRATE_LOAD_STATS_FILE: statsPath,
  },
  stdio: ['ignore', serverLog, serverLog],
});
const serverExit = waitForExit(server, '측정 서버');
const stopCpu = sampleCpu(server.pid ?? -1, (sample: CpuSample) => appendFileSync(cpuPath, `${JSON.stringify(sample)}\n`));

const steps: StepResult[] = [];
try {
  await waitForHealth(server, serverLogPath);
  console.log(`[load] 데우기 10명 ${rampS + 10}초`);
  await runK6({ label: 'warmup', vus: 10, ramp: rampS, hold: 10, tenant: seed.tenant.apiKey });
  await sleep(3000);

  const labels = vusList.map((vus) => ({ label: String(vus), vus }));
  const first = labels[0];
  if (args['repeat-first'] && first) labels.push({ label: `${first.label}-again`, vus: first.vus });

  for (const { label, vus } of labels) {
    const tenant = await stepTenant(label);
    const run: K6Run = { label, vus, ramp: rampS, hold: holdS, tenant: tenant.id };
    console.log(`[load] 동시 방문자 ${run.vus}명: 램프 ${run.ramp}초 + 유지 ${run.hold}초, 테넌트 ${tenant.id}(원장 ${tenant.ledgerRowsBefore}행)`);
    const { exportPath, startedAt } = await runK6(run);
    // 사건은 응답이 끝난 뒤 따로 저장된다. 마지막 몇 건이 들어올 때까지 기다린다.
    await sleep(2000);
    const window = { from: startedAt + run.ramp * 1000, to: startedAt + (run.ramp + run.hold) * 1000 };
    const k6Step = readK6Export(JSON.parse(readFileSync(exportPath, 'utf8')));
    const ttft = await repos.events.ttftSamples(tenant.id, { from: new Date(window.from), to: new Date(window.to) });
    const ledgerRowsBefore = tenant.ledgerRowsBefore;
    steps.push({
      label: run.label,
      vus: run.vus,
      from: new Date(window.from).toISOString(),
      to: new Date(window.to).toISOString(),
      holdS: run.hold,
      turnsPerS: Number((k6Step.turns / run.hold).toFixed(2)),
      k6: k6Step,
      server: summarizeServer(readJsonl<StatsSample>(statsPath), window),
      machine: summarizeMachine(readJsonl<CpuSample>(cpuPath), window),
      db: { ...summarizeTtft(ttft), ledgerRowsBefore },
    });
    await sleep(3000);
  }
} finally {
  stopCpu();
  server.kill('SIGTERM');
  await serverExit;
  await prisma.$disconnect();
}

writeFileSync(path.join(runDir, 'steps.json'), `${JSON.stringify({ meta, steps }, null, 2)}\n`);
const report = formatReport(
  {
    title: `부하 측정 ${meta.date.slice(0, 10)} (시뮬레이션: 목업 엔진, 로컬 한 대)`,
    lines: [
      `기기: ${meta.machine}. 서버·Postgres(Docker)·k6가 같은 기기에서 돈다`,
      `Node ${meta.node}, ${meta.k6}, ${meta.postgres}, 파일 한도 ${meta.fileLimit}`,
      `목업 글자당 ${meta.settings.mockDelayMs}ms, DB 풀 ${meta.settings.pool}, 램프 ${rampS}초 + 유지 ${holdS}초, 생각 시간 평균 ${thinkS}초`,
      `단계마다 새 테넌트(원장 미리 넣은 행 ${ledgerRows}개)`,
    ],
  },
  steps,
);
writeFileSync(path.join(runDir, 'report.md'), report);
console.log(report);
