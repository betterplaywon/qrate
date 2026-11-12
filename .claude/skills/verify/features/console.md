# 운영 콘솔

운영자는 서버가 서빙하는 `/console/`에 테넌트 키와 콘솔 키로 로그인해, 위젯에서 온 대화의 로그와 전문을 보고, 상담원 연결 요청을 미응답 큐에서 열림·처리 중·완료로 옮긴다. 세션은 HttpOnly 쿠키이고 로그아웃하면 끊긴다.

## Sub-features

- `console-document` `/console/` 문서가 CSP `default-src 'self'; frame-ancestors 'none'; base-uri 'none'`와 `cache-control: no-cache`로 내려오고, 로그인 전 콘솔 API는 401이다.
- `console-login-wrong` 틀린 콘솔 키는 "테넌트 키 또는 콘솔 키가 맞지 않아요." 안내를 보인다.
- `console-login` 맞는 키로 로그인하면 머리글에 테넌트 이름이 보이고, 첫 화면은 시작하기(새 launch라 설치 신호가 없어 "4단계 중 2단계 끝")이며, 큐와 대화 로그가 비어 있고, 브라우저의 세션 쿠키로 `/api/console/me`가 200이다.
- `console-seed-demo-plain`·`console-seed-demo-signal` 위젯에서 대화 2건을 만든다(두 번째는 모델 신호).
- `console-conversations` 대화 로그를 새로 고치면 2건이 최근순으로 보이고, 신호가 난 대화를 열면 메시지 2건과 "모델 신호" 연결 요청이 있다.
- `console-queue-move` 미응답 큐(열림)의 1건을 "처리 중"으로 옮기면 열림 탭에서 빠지고 처리 중 탭에 보이며, API로 읽어도 `in_progress`다.
- `console-logout` 로그아웃하면 로그인 폼으로 돌아가고 세션 쿠키로도 `/api/console/me`가 401이다.
- `console-no-errors` 401 리소스 오류 외의 브라우저 콘솔 오류가 없다.

## How to get to it (user POV)

- `http://localhost:8787/console/` → 테넌트 키 `demo`, 콘솔 키(검증에서는 `e2e-widget-console-key`) → "로그인".
- 머리글 메뉴 "미응답 큐"(`#/queue/open`, 탭 열림·처리 중·완료) / "대화 로그"(`#/conversations`) → 항목 클릭으로 상세(`#/conversations/<id>`). 큐 카드의 "→ 대화 보기" 링크로도 상세로 간다.
- 머리글 오른쪽 "로그아웃".

## Driving it with verify

Preconditions:

- `node .claude/skills/verify/scripts/launch.mjs console`로 띄우고 `doctor.mjs`가 `DOCTOR OK`.
- 큐와 대화 로그가 비어 있다(새 launch). 이 여정이 빈 상태를 먼저 확인하고 대화를 만든다.
- 콘솔 로그인은 IP당 분당 10회 — doctor(1회)와 이 여정(2회)을 합쳐도 넉넉하지만, 같은 분에 반복하지 않는다.
- 실행: `node .claude/skills/verify/scripts/drive.mjs`.

- **문서와 비로그인 API(`console-document`).** 별도 요청 컨텍스트로 `GET /console/` → 200, CSP가 정확히 `default-src 'self'; frame-ancestors 'none'; base-uri 'none'`, cache-control `no-cache`; `GET /api/console/me` → 401. 응답은 `console-document.txt`.
- **틀린 키(`console-login-wrong`).** 브라우저로 `http://localhost:8787/console/` → `#tenant`에 `demo`, `#key`에 `wrong-key`, 버튼 "로그인" → `getByRole('alert')`에 "맞지 않아요".
- **로그인(`console-login`).** `#key`에 콘솔 키로 다시 "로그인" → `[data-testid=tenant-name]` "마루인보이스", `[data-testid=start-progress]` "4단계 중 2단계 끝"(해시가 빈 첫 화면은 시작하기 네 단계가 끝나기 전까지 시작하기다) → `#/queue/open`으로 이동 → `[data-testid=queue-empty]` 보임 → `#/conversations`로 이동 → `[data-testid=conversations-empty]` 보임 → `page.request.get('/api/console/me')` 200(브라우저 쿠키 사용).
- **대화 만들기(`console-seed-demo-plain`, `console-seed-demo-signal`).** 데모 페이지를 두 번 새로 열어 각각 대화창을 열고 "요금제가 어떻게 되나요?", "[[handoff]] 카카오톡으로 알림 받을 수 있나요?"를 보내 끝난 답변 1개씩을 본다(대화창 하나가 대화 하나이므로 페이지를 나눈다).
- **대화 로그·상세(`console-conversations`).** 콘솔 페이지를 `reload` → `[data-testid=conversation-item]` 2개, 첫 항목에 "카카오톡으로 알림"과 "연결 요청 1" → 클릭 → `[data-testid=messages] li` 2개, `[data-testid=detail-handoffs]`에 "모델 신호".
- **큐 상태 이동(`console-queue-move`).** `#/queue/open` → `[data-testid=queue-item]` 1개에 "카카오톡으로 알림" → 그 안의 `[data-testid=move-in_progress]` 클릭 → `[data-testid=queue-empty]` 보임 → `[data-testid=tab-in_progress]` 클릭 → `queue-item` 1개, `[data-testid=status]` "처리 중" → `page.request.get('/api/console/handoffs?status=in_progress')`의 items 1건이 status `in_progress`, source `model`. 응답은 `console-handoffs-in_progress.txt`.
- **로그아웃(`console-logout`).** 버튼 "로그아웃" 클릭 → 버튼 "로그인" 보임 → `page.request.get('/api/console/me')` 401.
- **오류 없음(`console-no-errors`).** 콘솔 페이지 오류 0건(로그인 전 `/me`와 틀린 키의 401 리소스 오류는 제외).
- **Proof.** `steps.md`, `02-console-login-wrong.png`~`09-console-no-errors.png`(1단계는 API만이라 스크린샷이 없다. 02: 경고 문구, 06: 대화 상세, 07: 처리 중 탭), `console-document.txt`, `console-handoffs-in_progress.txt`, `chat-1.sse.txt`·`chat-2.sse.txt`, `trace.zip`.

## Gotchas

- 로그인 전·틀린 키의 401은 브라우저가 "Failed to load resource: … 401" 콘솔 오류로 찍는다. 하네스는 `/status of 401/`에 맞는 줄만 무시한다. 다른 4xx·5xx는 오류로 센다.
- 세션 쿠키는 `Path=/api/console`, HttpOnly, SameSite=Strict다. 브라우저 컨텍스트의 `page.request`만 그 쿠키를 싣고, 별도 `h.api`는 자기 로그인이 필요하다.
- 대화 로그는 최근 시작순이다. "첫 항목 = 마지막에 만든 대화"에 기대므로 대화를 만드는 순서를 바꾸면 기대값도 바뀐다.
- 상태 이동 버튼은 현재 상태를 뺀 나머지만 보인다(`move-in_progress`, `move-done`, …). 전이 제한은 없어 되돌리기도 같은 버튼이다.
- 화면 상태는 해시 라우팅이라 `goto('/console/#/queue/open')`처럼 해시로 이동한다. 서버에 SPA 폴백은 없어 `/console/queue` 같은 경로는 404다.
- 서버를 재시작하면 세션이 끊긴다(검증 인스턴스는 `QRATE_CONSOLE_SECRET`을 고정하지만 메모리 저장소의 대화는 사라진다).
