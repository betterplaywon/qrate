/* global process */
// 훅 공용 헬퍼. 훅은 세션을 막지 않도록 모든 실패를 삼킨다(가드 훅의 '차단'만 예외).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

export function run(cmd, args, { cwd, timeout = 15_000 } = {}) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim();
  } catch {
    return null;
  }
}

export const git = (args, cwd) => run('git', args, { cwd });

export function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

export function notify(title, subtitle, body) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  run('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" subtitle "${esc(subtitle)}"`], {
    timeout: 5_000,
  });
}
