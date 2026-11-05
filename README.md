# Qrate — 임베더블 AI 상담 위젯 SDK

소규모 SaaS·커머스 사이트에 **스크립트 한 줄**로 설치하는 AI 상담 위젯과
운영자용 웹 콘솔. 채널톡·인터콤이 검증한 문제를, 위젯 SDK(Shadow DOM 격리) +
SSE 스트리밍 + 크레딧 과금(멱등) + 품질 평가셋 관점에서 처음부터 다시 구현한다.

```html
<!-- 고객 사이트에 들어가는 전부 -->
<script src="https://cdn.example.com/widget.js" data-tenant="KEY" defer></script>
```

## 왜 이걸 만들었나 (문제 근거)

가설: 1~10인 팀의 고객 문의 중 절반 이상은 FAQ·문서로 답할 수 있는 반복 질문이고,
그 응대가 창업자·개발자의 시간을 잠식한다.

공개 근거 (2026-11-01 조사 — 해외 설문이며 국내 수치가 아니다):

- 북미 고객서비스 리더 설문(2018)에서 응답자의 80%가 "팀 티켓의 20% 이상이 반복적이지만 쉽게 해결되는 문의"라고 답했다
  — DigitalGenius·Canam Research 조사, [DestinationCRM 보도](https://www.destinationcrm.com/Articles/CRM-Insights/CRM-Blog/Repetitive-Tickets-Are-Prevalent-in-Customer-Service-Survey-Finds-127256.aspx)
- 소규모 팀의 응대 시간 부담(H2)을 수치로 밝힌 최근 공개 자료는 찾지 못했다 → **미니 인터뷰로 확인한다**.
- "티켓의 40~60%가 반복 문의" 류의 수치는 벤더 블로그 인용만 확인되어 **원 출처 미확인 → 인용하지 않는다**.
- 반복 문의 비율을 직접 밝힌 **국내 자료는 찾지 못했다 → 가설로 유지**.

운영자 미니 인터뷰: [W1 내 2~3명, 익명 인용 2~3줄로 채움 — 확인되지 않으면 그 사실을 그대로 쓴다]

## 누구를 위한 것인가 (타깃)

- **구매자(운영자)** — "희영": 2인 B2B SaaS 공동창업자, 개발 담당. 주당 약 30건의 문의를 이메일·슬랙·무료 상담툴로 받고,
  절반은 이미 문서에 있는 내용. 원하는 것은 설치 5분, 오답 시 책임질 수 있는 구조(출처 표시·사람 연결), 쓴 만큼 내는 과금.
- **사용자(최종 고객)** — 희영의 사이트 방문자. 즉답을 기대하고, 틀린 답보다 "사람에게 연결해 달라"를 원한다.
  그래서 핸드오프 버튼을 항상 노출하는 것이 요구사항이다. 누르면 연락처(이메일)와 남길 말을 받아 운영 콘솔의 미응답 큐에 접수되고,
  운영자가 밖(이메일)에서 답한 뒤 상태를 옮긴다. 모델이 "자료에 없는 질문"이라고 신호한 턴도 같은 큐에 들어간다.
- **비(非)타깃** — CS 팀이 있는 중견기업 이상(권한·SLA 등 엔터프라이즈 기능 불필요), 전화 상담 중심 업종. 범위를 지키는 근거다.

## 구조

```
apps/server         Express 5 + TS — 대화 API(SSE 스트리밍)·입력 모더레이션·답변 엔진·저장소(메모리 | Prisma·PostgreSQL, 마이그레이션은 prisma/migrations)
apps/console        React + Vite — 운영 콘솔(로그인 · 대화 로그 · 미응답 큐). 빌드 산출물은 서버가 /console/ 로 서빙
packages/widget     임베더블 SDK — 런처(IIFE, Shadow DOM) + 대화창 앱(서버 오리진 iframe, postMessage) + 브라우저 E2E(e2e/)
packages/contracts  서버·위젯이 함께 쓰는 대화 API 계약 — SSE 이벤트 encode/parse, 요청·오류 본문
scripts/blog        티스토리 발행 파이프라인 (Playwright)
docs/adr            아키텍처 결정 기록 (직접 작성)
docs/interview      주차별 면접 질문 뱅크
docs/reviews.md     AI 코드 리뷰에서 실제 발견한 문제 기록
```

## 진행 상황

- [x] W1 기반: 모노레포(pnpm workspace) · CI 게이트(GitHub Actions) · Sentry · Docker · SSE 목업 스트리밍 · 입력 모더레이션(3단계) + 테스트
- [x] W2 답변 엔진(Claude 스트리밍 · 서버 측 폴백 · 목업 교체) · 지식(FAQ) 전량 주입 + 인용 · 핸드오프 신호(도구 호출) · 테넌트 검증(Origin 검사 · frame-ancestors) · 위젯 iframe 분리(postMessage · 출처 UI) · 브라우저 E2E · Docker 이미지 정리
- [x] W3 저장소(PostgreSQL · Prisma 마이그레이션 · 메모리·DB 공통 계약 테스트) · 운영 콘솔(테넌트 키 로그인 · 대화 로그 · 미응답 큐) · 상담원 연결 접수(위젯 → 큐)
- [ ] W4 크레딧 결제(멱등) · 이벤트 로그 · 간단 A/B — 진행 중: 크레딧 원장(턴당 1 차감 · 0이면 402 · 테넌트 범위 멱등 키) · 콘솔 크레딧 화면
- [ ] W5 응답 품질 평가셋(30케이스) · 실패 사례 기록
- [ ] W6 k6 부하 테스트(시뮬레이션 기준 명시) · 문서화

성능·해결률 수치는 **실측만** 기재하며, 시뮬레이션 수치는 그렇게 표기한다.

## 실행

```bash
pnpm install                          # 서버 postinstall이 Prisma 클라이언트를 생성한다(apps/server/src/generated, git 제외)
cp apps/server/.env.example apps/server/.env   # ANTHROPIC_API_KEY를 넣으면 실제 모델, 비우면 목업 엔진
docker compose up -d db               # PostgreSQL. DATABASE_URL을 비우면 DB 없이 메모리 저장소(시드 파일)로 돈다
pnpm --filter @qrate/server db:migrate   # 마이그레이션 적용(스키마를 바꿨으면 파일 생성까지). 처음 한 번 db:seed로 데모 테넌트·FAQ 투입
pnpm dev                              # API 서버 http://localhost:8787 (대화창 iframe 문서·자산도 여기서 나간다)
pnpm --filter @qrate/widget build     # 런처 widget.js + 대화창 앱 dist/frame/app.js·app.css
pnpm --filter @qrate/widget demo      # 데모 http://localhost:5173/demo.html — 허용 사이트 오리진에서 서빙 (file://는 막힌다)
pnpm --filter @qrate/console dev      # 운영 콘솔 개발 서버 http://localhost:5175/console/ (API는 8787로 프록시)
                                      # 빌드된 콘솔은 서버가 http://localhost:8787/console/ 로 서빙. 로그인 = 테넌트 키 demo + .env의 QRATE_DEMO_CONSOLE_KEY

pnpm lint && pnpm typecheck && pnpm test && pnpm build   # CI 게이트와 동일 (아래 e2e까지). 저장소 계약 테스트는 메모리 구현에 돌고,
                                      # .env에 QRATE_TEST_DATABASE_URL(전용 DB qrate_test, 마이그레이션 적용 후)을 두면 Postgres 구현에도 돈다
pnpm e2e                              # 브라우저 E2E(Playwright) — 빌드 산출물로 목업 서버·데모를 띄워 런처·대화창·postMessage·CSP, 콘솔 로그인·큐 확인
                                      # 처음 한 번: pnpm --filter @qrate/widget exec playwright install chromium. 8787·5173이 비어 있어야 한다
docker compose up --build             # Postgres → 마이그레이션·시드(migrate) → 서버 (Docker)
```

## AI 워크플로우 (작업 방식)

구현은 AI 에이전트가, **설계·리뷰·설명 책임은 사람이** 맡는다.

- 아키텍처 결정은 [docs/adr](docs/adr)에 직접 작성 — 결정·대안·트레이드오프
- PR 이름은 주차가 아니라 작업으로 — PR 제목 `<대단위> - <소규모>`, 브랜치는 `<type>/<짧은-설명>`(예: `feat/widget-iframe-split`). 어휘·예시는 [PR 템플릿](.github/pull_request_template.md) 머리말
- 머지는 CI 게이트(typecheck·lint·test·build·브라우저 e2e) 통과 시에만 — [ci.yml](.github/workflows/ci.yml)
- 결제·인증·SSE·모더레이션 코드는 줄 단위로 읽는다 — [PR 템플릿](.github/pull_request_template.md)
- AI 생성 코드에서 실제 발견한 문제만 [docs/reviews.md](docs/reviews.md)에 기록
- 주 1회: [면접 질문 뱅크](docs/interview)에 코드 안 보고 답하기 → 블로그로 발행(`pnpm blog:new`)
- 에이전트 규칙은 [CLAUDE.md](CLAUDE.md) — [pstack](https://github.com/michael-denyer/pstack-claude)(Claude Code 포트, 원작은 [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack)) 플레이북으로 일하고, 커밋·push·PR·머지는 장치(가드 훅·CI·코드를 쓰지 않은 에이전트의 검증)를 지나면 자동. 결제·인증·모더레이션·마이그레이션·CI·장치 자체는 사람이 머지
