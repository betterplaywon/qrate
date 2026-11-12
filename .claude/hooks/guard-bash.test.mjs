/* global process */
// 금칙어 목록은 커밋되지 않는 로컬 파일이라, git 레포가 아닌 임시 폴더에 시험용 목록을 두고 그 폴더를 훅 입력의 cwd로 넘긴다.
// 레포가 아니면 커밋 전 게이트(pnpm lint·typecheck)도 돌지 않아 판정만 빠르게 본다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const WORD = '시험용비공개단어';
const project = mkdtempSync(path.join(tmpdir(), 'guard-bash-'));
mkdirSync(path.join(project, '.claude', 'hooks'), { recursive: true });
writeFileSync(path.join(project, '.claude', 'hooks', 'forbidden-words.local.txt'), `# 시험용\n${WORD}\n`);
after(() => rmSync(project, { recursive: true, force: true }));

function guard(command) {
  const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'guard-bash.mjs')], {
    input: JSON.stringify({ tool_input: { command }, cwd: project }),
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
