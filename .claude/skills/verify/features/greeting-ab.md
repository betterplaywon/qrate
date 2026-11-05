# 인사말 A/B

방문자가 위젯 대화창을 처음 열면 대화 맨 위에 인사말 하나가 보인다. 인사말은 둘이고 서버가 방문자마다 하나를 정한다. 같은 방문자는 다시 와도 같은 인사말을 본다. 런처가 서버의 배정(변형 id)을 고객 사이트의 localStorage에 두었다가 다음 페이지 로드에 대화창 주소의 `v=`로 돌려주기 때문이다. 대화창은 그 페이지 로드의 첫 열림과 첫 질문 사건에 화면에 보인 인사말의 변형을 싣고, 운영자는 콘솔 "지표"에서 인사말별로 노출(인사말이 보인 페이지 로드의 첫 열림)과 그 페이지 로드의 첫 질문을 비교한다.

## Sub-features

- `greeting-first-visit` 빈 브라우저로 위젯을 열면 `GET /api/greeting?tenant=demo`(변형 없음)가 200 `no-store`로 배정을 돌려주고, 그 문구가 대화 맨 위 `.msg.greeting`에 보이며, 데모 사이트 localStorage `qrate.greeting.demo`에 그 변형 id가 남고, `widget_open` 사건이 같은 변형을 싣는다.
- `greeting-sticky` 다시 로드해 열면 iframe src에 `v=<그 변형>`이 붙고, 같은 인사말을 본다.
- `greeting-question` 질문을 보내면 `first_question` 사건이 같은 변형을 싣고, 답변은 인사말 아래에 붙는다.
- `greeting-other-variant` 다른 변형을 보존한 재방문자(localStorage에 그 id)는 그 변형의 인사말을 본다.
- `greeting-tampered` 지금 실험에 없는 보존값(`greet-old.z`)은 `v=`로 넘어가지만 서버가 새로 배정하고 런처가 덮어쓴다.
- `greeting-console` 콘솔 `#/metrics`의 "인사말 A/B" 표에서 변형별 노출·첫 질문이 브라우저가 보낸 사건을 변형별로 센 값과 같고, `GET /api/console/metrics`의 `greeting`도 같으며, 실험 밖 열림·첫 질문은 0이다.
- `greeting-server-log` server.log의 `widget_open`·`first_question` 줄을 변형별로 센 값이 브라우저가 보낸 사건과 같다.
- `greeting-no-errors` 방문자 페이지와 콘솔 페이지 모두 브라우저 콘솔 오류가 없다.

## How to get to it (user POV)

- 방문자: `http://localhost:5173/demo.html`의 런처("상담 열기")를 누른다. 다시 오는 방문자는 같은 페이지를 다시 연다.
- 운영자: `http://localhost:8787/console/`에 테넌트 키 `demo`와 콘솔 키로 로그인 → 머리글 메뉴 "지표"(`#/metrics`) → "인사말 A/B" 표.
- API: `GET /api/greeting?tenant=demo&variant=<보존된 변형 id>`(대화창이 부른다, 같은 오리진 검사), `GET /api/console/metrics`의 `greeting`(세션 쿠키 필요).

## Driving it with verify

Preconditions:

- `node .claude/skills/verify/scripts/launch.mjs greeting-ab`로 새로 띄우고 `doctor.mjs`가 `DOCTOR OK`. 메모리 저장소가 비어 있어야 콘솔의 수가 관찰한 사건과 같다. 다른 여정 뒤에 같은 인스턴스로 돌리지 않는다.
- 하네스의 브라우저 컨텍스트가 하나라 여정의 모든 페이지 로드가 같은 방문자(같은 localStorage)다.
- 실행: `node .claude/skills/verify/scripts/drive.mjs`.

- **처음 방문(`greeting-first-visit`).** `openWidget` → `GET http://localhost:8787/api/greeting?tenant=demo` 200, cache-control `no-store`, 본문 `{"greeting":{"variant":X,"text":T}}`. iframe src에 `v` 없음. 프레임 `.msgs > .msg` 첫 요소가 `.msg.greeting`이고 글자가 T, `.title`은 "무엇을 도와드릴까요?" 그대로. 데모 페이지 `localStorage.getItem('qrate.greeting.demo')` = X. `POST /api/events` 202, 본문 `{"tenant":"demo","type":"widget_open","variant":X}`.
- **다시 로드(`greeting-sticky`).** `openWidget`(같은 페이지에서 다시 이동) → iframe src `v=X`, `GET /api/greeting?tenant=demo&variant=X` → X·T, `.msg.greeting` T, 열림 사건 변형 X.
- **첫 질문(`greeting-question`).** 프레임 `#qrate-input`에 "요금제가 뭐가 있나요?" → `.send` → `POST /api/events` 202 `{"tenant":"demo","type":"first_question","variant":X}` → `.msg.bot:not([aria-busy])` 1개, `.msg.greeting` 1개이고 맨 위.
- **다른 변형(`greeting-other-variant`).** `h.api`로 콘솔 로그인 → `GET /api/console/metrics`의 `greeting.variants`에서 X가 아닌 변형 Y(id·문구) → 데모 페이지 localStorage에 Y를 넣고 `openWidget` → iframe src `v=Y`, 배정 Y, `.msg.greeting` = Y의 문구, 열림 사건 변형 Y. 응답은 `console-metrics-variants.txt`.
- **지금 실험에 없는 보존값(`greeting-tampered`).** localStorage에 `greet-old.z` → `openWidget` → 요청 `variant=greet-old.z`, 배정은 지금 실험의 변형 Z, localStorage가 Z로 바뀜, 열림 사건 변형 Z.
- **콘솔(`greeting-console`).** 콘솔 로그인 → `[data-testid=nav-metrics]` → 변형마다 `metric-greeting-<id>`에 이름, `metric-greeting-exposures-<id>` = 그 변형을 실은 `widget_open` 수, `metric-greeting-first-questions-<id>` = 그 변형을 실은 `first_question` 수, `metric-greeting-outside-opens`·`metric-greeting-outside-questions` "0", `metric-widget-opens` = 열림 사건 수(4). `page.request.get('/api/console/metrics')`의 `greeting.variants[]`가 같은 수이고 `rate` = 첫 질문/노출(노출 0이면 null), `outside` `{ opens: 0, questions: 0 }`. 응답은 `console-metrics.txt`.
- **로그 대조(`greeting-server-log`).** 증거 폴더 `server.log`의 `{"type":` 줄 중 `widget_open`·`first_question`을 (종류, 변형)으로 센 목록 = 브라우저가 보낸 `POST /api/events` 본문의 목록(열림 4·첫 질문 1).
- **오류 없음(`greeting-no-errors`).** 방문자·콘솔 페이지의 콘솔 오류 0건(로그인 전 `/me`의 401 리소스 오류는 제외).
- **Proof.** `steps.md`, `01-greeting-first-visit.png`~`08-greeting-no-errors.png`(01: 인사말이 보이는 대화창, 06: 콘솔 인사말 A/B 표), `console-metrics-variants.txt`, `console-metrics.txt`, `chat-1.sse.txt`, `server.log`, `network.jsonl`(`/api/greeting` 4줄, `/api/events` 202 다섯 줄), `trace.zip`.

## Gotchas

- 첫 방문의 변형은 무작위다. 특정 변형을 기대하지 말고 `GET /api/greeting` 응답에서 관찰한 값으로 단언한다. 특정 변형이 필요하면 방문자 브라우저의 localStorage를 만든다(서버에 테스트 전용 스위치는 없다).
- 열림 사건은 인사말 요청이 끝난 뒤(최대 3초)에 나간다. 런처를 누른 직후가 아니라 `/api/events` 요청을 기다린다.
- 첫 질문이 인사말보다 먼저 나가면 그 페이지 로드는 인사말을 그리지 않고 두 사건 모두 변형 없이 나간다(실험 밖). 질문은 인사말이 보인 뒤에 보낸다.
- 인사말 말풍선은 `.msg.greeting`이고 `.msg.bot`이 아니다. 끝난 답변 수(`.msg.bot:not([aria-busy])`)에 들지 않는다.
- 콘솔의 수는 페이지 로드(노출) 단위다. 같은 방문자의 재방문은 노출을 하나 더 만든다.
- 위젯 사건은 `POST /api/events`에 IP당 분당 30회 제한이 있다. 이 여정은 5건을 보낸다.
