// 블로그 초안 생성기.
// 사용: pnpm blog:new "글 제목"
// 결과: docs/blog/drafts/YYYY-MM-DD-슬러그.md (frontmatter + 글 뼈대)

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const title = process.argv.slice(2).join(' ').trim();
if (!title) {
  console.error('사용법: pnpm blog:new "글 제목"');
  process.exit(1);
}

const date = new Date().toISOString().slice(0, 10);
const slug =
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';

const draftsDir = path.resolve(import.meta.dirname, '../../../docs/blog/drafts');
mkdirSync(draftsDir, { recursive: true });

const file = path.join(draftsDir, `${date}-${slug}.md`);
if (existsSync(file)) {
  console.error(`이미 존재합니다: ${file}`);
  process.exit(1);
}

const template = `---
title: "${title}"
date: ${date}
category: ""
tags: []
---

<!-- 글 뼈대 — "문제 → 결정 → 트레이드오프 → 배운 것" 구조를 유지한다.
     이력서의 강점 서사와 같은 구조라서, 블로그가 곧 면접 대비가 된다. -->

## 어떤 문제였나

## 어떻게 결정했나 (대안과 트레이드오프)

## 구현하며 배운 것

## 면접에서 받을 것 같은 질문과 내 답

`;

writeFileSync(file, template, 'utf8');
console.log(`초안 생성: ${file}`);
console.log(`발행: pnpm blog:publish ${path.relative(process.cwd(), file)}`);
