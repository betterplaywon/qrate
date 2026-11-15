# Qrate

Qrate는 소규모 SaaS·커머스 사이트에 스크립트 한 줄로 설치하는 AI 상담 위젯 SDK와 운영자용 웹 콘솔이다. 채널톡·인터콤 같은 상담 도구가 이미 시장에서 푸는 문제를 처음부터 다시 풀었다. 다시 풀면서 다룬 주제는 위젯 격리(Shadow DOM 런처와 iframe 대화창), SSE 스트리밍, 멱등한 크레딧 과금, 응답 품질 평가다.

```html
<!-- 고객 사이트에 넣는 것은 이 한 줄이 전부다. 스크립트는 위젯 서버가 /widget.js로 준다 -->
<script src="https://qrate.example/widget.js" data-tenant="KEY" defer></script>
```

고객 사이트가 CSP를 쓰면 지시어 세 개를 고쳐야 한다. `default-src 'self'`만 있으면 런처 스타일과 대화창이 모두 막힌다.

- `script-src`에 위젯 스크립트의 오리진을 넣는다.
- `frame-src`에 위젯 서버의 오리진을 넣는다. 대화창이 그 오리진의 iframe이다.
- `style-src`에 `'unsafe-inline'`을 넣는다. 런처가 Shadow DOM 안에 `<style>`을 넣기 때문이다.

## 왜 이걸 만들었나 (문제 근거)

가설은 둘이다.

- H1. 1~10인 팀이 받는 고객 문의의 절반 이상은 FAQ나 문서로 답할 수 있는 반복 질문이다.
- H2. 그 응대가 창업자와 개발자의 시간을 빼앗는다.

공개 근거는 2026-11-01에 찾았다. 해외 설문이라 국내 수치가 아니다.

- 북미 고객서비스 리더 설문(2018)에서 응답자의 80%가 "팀 티켓의 20% 이상이 반복적이지만 쉽게 해결되는 문의"라고 답했다. DigitalGenius와 Canam Research의 조사다([DestinationCRM 보도](https://www.destinationcrm.com/Articles/CRM-Insights/CRM-Blog/Repetitive-Tickets-Are-Prevalent-in-Customer-Service-Survey-Finds-127256.aspx)).
- 소규모 팀의 응대 시간 부담(H2)을 수치로 밝힌 최근 공개 자료는 찾지 못했다.
- "티켓의 40~60%가 반복 문의" 같은 수치는 벤더 블로그의 인용만 찾았다. 원 출처를 확인하지 못해 인용하지 않는다.
- 반복 문의 비율을 직접 밝힌 국내 자료도 찾지 못했다. 그래서 H1은 가설로 둔다.

운영자 미니 인터뷰는 하지 않았다. W1 안에 운영자 2~3명을 인터뷰해 익명 인용 2~3줄을 여기에 남길 계획이었다. 그래서 H2는 공개 자료로도 인터뷰로도 확인하지 못한 가설로 남아 있다.

## 누구를 위한 것인가 (타깃)

- **구매자(운영자).** 가상 인물 희영은 2인 B2B SaaS의 공동창업자이고 개발을 맡는다. 문의를 이메일·슬랙·무료 상담 도구로 주당 약 30건 받는데, 절반은 이미 문서에 있는 내용이다. 희영은 설치가 5분 안에 끝나기를 바란다. 답이 틀렸을 때 책임질 수 있게 출처가 보이고 사람에게 넘길 수 있어야 한다. 과금은 쓴 만큼만 내고 싶어 한다.
- **사용자(최종 고객).** 희영의 사이트 방문자다. 바로 답을 받기를 기대하고, 틀린 답보다는 사람에게 연결되기를 원한다. 그래서 상담원 연결 버튼을 늘 보이게 두는 것이 요구사항이다. 버튼을 누르면 방문자가 이메일과 남길 말을 적고, 그 요청이 운영 콘솔의 미응답 큐에 들어간다. 운영자는 콘솔 밖에서 이메일로 답한 뒤 큐의 상태를 옮긴다. 모델이 "자료에 없는 질문"이라고 신호한 턴도 같은 큐에 들어간다.
- **비(非)타깃.** CS 팀이 있는 중견기업 이상과 전화 상담 중심 업종이다. 그래서 권한·SLA 같은 엔터프라이즈 기능은 만들지 않는다.

## 구조

```
apps/server         Express 5 + TS 서버. 대화 API(SSE 스트리밍), 입력 모더레이션, 답변 엔진, 저장소(메모리 또는 Prisma·PostgreSQL, 마이그레이션은 prisma/migrations)
apps/console        React + Vite 운영 콘솔(로그인, 대화 로그, 미응답 큐, FAQ, 지표, 크레딧·충전). 빌드 산출물은 서버가 /console/로 서빙한다
packages/widget     사이트에 넣는 위젯 SDK. 런처(IIFE, Shadow DOM), 대화창 앱(서버 오리진 iframe, postMessage), 브라우저 E2E(e2e/)
packages/contracts  서버·위젯·콘솔이 함께 쓰는 계약. SSE 이벤트 encode/parse, API 요청·응답·오류 본문, 허용 사이트 주소 문법
scripts/blog        티스토리 발행 파이프라인(Playwright)
docs/adr            아키텍처 결정 기록(결정과 트레이드오프는 직접 작성)
docs/eval           응답 품질 평가 결과와 근거 기록(실측)
docs/load           부하 측정 결과와 근거 기록(목업 엔진 시뮬레이션)
docs/interview      주차별 면접 질문 뱅크
docs/reviews.md     AI가 만든 코드와 문서에서 실제로 찾은 문제 기록
```

## 진행 상황

- [x] W1 기반. 모노레포(pnpm workspace), CI 게이트(GitHub Actions), Sentry, Docker, SSE 목업 스트리밍, 입력 모더레이션(3단계)과 테스트.
- [x] W2 답변 엔진과 위젯. Claude 스트리밍 엔진(서버 측 폴백, 목업 교체), 지식(FAQ) 전량 주입과 인용, 핸드오프 신호(도구 호출), 테넌트 검증(Origin 검사, frame-ancestors), 위젯 iframe 분리(postMessage, 출처 UI), 브라우저 E2E, Docker 이미지 정리.
- [x] W3 저장소와 콘솔. PostgreSQL과 Prisma 마이그레이션, 메모리·DB 공통 계약 테스트, 운영 콘솔(테넌트 키 로그인, 대화 로그, 미응답 큐), 위젯에서 큐로 들어오는 상담원 연결 접수.
- [x] W4 결제와 이벤트 로그.
  - 크레딧 원장(턴당 1 차감, 0이면 402, 테넌트 범위 멱등 키)과 콘솔 크레딧·충전 화면.
  - 모의 결제 제공자. 웹훅에 서명을 붙이고, 재배달·순서 뒤바뀜·위조·충전 재시도를 테스트로 재현한다.
  - 이벤트 로그. 대화 요청과 위젯 열림 사건을 DB에 기록한다. 콘솔 지표는 최근 7일의 TTFT p50·p95, 자동 해결률, 위젯 열림 수를 보여 준다.
  - 대화 API 요율 제한.
  - 인사말 A/B. 서버가 변형을 배정하고 방문자 브라우저에 보존한다. 변형마다 노출, 첫 질문, 전환율을 콘솔 표로 본다.
  - 토스페이먼츠 테스트 결제(결제창형). 서버가 승인 API로 확정하고, 웹훅은 결제 조회로 판정한다.
- [x] W5 응답 품질 평가셋. 30케이스로 Sonnet 5.5와 Haiku 5.5를 비교했다(기계 검사, Opus 5.5 심판, 사람 채점 대조). 답 기준(지원하지 않는 기능은 자료에 적힌 것만 단정, 본문 도구 태그와 되풀이 문장 거르기)을 정하고 실패 사례를 기록했다. [W5 결과](docs/eval/w5/README.md)
- [x] W6 부하 측정. k6와 목업 엔진으로 서버 몫만 쟀다(동시 방문자 10~1,200명 사다리 두 번, 기기 CPU 몫, CPU 프로파일, 원장 크기 실험, 시뮬레이션 기준). 다음 확장과 W5·W6 면접 질문도 문서로 남겼다. [W6 결과](docs/load/w6/README.md)
- [x] 두 번째 데모 고객사. 방문객이 많이 오가는 사내 리셉션이 있는 가상 회사 하람바이오다. 같은 서버에서 위젯의 테넌트 키가 고른 회사의 FAQ로만 답한다. [시드](apps/server/seed/reception-tenant.notes.md)
- [x] 회사 받기. 회사 등록과 콘솔 키 발급·회수를 서버 명령으로 한다. 키를 다시 발급하거나 회수하면 그 회사의 열린 콘솔 세션이 바로 끝난다. [아래 '새 회사 받기'](#새-회사-받기-플랫폼-운영자)
- [x] 콘솔 FAQ 편집. 회사 담당자가 개발자 없이 FAQ를 찾고 고치고 추가하고 지운다. 고친 내용은 다음 질문부터 위젯 답의 근거가 된다. 상한은 회사당 50개, 제목과 문단 합계 1만 5천 자다(권장 30개). 위젯이 질문마다 FAQ 전체를 읽어서 둔 상한이고, 3만 자에서 실측한 뒤 낮췄다.
- [x] 콘솔 설치 안내와 시작하기. 홈페이지 주소 등록(허용 사이트), 설치 스니펫 복사(서버가 `/widget.js`를 준다), 카페24·아임웹·워드프레스 단계(공식 도움말 링크), 설치 확인(대화창이 마지막으로 열린 때)이 있다. 네 단계가 끝날 때까지 첫 화면은 시작하기다.

성능·해결률 수치는 실측만 적는다. 시뮬레이션으로 잰 값에는 그렇게 표시한다.

## 다음 확장

6주 범위 밖에 둔 일과 평가·부하 측정에서 찾은 다음 할 일이다. 근거가 있는 항목은 근거 문서에 링크했다.

**제품**

- **리셉션 키오스크와 행동 도구.** 회사 리셉션 키오스크에서 방문객이 주차 등록 같은 일을 묻는 경우다. 대화 API는 그대로 쓸 수 있다. 다만 이때는 답에서 끝나지 않고 사내 시스템에 주차 등록 같은 동작까지 해야 한다. 그러려면 모델이 부르는 행동 도구와 동작 전 방문객 확인, 테넌트별 권한이 필요하다. 지금 모델이 부르는 도구는 상담원 연결 신호 하나뿐이다.
- **FAQ 한꺼번에 붙여 넣기.** 지금 콘솔은 질문을 하나씩 추가한다. 홈페이지의 FAQ 글을 통째로 붙여 넣었을 때 질문과 답 문단으로 나누고 이미 있는 질문과 겹치는 것도 알려 주면, 처음 시작하는 회사가 FAQ를 옮기기 쉬워진다.
- **플랫폼 관리자 화면.** 회사 등록과 콘솔 키 발급은 지금 서버 명령으로만 한다. 화면으로 하려면 회사 콘솔과 다른 플랫폼 관리자 로그인이 먼저 있어야 한다.
- **고객사별 평가 시험지.** 두 번째 데모 고객사(하람바이오)에는 아직 평가 시험지가 없다. 고객사마다 자료와 넘겨야 할 질문이 달라서 응답 품질은 고객사별 시험지로 따로 재야 한다.
- **검색 단계.** 지금은 FAQ 전부를 프롬프트에 넣는다([ADR-0004](docs/adr/0004-knowledge-grounding.md)). FAQ가 수십 개를 넘으면 질문과 관련된 항목만 고르는 검색 단계가 필요하다.

**답 품질** ([W5 결과](docs/eval/w5/README.md))

- **말 바꾼 되풀이 거르기.** 같은 문장의 되풀이는 스트림에서 거르지만, 말을 바꿔 같은 내용을 다시 쓰는 답은 거르지 못한다.
- **Haiku 지시 따르기.** Haiku 5.5는 답 비용이 Sonnet 5.5의 약 7%지만 기준을 채운 문항이 30개 중 8개였다. 답에 내부 표현과 되풀이 문장, 영어 메모가 남았다. 지시를 고치거나 출력을 후처리해서 통과 문항을 늘릴 수 있는지 본다.

**운영·성능** ([W6 부하 측정](docs/load/w6/README.md))

- **잔액 스냅샷.** 잔액은 크레딧 원장 전체의 합계라서 원장이 길수록 대화마다 느려진다. 동시 방문자 400명에서 원장이 30만 행이면 첫 바이트 p50이 52ms 늘었다. 잔액 열이나 주기적 스냅샷이 필요하다.
- **쿼리 줄이기.** 대화 턴마다 테넌트와 FAQ 전체를 DB에서 다시 읽는다. 1,200명에서 서버 CPU의 27%가 DB 접근 계층(Prisma)이었다. 바뀌지 않는 테넌트와 FAQ를 캐시하면 줄어든다.
- **응답 쓰기 묶기.** 같은 측정에서 서버 CPU의 30%가 소켓 쓰기였다. SSE 조각마다 한 번씩 쓰는 것을 모아 쓰면 줄어든다. 대화창 정적 파일을 CDN에서 내보내면 그 요청도 Node가 처리하지 않는다.
- **서버 여러 대.** 지금 한계는 Node 프로세스 하나의 이벤트 루프다(목업 엔진 기준 초당 대화 약 180턴). 프로세스를 늘리려면 프로세스 메모리에 있는 요율 제한 카운터와 무작위 비밀값을 공유 저장소와 고정값으로 옮겨야 한다(아래 '배포 전 할 일').
- **CI 부하 회귀.** 작은 부하(예: 방문자 50명, 30초)를 CI에서 돌려 첫 바이트 p95가 나빠지면 막는다.

## 실행

```bash
pnpm install                          # 서버 postinstall이 Prisma 클라이언트를 생성한다(apps/server/src/generated, git 제외)
cp apps/server/.env.example apps/server/.env   # ANTHROPIC_API_KEY를 넣으면 실제 모델, 비우면 목업 엔진
docker compose up -d db               # PostgreSQL. DATABASE_URL을 비우면 DB 없이 메모리 저장소(시드 파일)로 돈다
pnpm --filter @qrate/server db:migrate   # 마이그레이션 적용(스키마를 바꿨으면 파일 생성까지). 처음 한 번 db:seed로 데모 테넌트와 FAQ를 넣는다
pnpm dev                              # API 서버 http://localhost:8787 (대화창 iframe 문서와 자산도 여기서 나간다)
pnpm --filter @qrate/widget build     # 런처 widget.js와 대화창 앱 dist/frame/app.js·app.css
pnpm --filter @qrate/widget demo      # 데모 http://localhost:5173/demo.html. 허용 사이트 오리진에서 서빙한다(file://는 막힌다)
                                      # 두 번째 데모 고객사(하람바이오)는 http://localhost:5173/reception.html
pnpm --filter @qrate/console dev      # 운영 콘솔 개발 서버 http://localhost:5175/console/ (API는 8787로 프록시)
                                      # 빌드된 콘솔은 서버가 http://localhost:8787/console/로 서빙한다. 로그인은 테넌트 키 demo와 QRATE_DEMO_CONSOLE_KEY, 또는 reception과 QRATE_RECEPTION_CONSOLE_KEY

pnpm lint && pnpm typecheck && pnpm test && pnpm build   # CI 게이트와 같다(아래 e2e까지). 저장소 계약 테스트는 메모리 구현에 돌고,
                                      # .env에 QRATE_TEST_DATABASE_URL(전용 DB qrate_test, 마이그레이션 적용 후)을 두면 Postgres 구현에도 돈다
pnpm e2e                              # 브라우저 E2E(Playwright). 빌드 산출물로 목업 서버와 데모를 띄워 런처·대화창·postMessage·CSP, 콘솔 로그인·큐·충전·결제창 귀환 주소를 확인한다
                                      # 처음 한 번 pnpm --filter @qrate/widget exec playwright install chromium. 8787·5173·5174·8788이 비어 있어야 한다
pnpm --filter @qrate/server load --run load/runs/<이름>   # 부하 측정(k6, 목업 엔진, 전용 DB). 준비와 옵션은 apps/server/load/README.md
docker compose up --build             # Docker로 Postgres, 마이그레이션·시드(migrate), 서버를 차례로 띄운다
```

### 토스페이먼츠 테스트 결제

기본 충전은 모의 결제다(`QRATE_PAYMENT_PROVIDER=auto`면 개발에서 mock). 토스 테스트 환경에서 충전을 끝까지 돌리려면 개발자센터의 결제창형 테스트 키 두 개를 `apps/server/.env`에 넣는다. 결제창형 키는 개발자센터에 가입한 뒤 전자결제를 신청해야 보인다.

```bash
QRATE_PAYMENT_PROVIDER=toss
QRATE_TOSS_CLIENT_KEY=test_gck_…      # 브라우저용 공개 키. 충전 목록 응답으로 콘솔에 간다
QRATE_TOSS_SECRET_KEY=test_gsk_…      # 서버만 쓴다. 로그·오류·응답에 남지 않는다
```

- 두 키가 모두 있고 둘 다 결제창형 테스트 키(`test_gck_`·`test_gsk_`)여야 서버가 뜬다. 라이브 키와 API 개별 연동 키(`test_ck_`·`test_sk_`)는 받지 않는다.
- 콘솔 충전 화면의 **결제하기**가 주문을 만들고 토스 결제창을 연다. 결제를 마치면 `/console/?toss=success…`로 돌아오고, 서버가 토스 승인 API로 확정한다. 같은 결제를 몇 번 확정해도 원장은 한 줄이다.
- 웹훅(`POST /api/payments/toss/webhook`)은 본문을 믿지 않고 결제 조회 API로 다시 확인한다. 웹훅 주소는 공개 URL이어야 해서 배포할 때 개발자센터에 등록한다. 그 전에는 확정 요청만이 결제를 반영한다. 확정 응답을 받지 못했으면 돌아온 주소를 새로고침하거나 **다시 확인**을 누른다.
- 테스트 모드라 출금은 없다. 결제 제공자가 토스일 때만 콘솔 CSP가 실측한 토스 호스트를 연다(`apps/server/src/http/console/static.ts`). 결제수단 설정이 다른 상점이면 호스트가 더 필요할 수 있다. 그때는 브라우저 콘솔에 CSP 위반이 뜬다.

### 새 회사 받기 (플랫폼 운영자)

회사는 파일 하나로 등록한다. 콘솔 키는 서버가 만들어 한 번만 보여 준다. 이 명령은 DB를 쓰는 서버(`DATABASE_URL`)에서만 쓴다. 메모리 저장소에는 데모 시드만 올라간다.

```bash
pnpm --filter @qrate/server admin tenant:add <회사 파일.json>    # 회사 이름·키·허용 사이트·FAQ·초기 크레딧. 형식은 apps/server/seed/reception-tenant.json과 같다. 설치 스니펫이 나온다
pnpm --filter @qrate/server admin console-key:issue <회사 키>   # 콘솔 키(qrc_로 시작)를 이때 한 번만 보여 주고 DB에는 해시만 남긴다
pnpm --filter @qrate/server admin tenant:list                  # 회사마다 FAQ·대화 수·콘솔 키 유무·크레딧
pnpm --filter @qrate/server admin console-key:revoke <회사 키>  # 회수. 그 회사는 콘솔에 로그인할 수 없다
```

- 등록한 뒤에는 그 회사 담당자가 콘솔의 FAQ 화면에서 FAQ를 고친다. 허용 사이트와 설치는 콘솔의 설치 화면에서 한다. 회사 파일의 FAQ는 `tenant:add`로 처음 등록할 때만 들어간다. 다만 `db:seed`는 데모 회사 둘의 FAQ를 시드 파일대로 되돌린다. 그래서 콘솔에서 고친 데모 FAQ도 그때 되돌아간다.
- `tenant:add`가 보여 주는 설치 스니펫의 스크립트 주소는 `QRATE_PUBLIC_ORIGIN`(서버와 같은 값) 뒤에 `/widget.js`를 붙인 값이다. 값이 없으면 스니펫의 주소 자리가 비어 있다. 그때는 그 회사 콘솔의 설치 화면에서 같은 줄을 복사할 수 있다.
- 이미 있는 회사는 `tenant:add <파일> --update`일 때만 이름과 허용 사이트를 파일대로 바꾼다. FAQ와 크레딧은 그대로 둔다. 콘솔에서 고친 FAQ를 덮어쓰지 않기 위해서다. 다른 회사가 쓰는 회사 키는 받지 않는다.
- 콘솔 세션에는 로그인할 때의 콘솔 키 지문이 들어 있다. 서버는 콘솔 요청마다 그 지문을 그 회사의 지금 키와 맞춰 본다. 그래서 키를 다시 발급하거나 회수하면 이전 키로 열어 둔 세션이 다음 요청부터 401이 된다. 다른 회사의 세션은 그대로다.
- 운영 이미지에서는 `node dist/admin/cli.js <명령>`으로 쓴다.
- `QRATE_DEMO_CONSOLE_KEY`는 첫 데모 회사(`demo`, 마루인보이스)의 콘솔 키이고, `QRATE_RECEPTION_CONSOLE_KEY`는 두 번째 데모 회사(`reception`, 하람바이오)의 콘솔 키다. 값이 있으면 서버 시작(메모리 저장소)과 `db:seed`가 그 회사의 키 해시를 새로 넣는다. 그때 그 회사의 열린 세션도 끝난다. 값이 없는 회사는 메모리 저장소에서 콘솔에 로그인할 수 없고, `db:seed`는 그 회사의 기존 키를 그대로 둔다.

### 배포 전 할 일

- **공개 키 남용 상한.** 테넌트 키는 고객 사이트 소스에 보이는 공개값이다. Origin 검사는 브라우저 안의 다른 사이트만 막고, Origin 헤더 없는 호출(curl·스크립트)은 지나간다. 그런 호출을 막는 것은 아래의 IP당 요율 제한과 테넌트 크레딧 잔액뿐이다. 그래서 테넌트별 사용 상한 없이 실제 키로 공개하면 누구나 한 테넌트의 잔액을 다 써 버릴 수 있다.
- **FAQ 크기와 답 1건의 비용.** 콘솔 FAQ 글자 상한은 1만 5천 자다. 이 크기에서 FAQ를 처음 읽는 답 1건은 $0.0528~$0.0581이다. 1달러를 1,400원으로 치면 약 74~81원이라 크레딧 판매가(1개 100원)보다 낮다. 다시 읽는 답은 $0.0041이다. 옛 상한 3만 자에서는 처음 읽는 답($0.0925~$0.0978)이 판매가를 넘어서 상한을 낮췄다. 질문이 5분 넘게 뜸한 회사는 거의 매번 처음 읽기다. 모델, 모델 가격, 크레딧 판매가 가운데 하나라도 바뀌면 [실측](docs/eval/faq-size/README.md)을 다시 한다.
- **위젯 스크립트 주소.** 설치 스니펫의 스크립트 주소(`QRATE_PUBLIC_ORIGIN` 뒤에 `/widget.js`)는 고객이 자기 홈페이지에 붙여 넣는 값이다. 주소를 바꾸면 모든 고객이 스니펫을 다시 붙여야 한다. 그러니 오래 쓸 도메인으로 정하고, 나중에 CDN을 쓰더라도 같은 주소 앞에 둔다. 고객 사이트의 모든 페이지가 위젯을 열지 않아도 런처를 내려받는다(5분 캐시). 그래서 이 경로의 요청 수는 고객 사이트의 페이지 조회 수를 따라간다. W6 부하 측정에는 이 요청이 들어 있지 않다.
- **비밀값 고정.** `QRATE_CONSOLE_SECRET`·`QRATE_MOCK_PAYMENT_SECRET`이 없으면 서버가 프로세스마다 무작위 값을 만든다. 그러면 재시작하거나 인스턴스가 둘 이상일 때 콘솔 세션과 웹훅 서명이 깨진다.
- **DB.** compose의 `qrate`/`qrate`는 로컬 전용이다. 운영 DB는 강한 비밀번호와 비공개 네트워크를 쓴다. 관리형 Postgres면 `DATABASE_URL`에 `sslmode=verify-full`을 붙인다.
- **시드.** `db:seed`는 공개 데모 테넌트 둘(키 `demo`와 `reception`, 각 100크레딧)을 넣는다. 운영 DB에는 돌리지 않는다. compose의 migrate 서비스도 시드를 돌리므로 compose를 그대로 운영에 쓰지 않는다.
- **엔진 키.** `QRATE_ENGINE`이 기본값(`auto`)일 때 `ANTHROPIC_API_KEY`가 없으면 운영(`NODE_ENV=production`)에서도 목업 엔진으로 뜬다. 그러면 방문자가 모델 대신 목업 답을 받는다. 서버는 이를 막지 않고 시작 로그에 경고만 남긴다. `QRATE_ENGINE=claude`로 두면 키가 없을 때 서버가 시작하지 않는다.
- **결제.** `QRATE_PAYMENT_PROVIDER=mock`은 결제 없이 크레딧을 채우는 버튼을 연다. 운영에서 켜면 시작 로그에 경고만 남는다. `toss`는 테스트 키만 받는다. 확정·토스 웹훅 경로에는 아직 요율 제한이 없다. 결제창형 상점에는 웹훅 서명을 검증할 보안 키가 없어서 서명 대신 결제 조회로 확인한다.
- **Sentry.** `SENTRY_DSN`을 켜도 요청 본문·쿠키·요청 헤더·IP는 보내지 않는다(`apps/server/src/sentry.ts`). 경로와 쿼리 문자열은 보낸다(`token` 같은 이름은 SDK가 거른다). SDK를 올리면 `test/sentry-privacy.test.ts`가 방문자 메시지·콘솔 로그인 키·세션 쿠키가 실리지 않는지 다시 확인한다.
- **Sentry 계측.** 실행 줄(`start` 스크립트, `apps/server/Dockerfile`의 `CMD`)에 `--import`가 없다. 이 서버는 ESM이라서 이 상태로는 Sentry가 express 같은 라이브러리를 계측하지 못한다. 트랜잭션은 들어오는 HTTP 요청 단위로만 생기고 미들웨어·라우트 span은 없다. 처리 중 오류는 `index.ts`의 `reportError`가 `captureException`으로 직접 보낸다. 라이브러리 계측이 필요하면 `node --import ./dist/sentry.js dist/index.js`로 띄운다(@sentry/node README의 ESM 절).
- **trust proxy.** 리버스 프록시 뒤에 두면 Express `trust proxy`를 프록시 홉 수로 설정해야 한다. 그래야 IP당 요율 제한(대화 API 분당 20회, 상담원 연결 20회, 위젯 사건 30회, 콘솔 로그인 10회)이 방문자별로 센다. 지금은 설정하지 않았다. 그래서 프록시 뒤에서는 모든 요청이 프록시 IP 하나로 세진다. `X-Forwarded-For`가 처음 올 때는 제한마다 express-rate-limit 경고(`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`)가 로그에 한 번 남는다. IPv6는 주소 하나가 아니라 /56 대역 하나로 센다. express-rate-limit의 기본값이고, 주소를 바꿔 가며 우회하는 것을 막는다.
- **종료 처리.** 서버에 SIGTERM 처리가 없다. 새 요청을 멈추고 진행 중인 답을 마저 보내는 `server.close`도, Prisma 연결을 닫는 `$disconnect`도 하지 않는다. 그래서 재시작이나 배포로 프로세스가 내려가면 진행 중인 답 스트림이 `[DONE]` 없이 끊긴다.
- **대화 턴 시간 제한.** 서버가 모델 호출을 끊는 것은 방문자 연결이 닫힐 때뿐이다(`apps/server/src/http/chat.ts`). 대화창도 대화 요청에 시간 제한을 두지 않는다. Anthropic SDK(1.3.0)의 시간 제한(기본 10분)은 응답 헤더가 올 때까지만 걸리고, 재시도(기본 2회)마다 새로 걸린다. 답 스트림이 시작된 뒤에는 SDK도 시간 제한을 두지 않는다.

## AI 워크플로우 (작업 방식)

구현은 AI 에이전트가 한다. 설계 결정과 리뷰는 사람이 하고, 결정의 이유를 설명하는 것도 사람의 몫이다.

- ADR의 결정과 트레이드오프는 사람이 [docs/adr](docs/adr)에 직접 쓴다. 뼈대와 고려한 대안 표, 유도 질문은 에이전트가 쓰고, 표의 사실은 그 칸을 쓰지 않은 다른 모델이 공식 문서·코드와 대조한다.
- PR 제목에는 주차가 아니라 작업을 적는다(`<대단위> - <소규모>`). 브랜치는 `<type>/<짧은-설명>`이다(예: `feat/widget-iframe-split`). 어휘와 예시는 [PR 템플릿](.github/pull_request_template.md) 머리말에 있다.
- CI 게이트(typecheck, lint, test, build, 브라우저 E2E)를 통과해야 머지한다([ci.yml](.github/workflows/ci.yml)).
- 결제·인증·SSE·모더레이션 코드는 사람이 줄 단위로 읽는다([PR 템플릿](.github/pull_request_template.md)의 체크리스트).
- AI가 만든 코드와 문서에서 실제로 찾은 문제만 [docs/reviews.md](docs/reviews.md)에 적는다.
- 주 1회 [면접 질문 뱅크](docs/interview)의 질문에 코드를 보지 않고 답한다.
- 에이전트 규칙은 [CLAUDE.md](CLAUDE.md)에 있다. 에이전트는 [pstack](https://github.com/michael-denyer/pstack-claude) 플레이북으로 일한다(Claude Code 포트, 원작은 [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack)). 커밋·push·PR·머지는 가드 훅과 CI, 코드를 쓰지 않은 에이전트의 검증을 지나면 자동으로 한다. 결제·인증·모더레이션·마이그레이션·CI와 에이전트 장치 자체를 건드린 PR은 사람이 머지한다.
