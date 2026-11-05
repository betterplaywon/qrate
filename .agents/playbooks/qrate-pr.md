---
extends: opening-a-pr, shipping
when: Use it whenever a PR is opened, updated, rebased, or landed in this repository.
---

# qrate PR 규칙

이 레포의 PR 제목·본문·머지 방식·브랜치 운영은 CLAUDE.md가 정한다. 이 파일은 그 규칙을 pstack 플레이북의 해당 단계에 끼워 넣는다. 앵커 검사는 `node ~/.claude/plugins/cache/pstack-claude/pstack/<버전>/skills/poteto-mode/scripts/check-playbooks.mjs`.

- **Replace** "Conventional Commits `type(scope): subject`, no trailing period": PR 제목은 `<대단위> - <소규모>`(한국어, 소규모가 여럿이면 ·로 잇는다). 어휘와 예시는 `.github/pull_request_template.md` 머리말. 커밋 제목은 그대로 Conventional Commits `type(scope): 제목`(scope는 모듈, 제목은 한국어).
- **Replace** "Use `##` headings, not bold lead-ins, in this order, and drop a section with nothing to say": PR 본문은 `.github/pull_request_template.md`의 5항목을 그대로 쓴다. `## Why`는 1 배경, `## What changed`는 2 변경 내용, `## Scope`는 '범위 밖', `## Tradeoffs`는 1 배경의 대안 문장, `## Blast Radius`는 5 리뷰어가 볼 것, `## Verification`은 4 검증에 넣는다. 체크박스는 비워 둔다(사용자가 확인한다). 본문은 파일로 써서 `--body-file`로 넘기고, 수치는 실측만 쓴다.
- **Replace** "Work from a git worktree off main.": 메인 세션은 같은 폴더에서 브랜치만 바꿔 일한다(미커밋 변경은 이름 붙여 stash). worktree는 코드를 쓰는 서브에이전트에게만 준다.
- **Replace** "gh pr merge <pr> --repo <owner/repo> --squash --match-head-commit <verified-head>": 이 레포는 merge commit만 허용한다. `gh pr merge <pr> --merge --match-head-commit <verified-head>`를 쓴다.
- **After** "Landing needs the user's landing authority": CLAUDE.md '자율 범위'가 그 권한이다. 사람 몫 경로(결제·크레딧, 콘솔 인증, 모더레이션, Origin 검사·CSP, 요율 제한, 스키마·마이그레이션, Docker, CI, 에이전트 장치)를 건드리지 않은 PR은 CI 녹색과 독립 검증 PASS가 있으면 에이전트가 착륙시킨다. 그 경로를 건드린 PR은 merge-ready로 보고하고 멈춘다(가드 훅이 머지를 막는다).
- **Replace** "replay only its own commits onto the merge result from the recorded old parent boundary": push된 이력은 다시 쓰지 않는다(가드 훅이 강제 push를 막는다). 자식 브랜치에 `git merge origin/main`을 하고 보통 push한다. patch-id 규칙 대신 새 head에서 검증을 다시 받는다.
