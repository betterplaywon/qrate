# 허용되지 않은 오리진 차단

어느 사이트가 이 테넌트의 대화창을 넣을 수 있는지는 테넌트의 허용 목록이 정한다. 허용 목록 밖의 사이트에서는 서버가 대화창 대신 안내 문서를 주고, 브라우저도 CSP `frame-ancestors` 위반으로 프레임을 그리지 않아 런처의 로딩 문구가 그대로 남는다. 허용된 사이트에서는 같은 동작으로 대화창이 열린다.

## Sub-features

- `origin-server-403` 서버는 허용 목록 밖의 `o`(5174)나 `o` 없음에 403 안내 문서(스크립트 없음)를 주고, CSP는 허용 목록 그대로 내린다. `t` 없음은 400, 모르는 `t`는 404.
- `origin-browser-blocked` 허용 목록 밖 포트(5174)의 데모에서 런처를 누르면 iframe이 `o=http://localhost:5174`로 `/frame`을 요청해 403을 받고, 브라우저가 CSP 위반으로 프레임을 거부해 로딩 문구가 남는다.
- `origin-browser-allowed` 대조군: 허용 오리진(5173)에서는 대화창이 열리고 로딩 문구가 사라진다.
- `origin-errors-scoped` 차단된 페이지의 콘솔 오류는 CSP 위반·403 리소스 오류뿐이고, 허용 페이지에는 오류가 없다.

## How to get to it (user POV)

- 허용 목록에 없는 사이트에 설치 스니펫을 넣고 런처를 누른다(검증에서는 같은 데모를 `http://localhost:5174/demo.html`에서 연다). 패널에 "상담 창을 불러오는 중…"만 남는다.
- 대화창 주소를 직접 연다: `http://localhost:8787/frame?t=demo`(o 없음) → "이 사이트에서는 상담 창을 열 수 없어요. 사이트 운영자에게 알려 주세요."
- 허용된 사이트 `http://localhost:5173/demo.html`에서는 정상으로 열린다.

## Driving it with verify

Preconditions:

- `node .claude/skills/verify/scripts/launch.mjs origin-guard`로 띄우고 `doctor.mjs`가 `DOCTOR OK`(doctor도 5174에 403을 확인한다).
- 시드의 allowedOrigins가 `http://localhost:5173`·`http://127.0.0.1:5173`뿐이다.
- 실행: `node .claude/skills/verify/scripts/drive.mjs`.

- **서버 응답(`origin-server-403`).** 요청 컨텍스트로 `GET /frame?t=demo&o=http://localhost:5174` → 403, CSP에 `frame-ancestors http://localhost:5173`, 본문에 "이 사이트에서는 상담 창을 열 수 없어요"가 있고 `app.js`는 없다(`frame-denied.txt`); `GET /frame?t=demo` → 403; `GET /frame` → 400 `{"error":"tenant is required"}`; `GET /frame?t=nope&o=http://localhost:5173` → 404 `{"error":"unknown_tenant"}`.
- **브라우저 차단(`origin-browser-blocked`).** `page.goto('http://localhost:5174/demo.html')` → `#qrate-host .launcher` 클릭 → `#qrate-host iframe.frame`의 src 쿼리 `o`가 `http://localhost:5174` → 그 `/frame` 응답 403 → 10초 안에 페이지 콘솔 오류에 `frame-ancestors`를 포함한 줄 → `#qrate-host .loading`이 보이고 텍스트 "상담 창을 불러오는 중…".
- **대조군(`origin-browser-allowed`).** 새 페이지로 `http://localhost:5173/demo.html` → 런처 클릭 → `.loading` 0개, 프레임 안 `.title` "무엇을 도와드릴까요?".
- **오류 범위(`origin-errors-scoped`).** 차단 페이지의 콘솔 오류가 1건 이상이고 전부 `frame-ancestors` 또는 `403`을 포함, 허용 페이지는 0건.
- **Proof.** `steps.md`, `02-origin-browser-blocked.png`~`04-origin-errors-scoped.png`(1단계는 API만이라 스크린샷이 없다. 02: 로딩 문구가 남은 패널, 03: 열린 대화창), `frame-denied.txt`, `browser-console.log`(CSP 위반 줄), `network.jsonl`(403), `trace.zip`.

## Gotchas

- "허용되지 않은 사이트"는 네트워크 가로채기로 꾸미지 않는다 — Chromium이 꾸민 오리진을 공개 주소로 보고 로컬 네트워크 접근 검사로 먼저 막아 서버·CSP 검사를 볼 수 없다. 그래서 같은 데모를 5174에서 실제로 한 번 더 서빙한다(launch가 띄운다).
- 403 문서는 CSP를 그대로 달고 온다(`frame-ancestors`가 곧 허용 목록). 상태 코드만 보지 말고 본문에 `app.js`가 없는 것까지 본다.
- 차단된 iframe은 문서가 그려지지 않아 `frameLocator`로 들어갈 수 없다. 증거는 런처 쪽(`.loading`)과 콘솔 오류, 네트워크 403으로 잡는다.
- 이 여정은 콘솔 오류를 일부러 센다(`ignoreConsole` 없음). 여기서 `h.errorsOf(page)`가 비어 있으면 CSP가 작동하지 않은 것이다.
- `file://`로 연 데모는 오리진이 `null`이라 같은 이유로 막힌다 — 검증은 항상 http 오리진에서 한다.
