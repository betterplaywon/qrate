#!/usr/bin/env node
/* global console */
// 이 스킬이 띄운 프로세스를 내린다. 이름으로 죽이지 않는다 — run.json의 PID만, 명령줄이 우리 스크립트일 때만.
// 증거(.audit/evidence/**)는 지우지 않는다. run.json의 status만 stopped로 바꾼다.
// 사용: node .claude/skills/verify/scripts/cleanup.mjs [--run <dir>] [--all]
import { readdirSync } from 'node:fs';
import process from 'node:process';
import { WATCHED_PORTS, isOurs, listRuns, lsofText, relative, resolveRun, stopProcess, writeRun } from './lib.mjs';

async function stopRun({ dir, run }) {
  console.log(`run: ${relative(dir)} (status=${run.status})`);
  for (const proc of run.processes ?? []) {
    console.log(`stop ${proc.name} pid=${proc.pid} port=${proc.port}: ${await stopProcess(proc)}`);
  }
  run.status = 'stopped';
  run.stoppedAt = new Date().toISOString();
  writeRun(dir, run);
  console.log(`증거는 그대로: ${relative(dir)}/ (${readdirSync(dir).length}개 파일)`);
}

async function main() {
  const args = process.argv.slice(2);
  const targets = args.includes('--all')
    ? listRuns().filter(({ run }) => run.status === 'running' || (run.processes ?? []).some(isOurs))
    : [resolveRun(args)].filter(Boolean);
  if (targets.length === 0) console.log('내릴 실행이 없다 (status=running인 run.json 없음).');
  for (const target of targets) await stopRun(target);

  let leftover = false;
  for (const port of WATCHED_PORTS) {
    const text = lsofText(port);
    console.log(`port ${port}: ${text ? `\n${text}` : '비어 있음'}`);
    if (text && targets.some(({ run }) => (run.processes ?? []).some((p) => p.port === port && isOurs(p)))) leftover = true;
  }
  if (leftover) {
    console.error('CLEANUP FAIL: 우리가 띄운 프로세스가 아직 포트를 잡고 있다.');
    process.exit(1);
  }
  console.log('CLEANUP OK');
}

await main();
