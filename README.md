# Qrate — 임베더블 AI 상담 위젯 SDK

소규모 SaaS·커머스 사이트에 **스크립트 한 줄**로 설치하는 AI 상담 위젯과
운영자용 웹 콘솔. 채널톡·인터콤이 검증한 문제를, 위젯 SDK(Shadow DOM 격리) +
SSE 스트리밍 + 크레딧 과금(멱등) + 품질 평가셋 관점에서 처음부터 다시 구현한다.

```html
<!-- 고객 사이트에 들어가는 전부 -->
<script src="https://cdn.example.com/widget.js" data-tenant="KEY" defer></script>
```

고객 사이트가 CSP를 쓰면 세 가지를 열어야 한다. `script-src`에 위젯 스크립트의 오리진, `frame-src`에 위젯 서버의 오리진(대화창 iframe), `style-src`에 `'unsafe-inline'`(런처가 Shadow DOM 안에 `<style>`을 넣는다). `default-src 'self'`만 있으면 런처 스타일과 대화창이 모두 막힌다.

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
apps/console        React + Vite — 운영 콘솔(로그인 · 대화 로그 · 미응답 큐 · 지표 · 크레딧·충전). 빌드 산출물은 서버가 /console/ 로 서빙
packages/widget     임베더블 SDK — 런처(IIFE, Shadow DOM) + 대화창 앱(서버 오리진 iframe, postMessage) + 브라우저 E2E(e2e/)
packages/contracts  서버·위젯이 함께 쓰는 대화 API 계약 — SSE 이벤트 encode/parse, 요청·오류 본문
scripts/blog        티스토리 발행 파이프라인 (Playwright)
docs/adr            아키텍처 결정 기록 (직접 작성)
docs/eval           응답 품질 평가 결과와 근거 기록(실측)
docs/load           부하 측정 결과와 근거 기록(목업 엔진 시뮬레이션)
docs/interview      주차별 면접 질문 뱅크
docs/reviews.md     AI 코드 리뷰에서 실제 발견한 문제 기록
```

## 진행 상황

- [x] W1 기반: 모노레포(pnpm workspace) · CI 게이트(GitHub Actions) · Sentry · Docker · SSE 목업 스트리밍 · 입력 모더레이션(3단계) + 테스트
- [x] W2 답변 엔진(Claude 스트리밍 · 서버 측 폴백 · 목업 교체) · 지식(FAQ) 전량 주입 + 인용 · 핸드오프 신호(도구 호출) · 테넌트 검증(Origin 검사 · frame-ancestors) · 위젯 iframe 분리(postMessage · 출처 UI) · 브라우저 E2E · Docker 이미지 정리
- [x] W3 저장소(PostgreSQL · Prisma 마이그레이션 · 메모리·DB 공통 계약 테스트) · 운영 콘솔(테넌트 키 로그인 · 대화 로그 · 미응답 큐) · 상담원 연결 접수(위젯 → 큐)
- [x] W4 크레딧 원장(턴당 1 차감 · 0이면 402 · 테넌트 범위 멱등 키) · 모의 결제 제공자(서명 웹훅 · 재배달·순서 뒤바뀜·위조·충전 재시도 재현 테스트) · 콘솔 크레딧·충전 · 이벤트 로그(대화 요청·위젯 열림 사건을 DB에 기록) · 콘솔 지표(최근 7일 TTFT p50·p95 · 자동 해결률 · 위젯 열림 수) · 대화 API 요율 제한 · 인사말 A/B(서버 배정 · 방문자 브라우저에 보존 · 변형별 노출 → 첫 질문 · 콘솔 표) · 토스페이먼츠 테스트 결제(결제창형 · 서버 승인 확정 · 웹훅은 결제 조회로 판정)
- [x] W5 응답 품질 평가셋(30케이스 · Sonnet 5.5 대 Haiku 5.5 · 기계 검사 + Opus 5.5 심판 + 사람 채점 대조) · 답 기준(지원하지 않는 기능은 자료에 적힌 것만 단정 · 본문 도구 태그와 되풀이 문장 거르기) · 실패 사례 기록 → [결과](docs/eval/w5/README.md)
- [x] W6 부하 측정(k6 · 목업 엔진으로 서버 몫만 잼 · 동시 방문자 10~1,200명 사다리 두 번 · 기기 CPU 몫 · CPU 프로파일 · 원장 크기 실험, 시뮬레이션 기준) · 문서화(다음 확장 · W5·W6 면접 질문) → [결과](docs/load/w6/README.md)

성능·해결률 수치는 **실측만** 기재하며, 시뮬레이션 수치는 그렇게 표기한다.

## 다음 확장

6주 범위 밖에 둔 것과, 평가·부하 측정에서 찾은 다음 할 일이다. 근거가 있는 것은 근거 문서에 링크했다.

**제품**

- **리셉션 키오스크와 행동 도구.** 회사 리셉션 키오스크에서 방문객의 주차 등록 같은 문의를 받는 경우다. 대화 API는 그대로 쓸 수 있다. 다른 점은 답만 하지 않고 사내 시스템에 동작(주차 등록 등)을 해야 한다는 것이다. 그러려면 모델이 부르는 행동 도구, 동작 전 방문객 확인, 테넌트별 권한이 필요하다. 지금 모델이 부르는 도구는 상담원 연결 신호 하나다.
- **FAQ 입력 화면.** 지금 FAQ는 시드 파일과 `db:seed`로만 넣는다. 운영자가 콘솔에서 FAQ를 쓰고 고치는 화면과 API가 필요하다.
- **두 번째 데모 고객사.** 업종이 다른 가상 기업을 하나 더 두어 테넌트마다 자기 FAQ로만 답하는 것을 보여 준다. 지금 시드 형식은 테넌트 하나만 받고, 새 고객사마다 자기 평가 시험지가 있어야 한다.
- **검색 단계.** 지금은 FAQ 전부를 프롬프트에 넣는다([ADR-0004](docs/adr/0004-knowledge-grounding.md)). FAQ가 수십 개를 넘으면 질문과 관련된 항목만 고르는 검색 단계가 필요하다.

**답 품질** ([W5 결과](docs/eval/w5/README.md))

- **말 바꾼 되풀이 거르기.** 같은 문장의 되풀이는 스트림에서 거르지만, 말을 바꿔 같은 내용을 다시 쓰는 답은 거르지 못한다.
- **Haiku 지시 따르기.** Haiku 5.5는 답 비용이 Sonnet 5.5의 약 7%지만 기준을 채운 문항이 30개 중 8개였다. 내부 표현, 되풀이, 영어 메모가 남는다. 지시를 고치거나 출력을 후처리해서 올릴 수 있는지 본다.

**운영·성능** ([W6 부하 측정](docs/load/w6/README.md))

- **잔액 스냅샷.** 잔액은 크레딧 원장 전체의 합계라서 원장이 길수록 대화마다 느려진다. 동시 방문자 400명에서 원장이 30만 행이면 첫 바이트 p50이 52ms 늘었다. 잔액 열이나 주기적 스냅샷이 필요하다.
- **쿼리 줄이기.** 대화 턴마다 테넌트와 FAQ 전체를 DB에서 다시 읽는다. 1,200명에서 서버 CPU의 27%가 DB 접근 계층(Prisma)이었다. 바뀌지 않는 테넌트와 FAQ를 캐시하면 줄어든다.
- **응답 쓰기 묶기.** 같은 측정에서 서버 CPU의 30%가 소켓 쓰기였다. SSE 조각마다 한 번씩 쓰는 것을 모아 쓰면 줄어든다. 대화창 정적 파일을 CDN에서 내보내면 그만큼도 Node에서 빠진다.
- **서버 여러 대.** 지금 한계는 Node 프로세스 하나의 이벤트 루프다(목업 엔진 기준 초당 대화 약 180턴). 프로세스를 늘리려면 프로세스 메모리에 있는 요율 제한 카운터와 무작위 비밀값을 공유 저장소와 고정값으로 옮겨야 한다(아래 '배포 전 할 일').
- **CI 부하 회귀.** 작은 부하(예: 방문자 50명, 30초)를 CI에서 돌려 첫 바이트 p95가 나빠지면 막는다.

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
pnpm e2e                              # 브라우저 E2E(Playwright) — 빌드 산출물로 목업 서버·데모를 띄워 런처·대화창·postMessage·CSP, 콘솔 로그인·큐·충전·결제창 귀환 주소 확인
                                      # 처음 한 번: pnpm --filter @qrate/widget exec playwright install chromium. 8787·5173이 비어 있어야 한다
pnpm --filter @qrate/server load --run load/runs/<이름>   # 부하 측정(k6, 목업 엔진, 전용 DB). 준비와 옵션은 apps/server/load/README.md
docker compose up --build             # Postgres → 마이그레이션·시드(migrate) → 서버 (Docker)
```

### 토스페이먼츠 테스트 결제

기본 충전은 모의 결제다(`QRATE_PAYMENT_PROVIDER=auto`면 개발에서 mock). 토스 테스트 환경에서 충전을 끝까지 돌리려면 개발자센터의 **결제창형** 테스트 키 두 개를 `apps/server/.env`에 넣는다.

```bash
QRATE_PAYMENT_PROVIDER=toss
QRATE_TOSS_CLIENT_KEY=test_gck_…      # 브라우저용 공개 키. 충전 목록 응답으로 콘솔에 간다
QRATE_TOSS_SECRET_KEY=test_gsk_…      # 서버만 쓴다. 로그·오류·응답에 남지 않는다
```

- 두 키가 모두 있고 둘 다 결제창형 테스트 키(`test_gck_`·`test_gsk_`)여야 서버가 뜬다. 라이브 키와 API 개별 연동 키(`test_ck_`·`test_sk_`)는 받지 않는다.
- 콘솔 충전 화면의 **결제하기**가 주문을 만들고 토스 결제창을 연다. 결제를 마치면 `/console/?toss=success…`로 돌아오고, 서버가 토스 승인 API로 확정한다. 같은 결제는 몇 번 확정해도 원장은 한 줄이다.
- 웹훅(`POST /api/payments/toss/webhook`)은 본문을 믿지 않고 결제 조회 API로 다시 확인한다. 공개 URL이 있어야 해서 배포 때 개발자센터에 등록한다. 그 전에는 확정 요청이 유일한 길이라, 확정 응답을 받지 못했으면 돌아온 주소를 새로고침하거나 **다시 확인**을 누른다.
- 테스트 모드라 출금은 없다. 콘솔 CSP는 토스일 때만 측정한 토스 호스트를 연다(`apps/server/src/http/console/static.ts`). 결제수단 설정이 다른 상점이면 호스트가 더 필요할 수 있고, 그때는 브라우저 콘솔에 CSP 위반이 뜬다.

### 배포 전 할 일

- **공개 키 남용 상한.** 테넌트 키는 고객 사이트 소스에 보이는 공개값이다. Origin 검사는 브라우저 안의 다른 사이트만 막고, Origin 헤더 없는 호출(curl·스크립트)은 지나간다. 그런 호출을 막는 것은 아래 IP당 요율 제한과 테넌트 크레딧 잔액뿐이라, 테넌트별 사용 상한 없이 실제 키로 공개하면 누구나 한 테넌트의 잔액을 소진시킬 수 있다.
- **비밀값 고정.** `QRATE_CONSOLE_SECRET`·`QRATE_MOCK_PAYMENT_SECRET`이 없으면 프로세스마다 무작위로 만들어, 재시작하거나 인스턴스가 둘 이상이면 콘솔 세션과 웹훅 서명이 깨진다.
- **DB.** compose의 `qrate`/`qrate`는 로컬 전용이다. 운영 DB는 강한 비밀번호와 비공개 네트워크를 쓰고, 관리형 Postgres면 `DATABASE_URL`에 `sslmode=verify-full`을 붙인다.
- **시드.** `db:seed`는 공개 데모 테넌트(키 `demo`, 100크레딧)를 넣는다. 운영 DB에 돌리지 않는다. compose의 migrate 서비스도 시드를 돌리므로 compose를 그대로 운영에 쓰지 않는다.
- **결제.** `QRATE_PAYMENT_PROVIDER=mock`은 결제 없이 크레딧을 채우는 버튼을 연다. 운영에서 켜면 시작 로그에 경고만 남는다. `toss`는 테스트 키만 받는다. 확정·토스 웹훅 경로에는 아직 요율 제한이 없고, 결제창형 상점에는 웹훅 서명을 검증할 보안 키가 없어 서명 대신 결제 조회로 확인한다.
- **Sentry.** `SENTRY_DSN`을 켜도 요청 본문·쿠키·요청 헤더·IP는 보내지 않는다(`apps/server/src/sentry.ts`). 경로와 쿼리 문자열은 보낸다(`token` 같은 이름은 SDK가 거른다). SDK를 올리면 `test/sentry-privacy.test.ts`가 방문자 메시지·콘솔 로그인 키·세션 쿠키가 실리지 않는지 다시 확인한다.
- **trust proxy.** 리버스 프록시 뒤에 두면 Express `trust proxy`를 프록시 홉 수로 설정해야 IP당 요율 제한(대화 API 분당 20회 · 상담원 연결 20회 · 위젯 사건 30회 · 콘솔 로그인 10회)이 방문자별로 센다. 지금은 설정하지 않아서 프록시 뒤에서는 모든 요청이 프록시 IP 하나로 세지고, `X-Forwarded-For`가 처음 올 때 제한마다 express-rate-limit 경고(`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`)가 로그에 한 번 남는다. IPv6는 주소 하나가 아니라 /56 대역 하나로 센다(express-rate-limit 기본값, 주소를 바꿔 가며 우회하는 것을 막는다).

## AI 워크플로우 (작업 방식)

구현은 AI 에이전트가, **설계·리뷰·설명 책임은 사람이** 맡는다.

- 아키텍처 결정은 [docs/adr](docs/adr)에 직접 작성 — 결정·대안·트레이드오프
- PR 이름은 주차가 아니라 작업으로 — PR 제목 `<대단위> - <소규모>`, 브랜치는 `<type>/<짧은-설명>`(예: `feat/widget-iframe-split`). 어휘·예시는 [PR 템플릿](.github/pull_request_template.md) 머리말
- 머지는 CI 게이트(typecheck·lint·test·build·브라우저 e2e) 통과 시에만 — [ci.yml](.github/workflows/ci.yml)
- 결제·인증·SSE·모더레이션 코드는 줄 단위로 읽는다 — [PR 템플릿](.github/pull_request_template.md)
- AI 생성 코드에서 실제 발견한 문제만 [docs/reviews.md](docs/reviews.md)에 기록
- 주 1회: [면접 질문 뱅크](docs/interview)에 코드 안 보고 답하기 → 블로그로 발행(`pnpm blog:new`)
- 에이전트 규칙은 [CLAUDE.md](CLAUDE.md) — [pstack](https://github.com/michael-denyer/pstack-claude)(Claude Code 포트, 원작은 [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack)) 플레이북으로 일하고, 커밋·push·PR·머지는 장치(가드 훅·CI·코드를 쓰지 않은 에이전트의 검증)를 지나면 자동. 결제·인증·모더레이션·마이그레이션·CI·장치 자체는 사람이 머지
