/* global process */
// 금칙어 목록은 커밋되지 않는 로컬 파일이라, git 레포가 아닌 임시 폴더에 시험용 목록을 두고 그 폴더를 훅 입력의 cwd로 넘긴다.
// 레포가 아니거나 package.json 이름이 qrate가 아니면 커밋 전 게이트(pnpm lint·typecheck)가 돌지 않아 판정만 빠르게 본다.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const WORD = '시험용비공개단어';

function writeList(dir) {
  mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
  writeFileSync(path.join(dir, '.claude', 'hooks', 'forbidden-words.local.txt'), `# 시험용\n${WORD}\n`);
}

const project = mkdtempSync(path.join(tmpdir(), 'guard-bash-'));
writeList(project);
after(() => rmSync(project, { recursive: true, force: true }));

function guard(command, cwd = project) {
  const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'guard-bash.mjs')], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8',
  });
  if (run.status === 0) return 'allow';
  assert.equal(run.status, 2, run.stderr);
  if (run.stderr.includes('커밋 제목 형식 위반')) return 'subject';
  if (run.stderr.includes('금칙어')) return 'forbidden';
  return run.stderr;
}

const heredoc = (message, head = "<<'EOF'") => `git commit -m "$(cat ${head}\n${message}\nEOF\n)"`;

test('heredoc 메시지의 제목 형식과 금칙어를 검사한다', () => {
  assert.equal(guard(heredoc('fix(hooks): 제목\n\n본문')), 'allow');
  assert.equal(guard(heredoc('형식 없는 제목\n\n본문')), 'subject');
  assert.equal(guard(heredoc(`fix(hooks): 제목\n\n본문 ${WORD}`)), 'forbidden');
});

test('heredoc 본문이나 제목의 큰따옴표에서 메시지를 자르지 않는다', () => {
  assert.equal(guard(heredoc(`fix(hooks): 제목\n\n앞 "인용" 뒤 ${WORD}`)), 'forbidden');
  assert.equal(guard(heredoc('fix(hooks): "인용" 제목\n\n본문')), 'allow');
});

test('heredoc 구분자를 따옴표 없이 써도, 큰따옴표로 감싸도 같은 메시지를 읽는다', () => {
  for (const head of ['<<EOF', '<<"EOF"']) {
    assert.equal(guard(heredoc(`fix(hooks): 제목\n\n앞 "인용" 뒤 ${WORD}`, head)), 'forbidden', head);
    assert.equal(guard(heredoc('형식 없는 제목', head)), 'subject', head);
  }
});

test('heredoc 메시지는 구분자와 똑같은 줄에서만 끝난다', () => {
  assert.equal(guard(heredoc(`fix(hooks): 제목\n\nEOF로 시작하는 줄 ${WORD}`)), 'forbidden');
});

test('-m 따옴표 문자열과 --message=의 제목 형식과 금칙어를 검사한다', () => {
  assert.equal(guard('git commit -m "fix(hooks): 제목"'), 'allow');
  assert.equal(guard("git commit -m 'fix(hooks): 제목'"), 'allow');
  assert.equal(guard('git commit -m "fix(hooks): \\"인용\\" 제목"'), 'allow');
  assert.equal(guard('git commit -m "형식 없는 제목"'), 'subject');
  assert.equal(guard(`git commit -m 'fix(hooks): ${WORD}'`), 'forbidden');
  assert.equal(guard(`git commit --message="fix(hooks): ${WORD}"`), 'forbidden');
});

test('worktree에서도 주 저장소에 둔 목록으로 금칙어를 막는다', (t) => {
  // worktree를 주 저장소 밖에 둬서, 상위 폴더를 거슬러 목록을 찾는 방식으로는 통과하지 못하게 한다.
  const root = mkdtempSync(path.join(tmpdir(), 'guard-bash-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'worktree');
  writeList(main);
  // 사용자 전역 git 설정(커밋 서명·훅)이 시험 저장소에 끼어들지 않게 하고, 브랜치를 main이 아닌 이름으로 둔다.
  // main이면 가드가 메시지를 읽기 전에 main 커밋 금지로 막는다.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: main, env, stdio: 'pipe' });
  git('init', '-b', 'trunk');
  git('-c', 'user.name=시험', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-b', 'agent', worktree);

  const message = heredoc(`fix(hooks): 제목\n\n본문 ${WORD}`);
  assert.equal(guard(message, main), 'forbidden', '주 저장소');
  assert.equal(guard(message, worktree), 'forbidden', 'worktree');
});
