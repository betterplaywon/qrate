# 콘솔 지표

운영자는 콘솔의 "지표" 화면에서 최근 7일의 첫 응답 시간(p50·p95와 표본 수), 자동 해결률(답이 있고 상담원 연결 요청이 없는 대화 / 기간 안에 시작해 질문이 있었던 대화), 위젯 열림 수(방문자 브라우저 보고, 페이지 로드당 첫 열림)를 본다. 숫자는 방문자의 실제 행동에서 온다: 위젯을 처음 열면 대화창이 열림 사건을 보내고, 질문마다 서버가 요청 사건을 남기며, 해결률은 대화와 상담원 연결 기록에서 센다.

## Sub-features

- `metrics-widget-open` 데모 페이지에서 위젯을 열면 대화창 문서가 `POST /api/events` `{"tenant":"demo","type":"widget_open"}`을 한 번 보내고 202를 받는다.
- `metrics-answer` 질문 하나를 보내 답을 끝까지 받는다(연결 제안 없음).
- `metrics-reopen` 닫았다 다시 열어도 열림 사건은 더 나가지 않는다.
- `metrics-handoff-only` 다른 페이지 로드에서 위젯을 열고(열림 사건 하나 더) 질문 없이 머리글 "상담원 연결"로 연락처만 남긴다.
- `metrics-console` 콘솔 `#/metrics`에 표본 1건(p50 = p95), 자동 해결 1/1건 = 100.0%, 위젯 열림 2회가 보이고, `GET /api/console/metrics`도 같은 값이다.
- `metrics-handoff-excluded` 연결만 요청한 대화는 대화 로그(`GET /api/console/conversations`)에는 있지만 해결률 분모에는 없다.
- `metrics-server-log` server.log에 사건 JSON 줄이 `chat_request` 1줄(outcome done, ttftMs = 화면의 p50, 질문 원문 없음)과 `widget_open` 2줄로 남는다.
- `metrics-no-errors` 세 페이지 모두 브라우저 콘솔 오류가 없다.

## How to get to it (user POV)

- 방문자: `http://localhost:5173/demo.html`의 런처("상담 열기")를 누르면 그 순간이 열림 하나다. 질문을 보내거나 머리글 "상담원 연결"로 연락처를 남긴다.
- 운영자: `http://localhost:8787/console/`에 테넌트 키 `demo`와 콘솔 키로 로그인 → 머리글 메뉴 "지표"(`#/metrics`).
- API: `GET /api/console/metrics`(세션 쿠키 필요).

## Driving it with verify

Preconditions:

- `node .claude/skills/verify/scripts/launch.mjs metrics`로 새로 띄우고 `doctor.mjs`가 `DOCTOR OK`. 메모리 저장소가 비어 있어야 절대값이 맞는다 — 다른 여정 뒤에 같은 인스턴스로 돌리지 않는다.
- server.log는 launch가 만든 증거 폴더에 있어야 한다(`--feature metrics`로 다른 실행 폴더에서 돌리면 `metrics-server-log`가 실패한다).
- 실행: `node .claude/skills/verify/scripts/drive.mjs`.

- **열기(`metrics-widget-open`).** `openWidget`(데모 → `#qrate-host .launcher` 클릭 → 로딩 문구 사라짐) → `POST http://localhost:8787/api/events` 1건, 응답 202, 요청 문서가 `http://localhost:8787/frame?…`, 본문 `{"tenant":"demo","type":"widget_open"}`.
- **답 받기(`metrics-answer`).** 프레임 `#qrate-input`에 "요금제가 뭐가 있나요?" → `.send` → `.msg.bot:not([aria-busy])` 1개, `.msg.notice` 0개.
- **다시 열기(`metrics-reopen`).** 프레임 `.close` → 런처 aria-expanded `false` → 런처 클릭 → `true`, 프레임 `#qrate-input` 포커스 → 열림 사건 여전히 1건.
- **연결만(`metrics-handoff-only`).** 새 페이지로 데모를 다시 열어 위젯 열기(열림 사건 202) → 프레임 `.handoff` → `#qrate-contact`에 `metrics@example.com` → `.handoff-form button[type="submit"]` → `POST /api/handoff` 201, 마지막 `.msg.notice`에 "접수됐어요".
- **지표 화면(`metrics-console`).** 콘솔 로그인 → `[data-testid=nav-metrics]` 클릭 → URL `#/metrics`, `[data-testid=metrics-window]`에 "최근 7일", `metric-ttft-samples` "1", `metric-ttft-p50`이 `^[\d,]+ms$`이고 `metric-ttft-p95`와 같은 글자, `metric-resolution-resolved` "1", `metric-resolution-conversations` "1", `metric-resolution-rate` "100.0%", `metric-widget-opens` "2" → `page.request.get('/api/console/metrics')`가 `no-store`이고 ttft `{ samples: 1, p50Ms: <화면 값>, p95Ms: <화면 값> }`, autoResolution `{ conversations: 1, resolved: 1, rate: 1 }`, widget `{ opens: 2 }`. 응답은 `console-metrics.txt`.
- **연결만 요청한 대화 제외(`metrics-handoff-excluded`).** `page.request.get('/api/console/conversations')`의 대화 2건이 (메시지 2·연결 요청 0), (메시지 0·연결 요청 1)이고 화면의 `metric-resolution-conversations`는 여전히 "1". 응답은 `console-conversations.txt`.
- **로그 대조(`metrics-server-log`).** 증거 폴더의 `server.log`에서 `{"type":`로 시작하는 줄을 JSON으로 읽는다 → `chat_request` 1줄(payload.outcome `done`, ttftMs = 화면의 p50), `widget_open` 2줄, 파일 어디에도 질문 원문 없음. 브라우저가 보낸 `POST /api/events`는 모두 2건.
- **오류 없음(`metrics-no-errors`).** 방문자 두 페이지와 콘솔 페이지의 콘솔 오류 0건(로그인 전 `/me`의 401 리소스 오류는 제외).
- **Proof.** `steps.md`, `01-metrics-widget-open.png`~`08-metrics-no-errors.png`(05: 지표 화면), `console-metrics.txt`, `console-conversations.txt`, `chat-1.sse.txt`, `handoff-1.json.txt`, `server.log`, `network.jsonl`(`/api/events` 202 두 줄), `trace.zip`.

## Gotchas

- 열림은 페이지 로드당 한 번이다. 같은 페이지에서 닫았다 다시 여는 것은 세지 않고, 새로 고치거나 새 페이지로 열면 하나 더 센다.
- TTFT 표본은 첫 답변 조각을 실제로 보낸 요청만이다. 차단(422)·크레딧 부족(402)은 사건 자체가 남지 않고, 첫 조각 전 실패는 사건은 남지만 표본이 아니다. 표본이 1건이면 p50과 p95가 같은 값이다(nearest-rank).
- 해결률의 분모는 기간 안에 시작해 질문이 있었던 대화다. 질문 없이 연결만 요청한 대화는 대화 로그에는 보이지만 분모·분자 어디에도 들지 않는다. 질문이 있는 대화에 연결 요청이 있으면 상태(열림·완료)와 상관없이 해결이 아니다.
- server.log의 사건 줄은 서버가 `NODE_ENV`가 production이 아닐 때만 찍는다. 이 스킬의 서버는 `NODE_ENV` 없이 뜨므로 찍힌다.
- 위젯 사건은 `POST /api/events`에 IP당 분당 30회 제한이 있다. 같은 분에 여정을 여러 번 돌려도 넘지 않는다.
