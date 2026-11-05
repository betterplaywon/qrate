#!/usr/bin/env node
/* global console */
// SessionStart 훅. 작업 상태 몇 줄(브랜치·미커밋·열린 PR·최근 보고서·결정 기록)을 컨텍스트에 넣는다 — 세션 인계가 빨라진다.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { git, projectDir, readInput, run } from './_shared.mjs';

const newest = (dir, ext) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(ext))
        .sort()
        .at(-1)
    : undefined;

const input = readInput();
const project = projectDir(input);
const lines = [];

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], project) ?? '?';
const dirty = (git(['status', '--short'], project) ?? '').split('\n').filter(Boolean).length;
lines.push(`[qrate] 브랜치 ${branch}, 미커밋 변경 ${dirty}개. 규칙은 CLAUDE.md, 비자명한 작업은 /pstack:poteto-mode로 시작.`);

const prs = run('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName', '--limit', '10'], { cwd: project, timeout: 8_000 });
if (prs) {
  try {
    const list = JSON.parse(prs);
    lines.push(list.length ? `열린 PR: ${list.map((p) => `#${p.number} ${p.title} (${p.headRefName})`).join(' · ')}` : '열린 PR 없음.');
  } catch {
    // gh 출력이 JSON이 아니면 건너뛴다.
  }
}

const report = newest(path.join(project, '.audit', 'reports'), '.md');
if (report) lines.push(`최근 보고서: .audit/reports/${report}`);
const trail = newest(path.join(project, '.audit'), '.tsv');
if (trail) lines.push(`결정 기록: .audit/${trail} (column -s$'\\t' -t 로 본다)`);

console.log(lines.join('\n'));
