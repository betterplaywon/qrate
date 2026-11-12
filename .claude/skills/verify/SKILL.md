---
name: verify
description: "qrate(임베더블 AI 상담 위젯 SDK + 운영 콘솔 + HTTP API)를 실제 Chromium으로 사용자 경로 그대로 돌려 증거를 남기는 검증 스킬. 목업 엔진·메모리 저장소 서버(8787)와 데모 페이지(5173·5174)를 띄우고 위젯 대화·상담원 연결 접수·운영 콘솔·허용되지 않은 오리진 차단을 드라이브한다. 변경이 실제 앱에서 동작하는지 증명하거나 버그를 재현하거나 스크린샷·trace·응답 본문이 필요할 때 쓴다. /verify"
---

# verify

qrate는 고객 사이트에 스크립트 한 줄로 설치하는 AI 상담 위젯과 운영자용 웹 콘솔이다. 이 스킬은 그 앱을 검증용으로 띄우고, 방문자·운영자가 하는 그대로 Chromium에서 움직여, 결과를 `.audit/evidence/` 아래에 남긴다. 처음 보는 에이전트가 이 문서만 읽고 따라 할 수 있게 쓰였다. 순서는 항상 같다: 준비 → Launch → Doctor → Drive → Evidence 확인 → Cleanup.

규칙 하나가 모든 단계에 걸린다: **이 스킬이 띄운 인스턴스만 드라이브한다.** `pnpm dev`로 떠 있는 서버는 실제 모델(API 키)을 쓰고 있을 수 있다. launch는 포트가 차 있으면 멈추고, doctor는 포트의 주인이 run.json의 PID인지 확인하며, drive는 `/healthz`의 엔진이 `mock`이 아니면 거절한다.

## 앱과 표면

사용자가 만지는 표면은 셋이다. 선택자는 소스에서 가져온 것이고 placeholder가 아니다.

- **방문자용 위젯** — 데모 페이지 `http://localhost:5173/demo.html`(packages/widget/demo.html을 demo.mjs가 서빙)에 설치 스니펫이 있다. 우하단 런처는 Shadow DOM 안의 버튼 `#qrate-host .launcher`(aria-label "상담 열기")이고, 누르면 서버 오리진의 대화창 iframe `#qrate-host iframe.frame`(src `http://localhost:8787/frame?t=demo&o=http://localhost:5173`, 다시 오는 방문자는 `&v=<인사말 변형 id>`가 붙는다)이 열린다. 런처는 서버가 배정한 인사말 변형을 데모 사이트 localStorage `qrate.greeting.demo`에 둔다. 대화창 안은 머리글 `.title`("무엇을 도와드릴까요?"), "상담원 연결" 버튼 `.handoff`, 닫기 `.close`, 입력 `#qrate-input`, 전송 `.send`, 대화 맨 위의 인사말 `.msg.greeting`(답변이 아니다), 말풍선 `.msg.user`·`.msg.bot`(스트리밍 중 `aria-busy="true"`), 출처 접기 `.sources`(`summary` "출처 N건", `.source-title`, `.quote q`), 안내 `.msg.notice`(버튼 `.notice-action`), 연락처 폼 `.handoff-form`(`#qrate-contact`, `#qrate-handoff-message`, `button[type="submit"]`, `.cancel`)이다. Playwright 로케이터는 열린 shadow root를 뚫고, iframe은 `page.frameLocator('#qrate-host iframe.frame')`로 들어간다. 출처: packages/widget/src/loader.ts, packages/widget/src/frame/view.ts.
- **운영자용 콘솔** — 서버가 `http://localhost:8787/console/`로 서빙하는 React 앱. 로그인은 `#tenant`에 테넌트 키 `demo`, `#key`에 콘솔 키, 버튼 "로그인". 해시 라우팅 `#/start`·`#/queue/open`·`#/queue/in_progress`·`#/queue/done`·`#/conversations`·`#/conversations/<id>`·`#/faq`·`#/faq/new`·`#/faq/<id>`·`#/install`·`#/metrics`·`#/billing`. 해시가 비면 시작하기 네 단계(주소·FAQ 5개·설치 신호)가 끝나기 전에는 시작하기, 끝나면 미응답 큐다. 화면 요소는 data-testid로 잡는다: `tenant-name`, `queue-empty`, `queue-list`, `queue-item`, `tab-<status>`, `move-<status>`, `status`, `conversations-empty`, `conversation-item`, `messages`, `detail-handoffs`, 지표 화면의 `nav-metrics`, `metrics-window`, `metric-ttft-p50`·`metric-ttft-p95`·`metric-ttft-samples`, `metric-resolution-rate`·`metric-resolution-resolved`·`metric-resolution-conversations`·`metric-resolution-handoff-only`, `metric-widget-opens`, 인사말 A/B 표의 `metric-greeting`, 변형마다 `metric-greeting-<변형 id>`·`metric-greeting-exposures-<변형 id>`·`metric-greeting-first-questions-<변형 id>`·`metric-greeting-rate-<변형 id>`, `metric-greeting-outside-opens`·`metric-greeting-outside-questions`, 시작하기의 `nav-start`·`start-progress`·`start-step-<1~4>`·`start-verified`, FAQ의 `nav-faq`·`faq-count`·`faq-group`·`faq-item`·`faq-unsupported`·`faq-notice`·`faq-missing`, 설치의 `nav-install`·`origin-list`·`install-snippet`·`install-waiting`·`install-verified`. 출처: apps/console/src/views/*.tsx.
- **HTTP API** — `GET /healthz`, `GET /frame?t=&o=`, `GET /api/greeting?tenant=&variant=`(대화창이 처음 뜰 때 묻는 인사말 배정, 사건을 남기지 않음), `POST /api/chat`(SSE 스트림, 응답 헤더 X-Conversation-Id), `POST /api/handoff`(201), `POST /api/events`(대화창의 위젯 사건 `widget_open`·`first_question`, 202 본문 없음), `POST /api/console/login`·`/logout`, `GET /api/console/me`·`/conversations`·`/conversations/:id`·`/handoffs?status=`·`/metrics`, `PATCH /api/console/handoffs/:id`, `GET·POST /api/console/top-ups`(POST는 `Idempotency-Key` 헤더), `POST /api/console/top-ups/:id/simulate`(모의 제공자일 때만), `POST /api/console/top-ups/:id/confirm`(토스 제공자일 때만, 본문 `{paymentKey, amount}`), `POST /api/payments/mock/webhook`(서명 헤더 `qrate-mock-signature`, Origin 검사 없음), `POST /api/payments/toss/webhook`(토스일 때만, 본문을 믿지 않고 조회 API로 다시 묻는다). 상태를 바꾸는 요청은 Origin 헤더가 `http://localhost:8787`이어야 한다(없으면 통과, 다른 값이면 403). 계약: packages/contracts/src/*.ts.

## Isolate — 나란히 두 개는 못 띄운다

포트가 고정이라 인스턴스는 한 번에 하나다. 5173은 시드 테넌트의 allowedOrigins(apps/server/seed/demo-tenant.json)에 글자 그대로 들어 있고, 8787은 데모 페이지의 `data-endpoint`에 적혀 있으며, 5174는 "허용 목록 밖 사이트"를 재현하는 두 번째 데모다. 8788은 이 스킬이 쓰지 않지만 콘솔 E2E(`pnpm e2e`)가 쓰므로 함께 비어 있는지 본다. 다른 검증·개발 인스턴스가 떠 있으면 launch가 lsof 결과를 보여 주며 멈춘다 — 그 인스턴스를 재사용하지 않는다. 같은 이유로 기능 하나를 증명할 때마다 새로 launch한다(메모리 저장소가 비어 있는 상태에서 시작하는 것이 곧 전제다).

## 준비

- 의존성: `pnpm install` (서버 postinstall이 Prisma 클라이언트를 만든다).
- 빌드: 루트에서 `pnpm build`. 이 스킬은 빌드 산출물로만 돈다 — `apps/server/dist/index.js`, `packages/widget/dist/widget.js`, `packages/widget/dist/frame/app.js`, `apps/console/dist/index.html`. 코드를 바꿨으면 launch 전에 다시 빌드한다(빌드는 약 5초). launch는 산출물이 없으면 멈추고, doctor는 산출물의 mtime을 보여 준다.
- 브라우저: 처음 한 번 `pnpm --filter @qrate/widget exec playwright install chromium`. Playwright 자체는 `@playwright/test`(packages/widget·apps/console의 devDependency)를 쓰며, 이 스킬의 스크립트는 그것을 packages/widget 기준으로 찾는다. 새 의존성은 없다.
- 포트 8787·5173·5174·8788이 비어 있어야 한다. `pnpm dev`나 `pnpm e2e`가 떠 있으면 먼저 내린다.

## Launch

```
node .claude/skills/verify/scripts/launch.mjs <feature>
```

`<feature>`는 feature map의 id 하나다: `widget-chat` | `handoff-queue` | `console` | `origin-guard` | `top-up` | `top-up-toss` | `metrics` | `greeting-ab`. `top-up-toss`만 서버를 토스 제공자로 띄우고, 결제창형 테스트 키를 실행 환경의 `QRATE_VERIFY_TOSS_CLIENT_KEY`·`QRATE_VERIFY_TOSS_SECRET_KEY`에서 받는다(없으면 멈춘다). launch는 증거 폴더 `.audit/evidence/<YYYYMMDD-HHMM>-<feature>/`를 만들고 거기에 `run.json`(PID·포트·시작 시각·git HEAD·산출물 mtime)과 각 프로세스의 로그를 두면서 셋을 띄운다.

| 이름 | 포트 | 명령(레포 루트 기준) | 환경변수 |
| --- | --- | --- | --- |
| server | 8787 | `node apps/server/dist/index.js` | `QRATE_ENGINE=mock QRATE_REPO=memory PORT=8787 QRATE_PUBLIC_ORIGIN=http://localhost:8787 QRATE_DEMO_CONSOLE_KEY=e2e-widget-console-key QRATE_CONSOLE_SECRET=verify-session-secret-0123 QRATE_PAYMENT_PROVIDER=mock QRATE_MOCK_PAYMENT_SECRET=verify-mock-payment-secret-01` |
| demo | 5173 | `node packages/widget/demo.mjs` | `PORT=5173` |
| demo-not-allowed | 5174 | `node packages/widget/demo.mjs` | `PORT=5174` |

서버는 `node`를 직접 실행한다(`--env-file` 없음)라서 `apps/server/.env`의 실제 API 키·DB 주소를 읽지 않고, 셸 환경도 PATH·HOME만 물려받는다. 엔진은 목업(글자당 20ms로 흘려보내므로 답 하나에 2~3초), 저장소는 시드 파일을 올린 메모리(테넌트 `demo` "마루인보이스", FAQ 26건, 콘솔 키 해시)다. 위젯 E2E(packages/widget/playwright.config.ts)와 같은 구성이고 콘솔 키 값도 같다(packages/widget/e2e/servers.ts의 `CONSOLE_KEY`).

**준비됨의 기준**은 프로세스가 답하는 것이 아니라 쓸 수 있는 것이다. launch는 20초 안에 다음이 전부 맞아야 `LAUNCH OK`를 찍는다: `GET /healthz` 200이고 본문의 `engine`·`model`이 `mock`, `GET /frame?t=demo&o=http://localhost:5173` 200이고 CSP 헤더에 `frame-ancestors http://localhost:5173`, `GET /frame/app.js` 200, `GET /console/` 200, `GET http://localhost:5173/demo.html`·`/dist/widget.js` 200, `GET http://localhost:5174/demo.html` 200, 그리고 server.log에 `[server] engine=mock model=mock`와 `[server] storage=memory seed tenant=demo knowledge=26 console=on`. 어느 하나라도 아니면 띄운 것을 모두 내리고(run.json status=failed) 로그 꼬리를 보여 준 뒤 종료 코드 1이다.

성공 출력 예:

```
run: .audit/evidence/20261105-1105-widget-chat
started server: pid=45029 port=8787 node apps/server/dist/index.js → server.log
started demo: pid=45030 port=5173 node packages/widget/demo.mjs → demo-5173.log
started demo-not-allowed: pid=45031 port=5174 node packages/widget/demo.mjs → demo-5174.log
server: engine=mock model=mock storage=memory seed tenant=demo knowledge=26 console=on
LAUNCH OK — 다음: node .claude/skills/verify/scripts/doctor.mjs
```

프로세스는 분리(detached)돼 launch가 끝나도 살아 있다. 내리는 방법은 Cleanup에 있다. 사람이 손으로 띄울 때도 위 표의 명령과 환경변수를 그대로 쓴다 — 다만 그 경우 run.json이 없어 doctor·cleanup 스크립트가 그 인스턴스를 모른다.

## Doctor

```
node .claude/skills/verify/scripts/doctor.mjs [--run <증거 폴더>]
```

읽기 전용으로 "이 인스턴스를 드라이브해도 되는가"에 답한다. `--run`이 없으면 status가 running인 가장 최근 run.json을 쓴다. 확인하는 것: run.json의 status가 running, 세 PID가 살아 있고 `ps`의 명령줄이 그 스크립트(`apps/server/dist/index.js`, `packages/widget/demo.mjs`)인지, `lsof -nP -iTCP:<포트> -sTCP:LISTEN`의 주인이 바로 그 PID인지, `/healthz`의 엔진이 `mock`(실제 모델 호출 없음)인지, server.log의 저장소 줄이 `memory seed tenant=demo … console=on`인지, `/frame`이 허용 오리진(5173)에 200+CSP·비허용 오리진(5174)에 403을 주는지(시드가 그대로인지), `/frame/app.js`·`/console/`·두 데모 페이지·`/dist/widget.js`가 200인지, 콘솔 키로 `POST /api/console/login`이 200이고 테넌트 이름이 "마루인보이스"인지. 결과는 `<증거 폴더>/doctor.json`에도 남고, 마지막 줄이 `DOCTOR OK`(종료 코드 0) 또는 `DOCTOR FAIL`(1)이다. 8788에 무언가 떠 있으면 info로 알린다.

FAIL이면 드라이브하지 않는다. 포트 주인이 다른 PID면 남의 인스턴스다 — cleanup으로 우리 것을 내리고 그 인스턴스를 내린 뒤 다시 launch한다. 엔진이 mock이 아니면 절대 드라이브하지 않는다. 로그인 확인은 서명 토큰을 받을 뿐 저장소를 바꾸지 않지만 IP당 분당 10회 제한이 있어 doctor를 1분에 열 번 넘게 돌리면 429가 난다.

## Drive

```
node .claude/skills/verify/scripts/drive.mjs [--run <증거 폴더>] [--feature <id>] [--headed]
```

run.json의 feature(또는 `--feature`)에 해당하는 여정 `scripts/journeys/<feature>.mjs`를 실제 Chromium(기본 headless, `--headed`면 창을 띄운다)에서 돌린다. 여정은 사용자 행동 하나를 단계(step) 하나로 삼고, 단계마다 관찰 결과를 적고 스크린샷을 찍는다. 단계가 하나라도 실패하면 거기서 멈추고 `-FAILED.png`와 trace를 남기며 종료 코드 1이다. 성공이면 마지막 줄이 `DRIVE PASS <feature>`다. `--feature`가 run.json과 다르면 같은 증거 폴더의 `<feature>/` 하위에 남긴다(새 저장소 상태가 필요한 여정은 새로 launch하는 쪽이 맞다).

무엇을 어떤 순서로 누르고 무엇이 보여야 하는지는 [feature map](features/README.md)의 기능 파일에 단계 id와 함께 적혀 있다. 지금 있는 여정:

- `widget-chat` — 런처 → 대화창 → 질문 "요금제가 뭐가 있나요?" → 스트리밍 답변·출처 1건 → 다음 질문이 같은 대화로 → 콘솔 대화 로그(API·화면). [features/widget-chat.md](features/widget-chat.md)
- `handoff-queue` — `[[handoff]]` 신호 뒤 "상담원 연결" 제안 → 연락처 폼 → 201 접수, 머리글 버튼으로 질문 전 접수 → 콘솔 미응답 큐(API·화면). [features/handoff-queue.md](features/handoff-queue.md)
- `console` — 콘솔 문서 CSP → 틀린 키·맞는 키 로그인 → 위젯으로 대화 2건 → 대화 로그·상세 → 큐 상태 이동 → 로그아웃. [features/console.md](features/console.md)
- `origin-guard` — `/frame` 403 안내 문서, 5174 데모에서 CSP frame-ancestors 거부, 5173 대조군. [features/origin-guard.md](features/origin-guard.md)
- `top-up` — 콘솔 충전 요청 → 결제 성공(테스트) → 재배달 → 늦은 실패, 같은 `Idempotency-Key` 재전송, 서명 웹훅 재배달·다른 이벤트 id·위조·만료, 원장 한 줄. 서버는 고정 모의 결제 비밀(`QRATE_MOCK_PAYMENT_SECRET`)로 뜬다. [features/top-up.md](features/top-up.md)
- `top-up-toss` — 토스일 때만 열리는 콘솔 CSP → "결제하기" → 토스 결제창(진짜 SDK, 우리 문서의 CSP 위반 0) → 토스가 모르는 결제 키로 돌아옴(서버가 승인·조회를 물은 뒤 "확인하지 못함", 쿼리 유지) → 실패 주소의 문장 미표시 → 원장 그대로. 바깥 서비스(토스 테스트 환경)를 결제창 1·승인 1·조회 1회 부르고 결제는 끝내지 않는다. [features/top-up-toss.md](features/top-up-toss.md)
- `metrics` — 위젯 열기(widget_open 사건) → 질문 1건(first_question 사건) → 닫고 다시 열기(열림 그대로) → 다른 페이지 로드에서 연결만 요청 → 콘솔 "지표"의 표본 1·p50 = p95·해결 1/1(연결만 요청한 대화는 분모 밖, "바로 상담원 연결 1건"으로 따로)·열림 2와 API 응답 → server.log의 사건 줄 대조. [features/metrics.md](features/metrics.md)
- `greeting-ab` — 처음 방문(서버 배정 인사말이 대화 맨 위에, 데모 사이트 localStorage에 보존, 열림 사건에 그 변형) → 다시 로드(`v=` 같은 값, 같은 인사말) → 첫 질문(같은 변형) → 다른 변형을 보존한 재방문자 → 지금 실험에 없는 보존값(새로 배정해 덮어씀) → 콘솔 "지표"의 변형별 노출·첫 질문 = 브라우저 사건 = API → server.log 대조. [features/greeting-ab.md](features/greeting-ab.md)

목업 엔진의 훅은 메시지 안의 마커다(apps/server/src/engine/mock.ts): `[[handoff]]`(안내 문장 + event: handoff, 인용 없음), `[[fail:429]]`(첫 이벤트 전 503 + Retry-After 2 → "다시 보내기"), `[[fail:401]]`(502, 재시도 불가), `[[fail-mid]]`(5글자 뒤 끊김), `[[refuse]]`(정책 거절). 실제 모델에는 없다.

맵에 없는 것을 드라이브하려면 여정을 하나 더 쓴다. `scripts/journeys/<id>.mjs`가 `export const title`과 `export async function run(h)`를 내보내면 launch·drive가 그 id를 바로 받는다. `h`는 scripts/harness.mjs가 만든 하네스다: `h.newPage({ name, ignoreConsole })`(콘솔 오류·서버 트래픽을 기록하는 페이지, `h.current`가 돼 단계 스크린샷의 대상이 된다), `h.step(id, 설명, async () => '관찰')`, `h.expect`(Playwright expect, 10초), `h.api`(브라우저와 별개의 쿠키를 가진 요청 컨텍스트, baseURL 8787), `h.chat.requests`·`h.chat.responses`(모든 페이지의 /api/chat 왕복: 요청 본문·프레임 URL·X-Conversation-Id), `h.errorsOf(page)`, `h.evidence.save/saveJson/saveApiResponse`. 같은 파일의 도우미 `openWidget(h, page)`, `send(frame, 메시지)`, `finishedAnswers(frame)`, `loginConsole(h, page, key)`, `loginApi(h)`를 쓴다. 여정을 추가했으면 features/에 기능 파일을 같이 추가한다.

## Evidence

증거는 `.audit/evidence/<YYYYMMDD-HHMM>-<feature>/`에 남고 cleanup이 지우지 않는다(.audit/은 git에 넣지 않는다). 안에 있는 것:

- `steps.md` — 단계 번호·id·설명·결과·관찰·스크린샷 이름·소요 시간. 먼저 읽는 파일이다. 끝에 PASS/FAIL.
- `NN-<step-id>.png` — 단계가 끝난 직후의 화면(실패면 `-FAILED.png`). 대화창·콘솔이 보이는 1280×800.
- `trace.zip` — Playwright 트레이스(스크린샷·DOM 스냅샷·네트워크). `pnpm --filter @qrate/widget exec playwright show-trace <폴더>/trace.zip`으로 재생한다.
- `chat-N.sse.txt` — 위젯이 받은 `POST /api/chat` 응답 원문(상태줄·헤더·SSE 이벤트 전부: delta 조각, event: citation/handoff/done, `data: [DONE]`). `handoff-N.json.txt` — `POST /api/handoff` 응답. 페이지 안에서 응답 복제본을 읽어 남긴 것이라 위젯이 실제로 받은 바이트와 같다.
- `network.jsonl` — 서버(8787)로 간 요청·응답 메타(메서드·URL·요청 문서·상태·CSP/cache-control/X-Conversation-Id 헤더·요청 본문).
- `console-*.txt` — 부수 효과를 콘솔 API로 다시 읽은 응답(상태·헤더·본문).
- `browser-console.log` — 모든 페이지의 콘솔 메시지. `result.json` — 단계 목록과 결과, 파일 목록. `run.json`·`doctor.json`·`server.log`·`demo-5173.log`·`demo-5174.log` — 인스턴스 기록(server.log에는 사건마다 JSON 한 줄이 남는다 — 엔진을 부른 `/api/chat` 요청마다 `{"type":"chat_request",…}`(차단 422·크레딧 부족 402는 남지 않는다)(ttftMs, payload에 outcome·엔진·인용 수·핸드오프, 메시지 원문 없음), 위젯 열림·첫 질문마다 `{"type":"widget_open",…}`·`{"type":"first_question",…}`(화면에 보인 인사말의 `variant`). 서버가 `NODE_ENV` 없이 떠서 찍힌다. 같은 사건이 메모리 저장소의 이벤트 로그에 들어가 콘솔 지표가 된다).

증거의 기준:

- **실제 사용자 경로로 한다.** 질문은 대화창 입력으로, 접수는 연락처 폼으로, 상태 이동은 콘솔 버튼으로 한다. API는 부수 효과를 두 번째로 읽을 때(`h.api`)와 서버 계약 자체가 검증 대상일 때(`/frame` 403, 콘솔 문서 CSP)만 직접 부른다. 내부 세터나 테스트 전용 엔드포인트는 없다 — 목업 훅도 메시지 텍스트일 뿐이다.
- **행동과 결과 상태를 함께 남긴다.** 마지막 화면 한 장이 아니라 단계마다 관찰과 스크린샷, 그리고 trace.
- **부수 효과를 확인한다.** 대화가 저장됐는지(`GET /api/console/conversations/:id`의 메시지), 접수가 큐에 들어갔는지(`GET /api/console/handoffs?status=open`), 상태 이동이 반영됐는지(`?status=in_progress`)를 화면과 별개로 읽는다.
- **목업은 경계에서만.** 답변 엔진(`QRATE_ENGINE=mock`)과 저장소(`QRATE_REPO=memory`)는 서버의 정식 선택지이지 테스트 전용 분기가 아니다. 그 밖에 가짜로 바꾼 것은 없다. 실제 모델·Postgres에서의 동작은 이 스킬이 증명하지 않는다.
- 보고에는 기능 id, 들어간 입구, 증거 폴더 경로, 단계별 결과를 적는다. 닿지 못한 경로는 시도한 명령과 못 채운 전제를 적고, 다른 경로로 통과한 것을 그 경로의 검증으로 보고하지 않는다.

## Cleanup

```
node .claude/skills/verify/scripts/cleanup.mjs [--run <증거 폴더>] [--all]
```

run.json에 적힌 PID만, 그 PID의 명령줄이 우리 스크립트일 때만 끝낸다(SIGTERM → 5초 → SIGKILL). 이름으로 죽이지 않는다 — `pkill node`·`killall`은 쓰지 않는다. 끝나면 run.json의 status를 stopped로 바꾸고, 8787·5173·5174·8788의 `lsof`를 보여 주며, 증거 폴더의 파일 수를 찍는다. 마지막 줄 `CLEANUP OK`. `--all`은 running으로 남은 실행 전부(실패한 반복이 남긴 것 포함)를 내린다. 실패한 드라이브 뒤에도 반드시 cleanup하고 다시 launch한다.

증거는 건드리지 않는다. cleanup 뒤 `ls .audit/evidence/<폴더>`로 남아 있는지 확인하는 것까지가 한 사이클이다. 스크립트를 못 쓰는 상황이면 run.json의 PID를 읽어 `kill <pid>`하고 `lsof -nP -iTCP:8787 -sTCP:LISTEN`으로 비었는지 본다.

## Helpers

전부 ESM `.mjs`, 실행 가능, 레포 루트 `pnpm lint`(eslint .)의 대상이다. 의존성은 레포의 `@playwright/test`뿐이다.

| 파일 | 호출 | 역할 |
| --- | --- | --- |
| `scripts/launch.mjs` | `node .claude/skills/verify/scripts/launch.mjs <feature>` | 증거 폴더 생성, 서버·데모 둘 띄우기, 준비 확인, run.json |
| `scripts/doctor.mjs` | `node .claude/skills/verify/scripts/doctor.mjs [--run <dir>]` | 읽기 전용 점검, doctor.json, 종료 코드 |
| `scripts/drive.mjs` | `node .claude/skills/verify/scripts/drive.mjs [--run <dir>] [--feature <id>] [--headed]` | 여정 실행, 스크린샷·trace·본문·result.json |
| `scripts/cleanup.mjs` | `node .claude/skills/verify/scripts/cleanup.mjs [--run <dir>] [--all]` | PID로만 종료, 포트 확인, 증거 보존 |
| `scripts/lib.mjs` | (import) | 오리진·포트·콘솔 키·프로세스 정의, run.json 읽기/쓰기, lsof/ps, http, waitFor, Playwright 찾기 |
| `scripts/harness.mjs` | (import) | 브라우저·요청 컨텍스트·단계 기록·증거 저장, 위젯·콘솔 도우미 |
| `scripts/journeys/*.mjs` | (drive가 로드) | 기능별 여정. 파일 이름이 feature id |

한 사이클을 그대로 적으면 이렇다.

```
pnpm build
node .claude/skills/verify/scripts/launch.mjs widget-chat
node .claude/skills/verify/scripts/doctor.mjs
node .claude/skills/verify/scripts/drive.mjs
node .claude/skills/verify/scripts/cleanup.mjs
ls .audit/evidence/<launch가 찍은 폴더>
```

## 아직 못 하는 것

- 실제 Claude 엔진(`QRATE_ENGINE=claude`), Postgres 저장소, Docker 이미지, Sentry는 검증하지 않는다. 목업·메모리에서의 동작만 증명한다.
- 인스턴스 두 개를 나란히 못 띄운다(위 Isolate).
- 요율 제한: `POST /api/handoff`는 IP당 분당 20회, 콘솔 로그인은 분당 10회. 같은 분에 드라이브를 여러 번 돌리면 429가 날 수 있다 — 그러면 1분 기다린다.
- 맵에 없는 것: 재시도 정책(`[[fail:429]]` → "다시 보내기"가 Retry-After 동안 잠김, `[[fail:401]]` → 버튼 없음), 닫기·안 읽은 배지(postMessage close/unread), 모더레이션 차단(422 → "해당 메시지는 전송할 수 없어요"), 콘솔 "더 보기" 페이지네이션. 위젯 E2E(packages/widget/e2e/widget.spec.ts)에 기대값이 있으니 다음 여정 후보다.

## 유지보수

앱이 바뀌면 맵은 바로 낡는다. 선택자·문구·시드·포트가 바뀌었으면 여정과 기능 파일을 함께 고치고, 반드시 다시 빌드한 뒤 한 사이클을 돌려 PASS를 본다. 주기적인 점검은 `/pstack:maintain-verification-skill`로 한다 — 기능 파일마다 소스를 다시 읽고, 실제 세션에서 모든 기능을 돌려, 증명된 수정만 PR 하나로 보낸다.
