#!/usr/bin/env node
/* global process */
// PreToolUse(Bash) 가드. 되돌리기 어렵거나 사람 몫인 명령을 막고, 막은 이유와 대안을 stderr로 돌려준다(종료 코드 2 = 차단).
// 입력(stdin JSON): { tool_input: { command }, cwd }. 어떤 규칙이 어디서 강제되는지는 CLAUDE.md '규칙과 강제 장치' 표.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { git, readInput, run } from './_shared.mjs';

const input = readInput();
const command = String(input.tool_input?.command ?? '');
const cwd = input.cwd || process.cwd();

function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else re += '[^/]*';
    } else if ('.+?^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`${re}$`);
}

// 사람이 머지하는 경로: 돈·인증·보안 경계·스키마·CI·에이전트 장치 자체.
const SENSITIVE = [
  'apps/server/src/http/console/**',
  'apps/server/src/console/**',
  'apps/server/src/chat/moderation.ts',
  'apps/server/src/origin.ts',
  'apps/server/src/http/frame.ts',
  'apps/server/src/http/rate-limit.ts',
  'apps/server/prisma/**',
  'apps/server/src/repo/**/credits*',
  'apps/server/src/**/payment*',
  'apps/server/src/**/billing*',
  'apps/server/src/**/webhook*',
  'apps/server/Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  '.github/**',
  '.claude/**',
  'CLAUDE.md',
].map(globToRegExp);

const COMMIT_SUBJECT = /^(feat|fix|docs|refactor|test|chore|perf|build|ci|style|revert)(\([a-z0-9,./-]+\))?!?: \S/;

// 명령 전체를 보고 막는 규칙. [정규식, 이유와 대안]
const WHOLE_COMMAND_RULES = [
  [/\bprisma\s+migrate\s+reset\b/, 'prisma migrate reset 금지(개발 DB 데이터가 지워진다). 사용자 몫.'],
  [/\bprisma\s+db\s+push\b/, 'db push 금지. 스키마 변경은 prisma migrate dev로 마이그레이션 파일을 만든다.'],
  [/\bdocker\s+compose\b[^|;&]*\bdown\b[^|;&]*(\s-v\b|--volumes)/, 'compose down -v 금지(DB 볼륨 삭제).'],
  [/\bdocker\s+(volume\s+(rm|prune)|system\s+prune)\b/, 'docker 볼륨·시스템 정리 금지.'],
  [/\b(dropdb|DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE)\b/i, 'DB 삭제·비우기 금지.'],
  [/\b(blog:publish|npm\s+publish|pnpm\s+publish)\b|scripts\/blog\S*[^|;&]*\s--go\b/, '외부 발행 금지(블로그·패키지). 사용자가 직접 한다.'],
  [/(^|[\s;&|])sudo\s/, 'sudo 금지.'],
  [/\b(killall|pkill)\b/, '이름으로 프로세스를 죽이지 않는다. 내가 띄운 PID만 kill한다.'],
  [/\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/, '원격 스크립트를 셸로 바로 실행하지 않는다.'],
  [/\bgit\s+config\s+--global\b/, 'git 전역 설정 변경 금지.'],
  [/\bgit\s+remote\s+(remove|rm|set-url|rename)\b/, '원격 설정 변경 금지.'],
  [/\bgit\s+stash\s+(drop|clear)\b/, 'stash 삭제 금지(사용자 작업일 수 있다). pop으로 복원한다.'],
  [/\bgit\s+branch\s+(-[a-zA-Z]*D\b|[^|;&]*--delete\s+--force)/, '브랜치 강제 삭제 금지. 머지된 브랜치만 -d로 지운다.'],
  [
    /\bgit\s+(reset\s+--hard\b|checkout\s+(--\s+)?\.(\s|$)|restore\s+(--\s+)?\.(\s|$)|clean\s+-[a-zA-Z]*[fd])/,
    '작업 트리 전체 되돌리기 금지. 사용자의 미커밋 편집(ADR 등)이 지워질 수 있다. 내가 바꾼 파일만 `git restore -- <파일>`로 되돌린다.',
  ],
  [
    /\bgh\s+(repo\s+(edit|delete|rename|archive|unarchive|sync|transfer)|secret\b|variable\s+set|workflow\s+(disable|delete|enable)|release\b|auth\b|ruleset\b|config\s+set)/,
    'GitHub 설정·비밀·릴리스·인증 변경 금지. 사용자 몫.',
  ],
  [/\bclaude\s+(plugin\s+(uninstall|disable|remove)|config)\b/, 'Claude Code 플러그인·설정 변경 금지.'],
  [/(^|[\s;&|])(printenv|env)(\s*$|\s*[;&|])/, '환경변수 전체 출력 금지(비밀값이 섞일 수 있다).'],
  [/\$\{?[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|DSN)\b/, '비밀값 환경변수를 출력·전달하지 않는다.'],
];

function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

function toplevel() {
  return git(['rev-parse', '--show-toplevel'], cwd);
}

function packageName(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
  } catch {
    return null;
  }
}

function ghJson(args) {
  const out = run('gh', args, { cwd, timeout: 30_000 });
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function forbiddenWords() {
  const file = path.join(toplevel() ?? cwd, '.claude', 'hooks', 'forbidden-words.local.txt');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function forbiddenIn(text) {
  const hit = forbiddenWords().find((w) => text.includes(w));
  return hit ? `공개 파일 금칙어 "${hit}"가 들어 있다. 문장을 바꾼다(목록: .claude/hooks/forbidden-words.local.txt).` : null;
}

function optionValue(seg, names) {
  for (const name of names) {
    const m = seg.match(new RegExp(`(?:^|\\s)${name.replace(/-/g, '\\-')}(?:=|\\s+)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|\\S+)`, 's'));
    if (m) return m[1].replace(/^(["'])(.*)\1$/s, '$2');
  }
  return null;
}

function prNumber(words) {
  for (const w of words.slice(3)) {
    const fromUrl = w.match(/\/pull\/(\d+)/);
    if (fromUrl) return Number(fromUrl[1]);
    if (/^\d+$/.test(w)) return Number(w);
  }
  return ghJson(['pr', 'view', '--json', 'number'])?.number ?? null;
}

function checkPassed(c) {
  if (c.conclusion) return /^(SUCCESS|NEUTRAL|SKIPPED)$/.test(c.conclusion);
  if (c.state) return c.state === 'SUCCESS';
  return false;
}

function commitMessage(seg) {
  const m = seg.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/s);
  if (!m) return null;
  let text = m[1].replace(/^(["'])(.*)\1$/s, '$2');
  // -m "$(cat <<'EOF' ... )" 형태는 첫 줄이 heredoc 머리이므로 그다음 줄이 제목이다.
  if (/^\$\(cat\s*<</.test(text)) text = text.split('\n').slice(1).join('\n');
  else if (text.startsWith('$(')) return null;
  return text;
}

function segments(cmd) {
  return cmd
    .split(/\s*(?:&&|\|\||;|\||\n)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokens(seg) {
  return (seg.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/s, '$2'));
}

function checkEnvFiles(seg, words) {
  if (['ls', 'test', '[', '[[', 'stat', 'file', 'basename', 'dirname', 'touch'].includes(words[0])) return null;
  const hit = words.find((w) => /(^|\/|=)\.env(\.[\w-]+)?$/.test(w) && !/\.env\.example$/.test(w));
  if (hit) return `.env 읽기·수정·실행 금지(${hit}). 비밀값은 사용자가 관리하고, 실제 키로 서버를 띄우는 일(실제 모델 호출)은 사용자가 횟수를 정한 뒤 직접 한다.`;
  return null;
}

function checkRm(words) {
  const recursive = words.some((w) => /^-[a-zA-Z]*[rR]/.test(w) || w === '--recursive');
  if (!recursive) return null;
  const home = process.env.HOME ?? '';
  const top = toplevel() ?? cwd;
  for (const raw of words.slice(1).filter((w) => !w.startsWith('-'))) {
    const target = raw.replace(/^~(?=\/|$)/, home).replace(/^\$HOME(?=\/|$)/, home);
    if (['/', '/*', '.', './', '..', '../', '*', '.git', '.git/', home, `${home}/`].includes(target)) return `rm -r 대상이 위험하다(${raw}).`;
    if (target.startsWith('..')) return `상위 폴더 삭제 금지(${raw}).`;
    if (/^(\.git|\.claude|docs|apps|packages|scripts)\/?$/.test(target)) return `${raw} 삭제 금지.`;
    if (target.startsWith('/')) {
      const abs = path.resolve(target);
      const inside = (root) => abs === root || abs.startsWith(`${root}/`);
      if (abs === top || (!inside(top) && !inside('/private/tmp') && !inside('/tmp'))) return `프로젝트·임시 폴더 밖 삭제 금지(${raw}).`;
    }
  }
  return null;
}

function checkPrText(seg, words) {
  const title = optionValue(seg, ['--title', '-t']);
  if (words[2] === 'create' && title !== null && !/^\S.* - \S/.test(title))
    return `PR 제목 형식 위반: "${title}". 형식은 <대단위> - <소규모>(한국어). 어휘는 .github/pull_request_template.md 머리말.`;
  let text = seg;
  const bodyFile = optionValue(seg, ['--body-file', '-F']);
  if (bodyFile) {
    try {
      text += `\n${readFileSync(path.resolve(cwd, bodyFile), 'utf8')}`;
    } catch {
      return `PR 본문 파일을 읽지 못했다: ${bodyFile}`;
    }
  }
  return forbiddenIn(text);
}

function checkGhApi(seg, words) {
  const explicit = seg.match(/(?:^|\s)(?:-X|--method)[=\s]+([A-Za-z]+)/)?.[1]?.toUpperCase();
  const hasBody = /(^|\s)(-f|-F|--field|--raw-field|--input)(\s|=)/.test(seg);
  const method = explicit ?? (hasBody ? 'POST' : 'GET');
  if (method === 'GET') return null;
  if (method !== 'POST') return `gh api ${method} 금지. 레포·설정 변경은 사용자 몫이다.`;
  // 엔드포인트는 '/'를 품은 첫 토큰(또는 graphql). 옵션 값(POST, key=value)은 건너뛴다.
  const endpoint = words.slice(2).find((w) => !w.startsWith('-') && (w.includes('/') || /^graphql$/i.test(w))) ?? '';
  if (/graphql/i.test(endpoint)) {
    return /\bmutation\b/i.test(seg) ? 'gh api graphql mutation 금지. 머지는 gh pr merge --merge, 설정은 사용자 몫.' : null;
  }
  if (/(merge|protection|rulesets|hooks|secrets|keys|collaborators|dispatches|releases|transfer)/i.test(endpoint))
    return 'gh api로 머지·보호 규칙·비밀·설정을 바꾸지 않는다. 머지는 gh pr merge --merge, 설정은 사용자 몫.';
  return forbiddenIn(seg);
}

function checkMerge(words) {
  if (words.includes('--admin')) return '--admin 머지 금지(보호 규칙 우회).';
  if (['--squash', '--rebase', '-s', '-r'].some((f) => words.includes(f))) return '이 레포는 merge commit만 쓴다: gh pr merge <번호> --merge';
  if (!words.includes('--merge') && !words.includes('-m')) return '머지 방식을 명시한다: gh pr merge <번호> --merge';
  const number = prNumber(words);
  if (!number) return 'PR 번호를 알 수 없다. gh pr merge <번호> --merge';
  const info = ghJson(['pr', 'view', String(number), '--json', 'files,isDraft,state,statusCheckRollup']);
  if (!info) return `PR #${number} 정보를 읽지 못했다.`;
  if (info.isDraft) return `PR #${number}는 draft다. gh pr ready 뒤에 머지한다.`;
  const hits = (info.files ?? []).map((f) => f.path).filter((p) => SENSITIVE.some((re) => re.test(p)));
  if (hits.length)
    return `PR #${number}는 사람이 머지하는 경로를 건드린다:\n${hits.map((h) => `  ${h}`).join('\n')}\nmerge-ready로 보고하고 멈춘다.`;
  const notGreen = (info.statusCheckRollup ?? []).filter((c) => !checkPassed(c));
  if (notGreen.length)
    return `PR #${number}의 체크가 녹색이 아니다: ${notGreen.map((c) => `${c.name ?? c.context}=${c.conclusion || c.state || c.status}`).join(', ')}. 녹색이 된 뒤 머지한다.`;
  return null;
}

// 커밋 전 게이트: lint·typecheck(둘 합쳐 몇 초). 테스트·빌드·E2E는 CI verify가 맡는다.
function runCommitGate() {
  const top = toplevel();
  if (!top || packageName(top) !== 'qrate') return null;
  for (const script of ['lint', 'typecheck']) {
    try {
      execFileSync('pnpm', [script], { cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
    } catch (e) {
      const tail = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
      return `커밋 전 게이트 실패: pnpm ${script}\n${tail}\n고친 뒤 다시 커밋한다.`;
    }
  }
  return null;
}

function checkCommit(words) {
  if (words.includes('--no-verify') || words.includes('-n')) return '--no-verify 금지.';
  if (currentBranch() === 'main') return 'main에 직접 커밋 금지. `git switch -c <type>/<짧은-설명>` 뒤에 커밋한다.';
  // 메시지는 heredoc으로 여러 줄일 수 있어 조각이 아니라 명령 전체에서 찾는다.
  const message = commitMessage(command);
  if (message) {
    const subject = message.split('\n')[0].trim();
    if (!COMMIT_SUBJECT.test(subject) && !/^(Merge|Revert) /.test(subject))
      return `커밋 제목 형식 위반: "${subject}". 형식은 type(scope): 제목 — scope는 모듈, 제목은 한국어. 예) feat(server): 턴당 1크레딧 차감`;
    const bad = forbiddenIn(message);
    if (bad) return bad;
  }
  return runCommitGate();
}

function checkPush(words) {
  const args = words.slice(words.indexOf('push') + 1);
  const flags = args.filter((a) => a.startsWith('-'));
  const positional = args.filter((a) => !a.startsWith('-'));
  if (flags.some((f) => /^--force(-with-lease|-if-includes)?(=|$)/.test(f) || /^-[a-zA-Z]*f/.test(f)))
    return '강제 push 금지. push한 이력은 다시 쓰지 않는다. main이 앞서면 `git merge origin/main`으로 따라잡고 고칠 것은 새 커밋으로 고친다.';
  if (flags.some((f) => f === '--delete' || /^-[a-zA-Z]*d/.test(f)) || positional.some((p) => /^:\S+/.test(p)))
    return '원격 브랜치 삭제 금지. 머지된 브랜치는 GitHub이 자동 삭제한다. 그 밖의 삭제는 사용자에게 맡긴다.';
  if (positional.some((p) => p.startsWith('+'))) return '`+refspec` 강제 push 금지.';
  const refs = positional.slice(1);
  const targetsMain = refs.some((r) => /(^|:)(refs\/heads\/)?main$/.test(r)) || (positional.length === 1 && positional[0] === 'main');
  if (targetsMain) return 'main에 직접 push 금지. 브랜치에 push하고 PR을 연다.';
  if (refs.length === 0 || refs.every((r) => r === 'HEAD')) {
    if (currentBranch() === 'main') return '지금 main에 있다. `git switch -c <type>/<짧은-설명>` 뒤에 push한다.';
  }
  const outgoing = git(['log', '--format=%B', 'origin/main..HEAD'], cwd);
  return outgoing ? forbiddenIn(outgoing) : null;
}

function checkSegment(seg, words) {
  const [first, second, third] = words;
  if (first === 'git') {
    const sub = words.slice(1).find((w) => !w.startsWith('-'));
    if (sub === 'push') return checkPush(words);
    if (sub === 'commit') return checkCommit(words);
    if (sub === 'tag') return forbiddenIn(seg);
    return null;
  }
  if (first === 'gh') {
    if (second === 'pr' && third === 'merge') return checkMerge(words);
    if (second === 'api') return checkGhApi(seg, words);
    if (second === 'pr' && ['create', 'edit', 'comment', 'review'].includes(third)) return checkPrText(seg, words);
    if (second === 'issue') return forbiddenIn(seg);
    return null;
  }
  if (first === 'rm') return checkRm(words);
  return null;
}

function check(cmd) {
  for (const [re, reason] of WHOLE_COMMAND_RULES) if (re.test(cmd)) return reason;
  for (const seg of segments(cmd)) {
    const words = tokens(seg);
    if (words.length === 0) continue;
    const reason = checkEnvFiles(seg, words) ?? checkSegment(seg, words);
    if (reason) return reason;
  }
  return null;
}

function main() {
  if (!command.trim()) return;
  const reason = check(command);
  if (reason) {
    process.stderr.write(`[guard] ${reason}\n`);
    process.exit(2);
  }
}

main();
