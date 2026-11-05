#!/usr/bin/env node
/* global console */
// 읽기 전용 점검 — "이 인스턴스를 드라이브해도 되는가". 프로세스·포트 소유, 목업 엔진, 시드, 자산, 콘솔 키.
// 사용: node .claude/skills/verify/scripts/doctor.mjs [--run <dir>]
// 결과는 <run>/doctor.json 에도 남긴다. 종료 코드 0 = 드라이브해도 됨.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  CONSOLE_KEY,
  DEMO_ORIGIN,
  NOT_ALLOWED_DEMO_ORIGIN,
  SERVER_ORIGIN,
  TENANT,
  TENANT_NAME,
  buildOutputs,
  commandOf,
  http,
  isAlive,
  listeningPids,
  lsofText,
  relative,
  resolveRun,
  serverLogFacts,
} from './lib.mjs';

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}
function info(name, detail) {
  checks.push({ name, ok: true, detail, info: true });
  console.log(`[info] ${name} — ${detail}`);
}

async function probe(name, url, expected, init = {}) {
  try {
    const r = await http(url, init);
    const ok = expected(r);
    record(name, ok, `${r.status}${ok ? '' : ` body=${r.text.slice(0, 120)}`}`);
    return r;
  } catch (err) {
    record(name, false, err.message);
    return null;
  }
}

async function main() {
  const resolved = resolveRun(process.argv.slice(2));
  if (!resolved) {
    console.error('DOCTOR FAIL: status=running인 실행이 없다. 먼저 launch.mjs <feature>');
    process.exit(1);
  }
  const { dir, run } = resolved;
  console.log(`run: ${relative(dir)} feature=${run.feature} started=${run.startedAt}`);
  record('run.json status=running', run.status === 'running', run.status);

  for (const proc of run.processes ?? []) {
    const alive = isAlive(proc.pid);
    const cmd = alive ? commandOf(proc.pid) : null;
    record(`${proc.name} pid=${proc.pid} 살아 있고 명령줄이 ${proc.script}`, Boolean(cmd && cmd.includes(proc.script)), cmd ?? '죽어 있음');
    const pids = listeningPids(proc.port);
    record(`port ${proc.port}의 LISTEN 소유자가 그 PID`, pids.length === 1 && pids[0] === proc.pid, `lsof → ${pids.join(',') || '(없음)'}`);
  }
  const other = lsofText(8788);
  if (other) info('port 8788(콘솔 E2E용)에 다른 것이 떠 있다', other.split('\n').slice(-1)[0]);

  const health = await probe('GET /healthz', `${SERVER_ORIGIN}/healthz`, (r) => r.status === 200 && r.json()?.ok === true);
  const h = health?.json();
  record('엔진이 목업(engine=mock model=mock) — 실제 모델 호출 없음', h?.engine === 'mock' && h?.model === 'mock', `engine=${h?.engine} model=${h?.model}`);

  const facts = serverLogFacts(readFileSync(path.join(dir, 'server.log'), 'utf8'));
  record('server.log: 메모리 저장소 + 시드 테넌트 demo + 콘솔 키 적용', Boolean(facts.storage?.startsWith('memory seed tenant=demo') && facts.storage.includes('console=on')), facts.storage ?? '(storage 줄 없음)');

  await probe('GET /frame?t=demo&o=5173 → 200 + CSP', `${SERVER_ORIGIN}/frame?t=demo&o=${encodeURIComponent(DEMO_ORIGIN)}`, (r) => r.status === 200 && Boolean(r.headers['content-security-policy']?.includes(`frame-ancestors ${DEMO_ORIGIN}`)));
  await probe('GET /frame?t=demo&o=5174 → 403 (허용 목록이 시드 그대로)', `${SERVER_ORIGIN}/frame?t=demo&o=${encodeURIComponent(NOT_ALLOWED_DEMO_ORIGIN)}`, (r) => r.status === 403);
  await probe('GET /frame/app.js → 200 (위젯 dist/frame)', `${SERVER_ORIGIN}/frame/app.js`, (r) => r.status === 200);
  await probe('GET /console/ → 200 + CSP', `${SERVER_ORIGIN}/console/`, (r) => r.status === 200 && r.headers['content-security-policy'] === "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  await probe('GET 5173/demo.html → 200', `${DEMO_ORIGIN}/demo.html`, (r) => r.status === 200);
  await probe('GET 5173/dist/widget.js → 200 (위젯 dist)', `${DEMO_ORIGIN}/dist/widget.js`, (r) => r.status === 200);
  await probe('GET 5174/demo.html → 200', `${NOT_ALLOWED_DEMO_ORIGIN}/demo.html`, (r) => r.status === 200);

  // 로그인은 서명된 토큰을 돌려줄 뿐 저장소를 바꾸지 않는다. IP당 분당 10회 제한이 있으니 doctor를 연달아 돌리지는 않는다.
  await probe(
    `콘솔 키 유효(POST /api/console/login tenant=${TENANT}) → 200, 테넌트 ${TENANT_NAME}`,
    `${SERVER_ORIGIN}/api/console/login`,
    (r) => r.status === 200 && r.json()?.tenant?.name === TENANT_NAME,
    {
      method: 'POST',
      headers: { origin: SERVER_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ tenant: TENANT, key: CONSOLE_KEY }),
    },
  );

  for (const b of buildOutputs()) info(`빌드 산출물 ${b.file}`, b.exists ? `mtime ${b.mtime}` : '없음');
  info('git HEAD(launch 시점)', run.git ?? '(모름)');

  const ok = checks.every((c) => c.ok);
  writeFileSync(path.join(dir, 'doctor.json'), `${JSON.stringify({ at: new Date().toISOString(), ok, checks }, null, 2)}\n`);
  console.log(ok ? `DOCTOR OK — 다음: node .claude/skills/verify/scripts/drive.mjs` : 'DOCTOR FAIL — 위 FAIL 항목을 보고 cleanup.mjs 뒤 다시 launch');
  process.exit(ok ? 0 : 1);
}

await main();
