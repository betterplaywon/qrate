/* global fetch, AbortSignal */
// verify 스크립트(launch·doctor·drive·cleanup)가 함께 쓰는 값과 도우미. 실행 진입점이 아니다.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPTS_DIR, '../../../..');
export const EVIDENCE_ROOT = path.join(REPO_ROOT, '.audit', 'evidence');
export const JOURNEYS_DIR = path.join(SCRIPTS_DIR, 'journeys');

export const SERVER_ORIGIN = 'http://localhost:8787';
export const DEMO_ORIGIN = 'http://localhost:5173';
export const NOT_ALLOWED_DEMO_ORIGIN = 'http://localhost:5174';
export const CHAT_URL = `${SERVER_ORIGIN}/api/chat`;
export const HANDOFF_URL = `${SERVER_ORIGIN}/api/handoff`;
export const TENANT = 'demo';
export const TENANT_NAME = '마루인보이스';
// packages/widget/e2e/servers.ts의 CONSOLE_KEY와 같은 값 — 서버가 시작 때 해시해 데모 테넌트의 콘솔 키로 쓴다.
export const CONSOLE_KEY = 'e2e-widget-console-key';
const CONSOLE_SECRET = 'verify-session-secret-0123';
// 모의 결제 제공자의 웹훅 서명 비밀. 여정이 같은 비밀로 서명한 웹훅을 HTTP로 직접 보내 재배달·위조를 재현한다.
export const MOCK_PAYMENT_SECRET = 'verify-mock-payment-secret-01';

/**
 * 이 스킬이 띄우는 프로세스. 포트는 바꿀 수 없다 — 5173은 시드 테넌트의 allowedOrigins(apps/server/seed/demo-tenant.json)에
 * 묶여 있고, 8787은 데모 페이지의 data-endpoint(packages/widget/demo.html)에 적혀 있다.
 */
export const PROCESSES = [
  {
    name: 'server',
    port: 8787,
    script: 'apps/server/dist/index.js',
    log: 'server.log',
    env: {
      QRATE_ENGINE: 'mock',
      QRATE_REPO: 'memory',
      PORT: '8787',
      QRATE_PUBLIC_ORIGIN: SERVER_ORIGIN,
      QRATE_DEMO_CONSOLE_KEY: CONSOLE_KEY,
      QRATE_CONSOLE_SECRET: CONSOLE_SECRET,
      QRATE_PAYMENT_PROVIDER: 'mock',
      QRATE_MOCK_PAYMENT_SECRET: MOCK_PAYMENT_SECRET,
    },
  },
  { name: 'demo', port: 5173, script: 'packages/widget/demo.mjs', log: 'demo-5173.log', env: { PORT: '5173' } },
  { name: 'demo-not-allowed', port: 5174, script: 'packages/widget/demo.mjs', log: 'demo-5174.log', env: { PORT: '5174' } },
];
/** 8788은 이 스킬이 쓰지 않지만 `pnpm e2e`(콘솔 E2E)가 쓰므로 비어 있는지 함께 본다. */
export const WATCHED_PORTS = [8787, 5173, 5174, 8788];

/** 루트 `pnpm build`가 만드는 산출물 중 이 스킬이 기대는 것. 하나라도 없으면 launch가 멈춘다. */
export const BUILD_OUTPUTS = [
  'apps/server/dist/index.js',
  'packages/widget/dist/widget.js',
  'packages/widget/dist/frame/app.js',
  'apps/console/dist/index.html',
];

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

export function listFeatures() {
  return readdirSync(JOURNEYS_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.slice(0, -'.mjs'.length))
    .sort();
}

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

export function createRunDir(feature) {
  mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const base = path.join(EVIDENCE_ROOT, `${stamp()}-${feature}`);
  let dir = base;
  for (let n = 2; existsSync(dir); n += 1) dir = `${base}-${n}`;
  mkdirSync(dir);
  return dir;
}

export function readRun(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8'));
}

export function writeRun(dir, run) {
  writeFileSync(path.join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
}

/** run.json이 있는 실행 전부, 최근에 쓴 순서. */
export function listRuns() {
  if (!existsSync(EVIDENCE_ROOT)) return [];
  return readdirSync(EVIDENCE_ROOT)
    .map((name) => path.join(EVIDENCE_ROOT, name))
    .filter((dir) => existsSync(path.join(dir, 'run.json')))
    .map((dir) => ({ dir, run: readRun(dir), mtime: statSync(path.join(dir, 'run.json')).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

/** `--run <dir>`가 있으면 그 실행, 없으면 status가 running인 가장 최근 실행. 없으면 null. */
export function resolveRun(args) {
  const explicit = argValue(args, '--run');
  if (explicit) {
    const dir = path.resolve(REPO_ROOT, explicit);
    return { dir, run: readRun(dir) };
  }
  const running = listRuns().find((r) => r.run.status === 'running');
  return running ? { dir: running.dir, run: running.run } : null;
}

export function relative(file) {
  return path.relative(REPO_ROOT, file);
}

export function listeningPids(port) {
  // lsof는 결과가 없으면 종료 코드 1을 낸다 — 오류가 아니라 "비어 있음"이다.
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' });
  return (r.stdout ?? '')
    .split('\n')
    .filter((line) => line.startsWith('p'))
    .map((line) => Number(line.slice(1)));
}

export function lsofText(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function commandOf(pid) {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return (r.stdout ?? '').trim() || null;
}

/** 살아 있고 명령줄에 우리 스크립트가 있는 프로세스만 "우리 것"이다 — 종료 뒤 재사용된 PID를 남의 프로세스로 오인하지 않게. */
export function isOurs(proc) {
  if (!isAlive(proc.pid)) return false;
  const cmd = commandOf(proc.pid);
  return Boolean(cmd && cmd.includes(proc.script));
}

async function waitUntilGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
  return true;
}

/** run.json에 적힌 프로세스 하나를 끝낸다. 이름으로 죽이지 않는다 — PID와 명령줄이 맞을 때만. */
export async function stopProcess(proc) {
  if (!isAlive(proc.pid)) return 'already-gone';
  if (!isOurs(proc)) return 'not-ours';
  process.kill(proc.pid, 'SIGTERM');
  if (await waitUntilGone(proc.pid, 5000)) return 'terminated';
  process.kill(proc.pid, 'SIGKILL');
  return (await waitUntilGone(proc.pid, 2000)) ? 'killed' : 'still-alive';
}

export async function http(url, { timeoutMs = 5000, ...init } = {}) {
  const res = await fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers),
    text,
    json() {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
  };
}

export async function waitFor(check, { timeoutMs = 20_000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`${label}: ${timeoutMs}ms 안에 충족되지 않음${lastError ? ` (${lastError.message})` : ''}`);
    }
    await sleep(intervalMs);
  }
}

/** 레포의 Playwright. 이 폴더에는 node_modules가 없으므로 그 devDependency를 가진 위젯 패키지 기준으로 찾는다. */
export function playwright() {
  const require = createRequire(path.join(REPO_ROOT, 'packages/widget/package.json'));
  return require('@playwright/test');
}

export function tail(file, lines = 20) {
  if (!existsSync(file)) return '(없음)';
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lines).join('\n');
}

export function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** 서버 시작 로그에서 엔진·저장소 줄을 읽는다. mock·memory가 아니면 그 인스턴스는 드라이브하면 안 된다. */
export function serverLogFacts(logText) {
  return {
    engine: /\[server\] engine=(\S+)/.exec(logText)?.[1] ?? null,
    model: /\[server\] engine=\S+ model=(\S+)/.exec(logText)?.[1] ?? null,
    storage: /\[server\] storage=(.*)$/m.exec(logText)?.[1]?.trim() ?? null,
    listening: /\[server\] listening on (\S+)/.exec(logText)?.[1] ?? null,
  };
}

export function buildOutputs() {
  return BUILD_OUTPUTS.map((rel) => {
    const file = path.join(REPO_ROOT, rel);
    return { file: rel, exists: existsSync(file), mtime: existsSync(file) ? statSync(file).mtime.toISOString() : null };
  });
}
