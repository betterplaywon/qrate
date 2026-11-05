# Qrate — 에이전트 작업 규칙

구현은 AI 에이전트가, 설계 결정·ADR·리뷰 책임은 사람이 맡는다(README 'AI 워크플로우'). 이 파일은 에이전트가 매 세션 지키는 규칙이다. 강제 장치가 있는 규칙은 맨 아래 표에 있고, 나머지는 이 문서만 믿는다.

## 시작

- 비자명한 작업은 `/pstack:poteto-mode`로 시작한다(플러그인 pstack, `.claude/settings.json`). 세션당 한 번 플러그인의 Claude Code 어댑터(`docs/harness/claude-code.md`)를 읽는다.
- 이 레포에서의 이름 매핑: `/deslop` → `/simplify`. `control-ui`·`control-cli` → `verify-qrate` 스킬(`.claude/skills/verify-qrate`, 실제 앱을 띄워 증거를 남긴다). Bugbot 없음 → 머지 전 `interrogate`(또는 `/code-review`)가 그 자리. Cursor `/loop` → Claude Code `/loop`. cloud agent → `isolation: "worktree"`.
- 답변·보고·PR 본문·커밋 메시지·결정 기록은 한국어로 쓴다. 코드 식별자·명령·경로는 그대로 둔다.
- 모델 계열이 Claude 하나뿐이라 "다른 계열의 검토"는 다른 모델(세션 모델 ↔ opus)로 대신한다(`~/.claude/rules/pstack-models.md`).

## 게이트(CI verify와 같다)

`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e`. 서버 테스트는 `QRATE_TEST_DATABASE_URL`이 있으면 Postgres(`docker compose up -d db`)에도 돈다. E2E는 빌드 산출물로 목업 엔진·메모리 저장소를 띄운다(8787·5173·5174·8788이 비어 있어야 한다). 실제 모델 호출(`ANTHROPIC_API_KEY`)은 비용이 드니 사용자가 횟수를 정한 뒤에만 한다.

## 브랜치·커밋·PR

- 브랜치 `<type>/<짧은-설명>`, 커밋 `type(scope): 제목`(scope는 모듈), PR 제목 `<대단위> - <소규모>`. 어휘와 예시는 `.github/pull_request_template.md` 머리말.
- main에 직접 커밋·push하지 않는다. push한 이력은 다시 쓰지 않는다(강제 push 금지). main이 앞서면 `git merge origin/main`으로 따라잡는다.
- 머지는 merge commit(`gh pr merge <번호> --merge`). 머지된 원격 브랜치는 GitHub이 지운다.
- PR 본문은 템플릿 5항목을 그대로 쓴다. pstack의 Why / What changed / Scope / Blast Radius / Verification은 각각 1 배경 / 2 변경 내용 / 범위 밖 / 5 리뷰어가 볼 것 / 4 검증에 넣는다. 수치는 실측만 쓰고 추정·시뮬레이션은 그렇게 표기한다.
- 같은 폴더에서 브랜치를 바꿔 작업한다(미커밋 변경은 이름 붙여 stash). 코드를 쓰는 서브에이전트를 둘 이상 동시에 돌릴 때만 worktree를 쓰고, 끝나면 지운다.
- 커밋은 변경 이유 단위로 나누고, 각 커밋이 혼자 게이트를 통과하게 한다. PR은 draft가 아니라 ready로 연다.

## 자율 범위

**묻지 않고 한다.** 이미 내려진 설계 결정 안의 구현, 버그 수정, 리팩토링, 테스트, 문서 뼈대, 도구·CI 수정, 커밋·push·PR 생성, 리뷰 코멘트 처리, CI 재실행, 아래 조건을 만족하는 머지.

**머지 조건.** CI verify 녹색 + 코드를 쓰지 않은 에이전트(다른 모델)가 실제 표면에서 검증해 PASS + 사람이 머지하는 경로를 건드리지 않음. 사람이 머지하는 경로(결제·크레딧, 콘솔 인증, 모더레이션, Origin 검사·CSP, 요율 제한, 스키마·마이그레이션, Docker·compose, CI, 에이전트 장치 자체)를 건드린 PR은 merge-ready로 보고하고 멈춘다(훅이 막는다).

**멈추고 사용자에게.** 아직 내려지지 않은 아키텍처·제품 결정(묻기 전에 개념과 옵션별 트레이드오프 설명 자료부터), 결제·인증·보안·되돌리기 어려운 변경, GitHub 설정, 비밀값·키, 데이터·브랜치 삭제, 배포, 외부 발행(블로그 등), 비용이 드는 외부 호출. 되돌릴 수 있는 일은 묻지 말고 하고, 결과를 보고한다.

**사람 몫 문서.** ADR의 결정·트레이드오프 본문, 면접 질문의 답, 블로그 본문. 에이전트는 뼈대·대안 표·유도 질문까지만 쓴다.

## 보고

- 매 실행의 마지막 답변이 보고서다. 목표를 내 말로, 한 일, 검증 증거(명령과 출력, 스크린샷 경로), 선택과 이유, 열린 결정, 그리고 결정 기록을 다른 모델이 교차 검토한 Attention.
- 긴 실행·자율 실행은 `/pstack:show-me-your-work` 결정 기록을 `.audit/<작업>.tsv`에 남긴다. 증거는 `.audit/evidence/`. 사용자는 `/pstack:ketchup`으로 따라잡는다.
- 실행이 멈추면 Stop 훅이 알림을 띄우고 마지막 답변을 `.audit/reports/<날짜>.md`에 덧붙인다.
- AI 코드에서 실제로 발견한 문제만 `docs/reviews.md`에 적는다((AI) 표시). 없는 사례를 만들지 않는다.

## 코드 규칙

- 선언은 쓰는 자리보다 위에 둔다(eslint no-use-before-define). 서로 참조하는 함수는 모듈 헬퍼나 클래스 메서드로 만든다.
- 외부 입력은 경계에서 zod로 파싱하고 내부는 타입을 믿는다. 콘솔은 react-hook-form·ky·react-query를 쓰고 데이터용 useEffect는 쓰지 않는다.
- 마이그레이션은 `prisma migrate dev`로 파일을 레포에 남긴다. `db push` 금지. 브랜치 안의 자잘한 마이그레이션은 머지 전 하나로 합친다.
- 공개 계약(API 응답·SSE 이벤트·요청 형식·환경변수·스키마) 변경은 PR 본문에 따로 표시한다.
- 주석은 코드가 보여 주지 못하는 '왜'만 남긴다.

## 규칙과 강제 장치

| 규칙 | 장치 |
| --- | --- |
| main 보호: PR 필수, verify 체크(strict), 관리자 포함, 강제 push·삭제 금지 | GitHub 브랜치 보호 |
| 강제 push, main push·커밋, 원격·강제 브랜치 삭제, stash 삭제 금지 | `.claude/hooks/guard-bash.mjs` |
| 작업 트리 전체 되돌리기(`reset --hard`, `checkout .`, `clean -f`) 금지 | 같은 훅 |
| 커밋 전 lint·typecheck 통과, 커밋 제목 `type(scope): …` | 같은 훅 |
| 사람이 머지하는 경로 PR, `--admin`, squash·rebase 머지, 체크 미통과 머지 금지 | 같은 훅 |
| 레포 설정·비밀·워크플로우·릴리스 변경 금지(`gh api`·`gh repo`·`gh secret`) | 같은 훅 |
| `.env`·비밀값 읽기·출력 금지 | 같은 훅 + `permissions.deny` |
| DB 리셋·`db push`·볼륨 삭제·외부 발행·이름으로 kill 금지 | 같은 훅 |
| PR 제목 형식, 공개 파일 금칙어 | 같은 훅(목록은 로컬 파일) |
| 테스트·빌드·E2E | CI verify(필수 체크) |
| 보고 파일·알림·세션 시작 요약 | `.claude/hooks/on-stop.mjs`, `on-notify.mjs`, `session-start.mjs` |
| 언어, PR 본문 구성, 자율 범위, 사람 몫 문서, 코드 규칙 | 이 문서만 |
