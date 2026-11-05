#!/usr/bin/env node
/* global Buffer */
// Stop 훅. 실행이 끝나면 (1) macOS 알림을 띄우고 (2) 마지막 답변을 .audit/reports/<날짜>.md에 덧붙인다 — 사용자가 터미널을 보지 않아도 보고서가 쌓인다.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { git, notify, projectDir, readInput } from './_shared.mjs';

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function tailLines(file, maxBytes) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (length < size) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

// 트랜스크립트(JSONL)는 답변 블록마다 한 줄이라, 끝에서 거꾸로 올라가며 user 항목을 만나기 전까지의 assistant text 블록을 모은다.
function lastAssistantText(file) {
  if (!file) return null;
  const lines = tailLines(file, 4 * 1024 * 1024);
  const texts = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type === 'user') break;
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j -= 1) {
      if (content[j].type === 'text' && content[j].text?.trim()) texts.unshift(content[j].text);
    }
  }
  return texts.length ? texts.join('\n\n') : null;
}

try {
  const input = readInput();
  if (!input.stop_hook_active) {
    const project = projectDir(input);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], project) ?? '?';
    const text = lastAssistantText(input.transcript_path);
    const now = new Date();
    if (text) {
      const dir = path.join(project, '.audit', 'reports');
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, `${localDate(now)}.md`), `\n## ${localTime(now)} · ${branch}\n\n${text.trim()}\n`);
    }
    notify('Claude Code · qrate', `${branch} 작업이 멈췄습니다`, (text ?? '').replace(/\s+/g, ' ').slice(0, 120));
  }
} catch {
  // 훅은 세션을 막지 않는다.
}
