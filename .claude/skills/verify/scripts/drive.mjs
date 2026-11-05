#!/usr/bin/env node
/* global console */
// 기능 하나를 방문자·운영자 경로 그대로 드라이브하고 증거를 남긴다.
// 사용: node .claude/skills/verify/scripts/drive.mjs [--run <dir>] [--feature <id>] [--headed]
// 기본은 run.json의 feature. 다른 feature를 주면 같은 실행 폴더의 <feature>/ 하위에 증거를 둔다.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createHarness } from './harness.mjs';
import { JOURNEYS_DIR, SERVER_ORIGIN, argValue, http, listFeatures, relative, resolveRun } from './lib.mjs';

function die(message) {
  console.error(`DRIVE FAIL: ${message}`);
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const resolved = resolveRun(args);
  if (!resolved) die('status=running인 실행이 없다. launch.mjs <feature> → doctor.mjs 먼저');
  const { dir, run } = resolved;
  if (run.status !== 'running') die(`run status=${run.status} (${relative(dir)})`);
  const feature = argValue(args, '--feature') ?? run.feature;
  const features = listFeatures();
  if (!features.includes(feature)) die(`모르는 feature "${feature}". 가능: ${features.join(' | ')}`);

  // 남의 인스턴스(pnpm dev, 실제 모델일 수 있음)는 절대 드라이브하지 않는다.
  const health = (await http(`${SERVER_ORIGIN}/healthz`).catch(() => null))?.json();
  if (health?.engine !== 'mock') die(`8787의 엔진이 mock이 아니거나 서버가 없다(engine=${health?.engine}). doctor.mjs로 확인`);

  const evidenceDir = feature === run.feature ? dir : path.join(dir, feature);
  mkdirSync(evidenceDir, { recursive: true });
  const journey = await import(pathToFileURL(path.join(JOURNEYS_DIR, `${feature}.mjs`)).href);
  const h = await createHarness({ evidenceDir, feature, title: journey.title, headed: args.includes('--headed') });
  const startedAt = new Date().toISOString();
  let ok = false;
  let error = null;
  try {
    await journey.run(h);
    ok = true;
  } catch (err) {
    error = err?.message ?? String(err);
  } finally {
    await h.finish();
  }
  const result = {
    feature,
    title: journey.title,
    ok,
    startedAt,
    finishedAt: new Date().toISOString(),
    run: relative(dir),
    error,
    steps: h.steps,
    chat: h.chat,
    files: [...h.evidence.files, 'result.json'].sort(),
  };
  writeFileSync(path.join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  h.evidence.append('steps.md', `\n---\n\n${ok ? 'PASS' : `FAIL — ${error}`} · 끝: ${result.finishedAt}\n`);

  console.log(`evidence: ${relative(evidenceDir)}/`);
  for (const f of result.files) console.log(`  ${f}`);
  if (ok) {
    console.log(`DRIVE PASS ${feature} — 다음: node .claude/skills/verify/scripts/cleanup.mjs`);
  } else {
    console.log(`DRIVE FAIL ${feature}: ${error}`);
    console.log(`트레이스: pnpm --filter @qrate/widget exec playwright show-trace ${path.join(relative(evidenceDir), 'trace.zip')}`);
  }
  process.exit(ok ? 0 : 1);
}

await main();
