#!/usr/bin/env node
/* global console */
// 검증용 인스턴스를 띄운다 — 목업 엔진·메모리 저장소 서버(8787), 데모 페이지(5173), 허용 목록 밖 데모(5174).
// 사용: node .claude/skills/verify/scripts/launch.mjs <feature>
// 증거 폴더 .audit/evidence/<YYYYMMDD-HHMM>-<feature>/ 를 만들고 run.json(PID·포트)과 각 프로세스의 로그를 거기 둔다.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  BUILD_OUTPUTS,
  DEMO_ORIGIN,
  NOT_ALLOWED_DEMO_ORIGIN,
  PROCESSES,
  REPO_ROOT,
  SERVER_ORIGIN,
  WATCHED_PORTS,
  buildOutputs,
  createRunDir,
  gitHead,
  http,
  listFeatures,
  lsofText,
  relative,
  serverLogFacts,
  stopProcess,
  tail,
  waitFor,
  writeRun,
} from './lib.mjs';

const READY_TIMEOUT_MS = 20_000;

function fail(message) {
  console.error(`LAUNCH FAIL: ${message}`);
  process.exit(1);
}

function start(proc, runDir) {
  const fd = openSync(path.join(runDir, proc.log), 'a');
  const child = spawn(process.execPath, [path.join(REPO_ROOT, proc.script)], {
    cwd: REPO_ROOT,
    // 셸 환경을 물려주지 않는다 — ANTHROPIC_API_KEY·DATABASE_URL·SENTRY_DSN이 셸에 있어도 서버에 닿지 않게.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...proc.env },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  child.unref();
  return { name: proc.name, pid: child.pid, port: proc.port, script: proc.script, log: proc.log };
}

async function expectStatus(url, status, label) {
  return waitFor(async () => (await http(url)).status === status, { timeoutMs: READY_TIMEOUT_MS, label });
}

/** 준비 = 프로세스가 답하는 것이 아니라 쓸 수 있는 것: 시드가 올라갔고(frame 200·CSP), 자산이 있고(app.js·console), 데모가 뜬다. */
async function waitUntilUsable(runDir) {
  const health = await waitFor(
    async () => {
      const r = await http(`${SERVER_ORIGIN}/healthz`);
      return r.status === 200 ? r.json() : null;
    },
    { timeoutMs: READY_TIMEOUT_MS, label: 'GET /healthz 200' },
  );
  if (health?.engine !== 'mock' || health?.model !== 'mock') {
    throw new Error(`healthz engine=${health?.engine} model=${health?.model} — 목업이 아니다. 이 인스턴스는 드라이브하지 않는다`);
  }
  const frame = await waitFor(
    async () => {
      const r = await http(`${SERVER_ORIGIN}/frame?t=demo&o=${encodeURIComponent(DEMO_ORIGIN)}`);
      return r.status === 200 ? r : null;
    },
    { timeoutMs: READY_TIMEOUT_MS, label: 'GET /frame?t=demo&o=5173 200' },
  );
  if (!frame.headers['content-security-policy']?.includes(`frame-ancestors ${DEMO_ORIGIN}`)) {
    throw new Error(`/frame CSP에 frame-ancestors ${DEMO_ORIGIN}가 없다: ${frame.headers['content-security-policy']}`);
  }
  await expectStatus(`${SERVER_ORIGIN}/frame/app.js`, 200, 'GET /frame/app.js 200 (위젯 dist/frame)');
  await expectStatus(`${SERVER_ORIGIN}/console/`, 200, 'GET /console/ 200 (콘솔 dist)');
  await expectStatus(`${DEMO_ORIGIN}/demo.html`, 200, 'GET 5173/demo.html 200');
  await expectStatus(`${DEMO_ORIGIN}/dist/widget.js`, 200, 'GET 5173/dist/widget.js 200 (위젯 dist)');
  await expectStatus(`${NOT_ALLOWED_DEMO_ORIGIN}/demo.html`, 200, 'GET 5174/demo.html 200');
  const facts = await waitFor(
    () => {
      const f = serverLogFacts(readFileSync(path.join(runDir, 'server.log'), 'utf8'));
      return f.engine && f.storage ? f : null;
    },
    { timeoutMs: READY_TIMEOUT_MS, label: 'server.log의 engine·storage 줄' },
  );
  if (facts.engine !== 'mock' || !facts.storage.startsWith('memory seed tenant=demo') || !facts.storage.includes('console=on')) {
    throw new Error(`server.log가 기대와 다르다: engine=${facts.engine} storage=${facts.storage}`);
  }
  return facts;
}

async function main() {
  const feature = process.argv[2];
  const features = listFeatures();
  if (!feature || !features.includes(feature)) {
    console.error(`사용: node .claude/skills/verify/scripts/launch.mjs <feature>\nfeature: ${features.join(' | ')}`);
    process.exit(2);
  }

  const missing = buildOutputs().filter((b) => !b.exists);
  if (missing.length > 0) fail(`빌드 산출물이 없다: ${missing.map((b) => b.file).join(', ')} — 루트에서 \`pnpm build\` 먼저`);

  const busy = WATCHED_PORTS.map((port) => ({ port, text: lsofText(port) })).filter((p) => p.text);
  if (busy.length > 0) {
    fail(`포트가 비어 있지 않다(pnpm dev나 pnpm e2e가 떠 있나?). 이 스킬은 남의 인스턴스를 쓰지 않는다.\n${busy.map((p) => `--- ${p.port}\n${p.text}`).join('\n')}`);
  }

  const runDir = createRunDir(feature);
  const run = {
    skill: 'verify',
    feature,
    status: 'starting',
    startedAt: new Date().toISOString(),
    node: process.version,
    git: gitHead(),
    repoRoot: REPO_ROOT,
    origins: { server: SERVER_ORIGIN, demo: DEMO_ORIGIN, notAllowedDemo: NOT_ALLOWED_DEMO_ORIGIN },
    build: Object.fromEntries(buildOutputs().map((b) => [b.file, b.mtime])),
    processes: [],
  };
  writeRun(runDir, run);

  console.log(`run: ${relative(runDir)}`);
  for (const proc of PROCESSES) {
    const started = start(proc, runDir);
    run.processes.push(started);
    writeRun(runDir, run);
    console.log(`started ${started.name}: pid=${started.pid} port=${started.port} node ${started.script} → ${started.log}`);
  }

  try {
    const facts = await waitUntilUsable(runDir);
    run.status = 'running';
    run.readyAt = new Date().toISOString();
    run.server = facts;
    writeRun(runDir, run);
    console.log(`server: engine=${facts.engine} model=${facts.model} storage=${facts.storage}`);
    console.log(`LAUNCH OK — 다음: node .claude/skills/verify/scripts/doctor.mjs`);
  } catch (err) {
    console.error(`준비 실패: ${err.message}`);
    for (const proc of run.processes) console.error(`--- ${proc.log} (tail)\n${tail(path.join(runDir, proc.log))}`);
    for (const proc of run.processes) console.error(`stop ${proc.name} pid=${proc.pid}: ${await stopProcess(proc)}`);
    run.status = 'failed';
    run.error = err.message;
    writeRun(runDir, run);
    fail(`인스턴스를 내렸다. 로그는 ${relative(runDir)}/ 에 남아 있다 (산출물 목록: ${BUILD_OUTPUTS.join(', ')})`);
  }
}

await main();
