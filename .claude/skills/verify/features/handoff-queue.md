# 상담원 연결 접수

방문자는 언제든 사람에게 연결을 요청할 수 있다. 모델이 "자료에 없는 질문"이라고 신호하면 안내 답변 뒤에 연결 제안이 붙고, 머리글의 "상담원 연결" 버튼은 질문 전에도 열린다. 어느 쪽이든 이메일과 남길 말을 적어 보내면 접수 안내가 남고, 운영 콘솔의 미응답 큐에 방문자 요청으로 들어간다. 모델 신호 자체도 같은 큐에 모델 신호로 들어간다.

## Sub-features

- `handoff-offer` 모델이 신호한 턴은 안내 답변(출처 없음) 뒤에 "상담원에게 연결해 드릴까요?" 안내와 "상담원 연결" 버튼이 붙는다.
- `handoff-submit` 제안 버튼 → 연락처 폼에 이메일·메모를 적어 보내면 `POST /api/handoff`가 201이고 "접수됐어요" 안내가 남으며 폼이 사라진다. 접수는 신호가 난 그 대화에 붙는다.
- `handoff-header` 머리글 "상담원 연결"은 질문 전에도 폼을 연다. "취소"하면 폼이 사라지고, 다시 열어 이메일만 보내도 201로 접수되며 서버가 새 대화를 만든다.
- `handoff-then-chat` 접수 뒤의 질문은 서버가 만든 그 대화 id로 간다.
- `handoff-queued` 콘솔 API의 미응답 큐(open)에 방문자 요청 2건(연락처·메모·대화 미리보기)과 모델 신호 1건이 있다.
- `handoff-console-ui` 운영 콘솔의 미응답 큐 화면에 그 3건이 "방문자 요청"·"모델 신호" 배지와 연락처와 함께 보인다.
- `handoff-no-errors` 정상 흐름에서 브라우저 콘솔 오류가 없다.

## How to get to it (user POV)

- 대화창에서 모델이 자료에 없다고 답한 턴 아래의 "상담원 연결" 버튼(검증에서는 질문 앞에 `[[handoff]]`를 붙여 목업이 신호하게 한다).
- 대화창 머리글 오른쪽의 "상담원 연결" 버튼 — 질문 전·후 언제나.
- 운영자: `http://localhost:8787/console/` 로그인 → 상단 "미응답 큐" → 탭 "열림".

## Driving it with verify

Preconditions:

- `node .claude/skills/verify/scripts/launch.mjs handoff-queue`로 띄우고 `doctor.mjs`가 `DOCTOR OK`.
- 큐가 비어 있다(새 launch). `handoff-queued`가 "3건"을 기대한다.
- `POST /api/handoff`는 IP당 분당 20회 — 같은 분에 여러 번 돌리지 않는다.
- 실행: `node .claude/skills/verify/scripts/drive.mjs`.

- **신호와 제안(`handoff-offer`).** 데모 페이지 A에서 런처를 눌러 대화창을 열고 `#qrate-input`에 "[[handoff]] 카카오톡으로 청구서 알림을 보낼 수 있나요?" 입력, `.send` 클릭 → `.msg.bot:not([aria-busy])` 1개, 그 `.text`에 "안내 자료에 없어요", `.sources` 0개, 마지막 `.msg.notice`에 "상담원에게 연결해 드릴까요?"와 `.notice-action` 텍스트 "상담원 연결".
- **접수(`handoff-submit`).** 그 `.notice-action` 클릭 → `.handoff-form` 보임 → `#qrate-contact`에 `visitor@example.com`, `#qrate-handoff-message`에 "전화 주세요" 입력 → `.handoff-form button[type="submit"]` 클릭 → `POST /api/handoff` 응답 201이고 본문 `{id, conversationId}`의 conversationId가 이 대화의 `X-Conversation-Id`와 같다 → 마지막 `.msg.notice`에 "접수됐어요", `.handoff-form` 0개.
- **머리글 버튼(`handoff-header`).** 데모 페이지 B를 새로 열고 대화창을 연다. `.handoff` 클릭 → `.handoff-form` 보임 → `.cancel` 클릭 → 폼 0개 → `.handoff` 다시 클릭 → `#qrate-contact`에 `early@example.com`만 입력 → submit → 201, 응답의 conversationId를 기억 → "접수됐어요".
- **접수 뒤 질문(`handoff-then-chat`).** B에서 "환불되나요?" 전송 → `POST /api/chat` 요청 본문의 conversationId가 방금 접수의 conversationId와 같다 → 끝난 답변 1개.
- **큐 확인(`handoff-queued`).** 별도 요청 컨텍스트로 콘솔 로그인 → `GET /api/console/handoffs?status=open` → items 3건: source `visitor`·contact `visitor@example.com`·summary "전화 주세요"·preview에 "카카오톡"·conversationId가 A의 대화, source `visitor`·contact `early@example.com`·conversationId가 B의 접수 대화·preview에 "환불되나요?", source `model`·reason `not_in_knowledge`·conversationId가 A의 대화. 응답은 `console-handoffs-open.txt`.
- **콘솔 화면(`handoff-console-ui`).** 새 페이지로 `/console/` 로그인(`#tenant` demo, `#key` 콘솔 키, "로그인") → `[data-testid=tenant-name]` "마루인보이스" → `#/queue/open` → `[data-testid=queue-item]` 3개, `[data-testid=queue-list]`에 "방문자 요청", `visitor@example.com`, `early@example.com`, "모델 신호".
- **오류 없음(`handoff-no-errors`).** 데모 A·B 콘솔 오류 0건, 콘솔 페이지는 로그인 전 401을 제외하고 0건.
- **Proof.** `steps.md`, `01-handoff-offer.png`~`07-handoff-no-errors.png`(02: "접수됐어요" 안내, 06: 큐 화면 3건), `chat-N.sse.txt`(`event: handoff` 포함), `handoff-N.json.txt`(201 본문), `console-handoffs-open.txt`, `trace.zip`.

## Gotchas

- `[[handoff]]`는 목업 훅이다. 목업은 안내 문장만 답하고 인용 없이 `event: handoff`(reason `not_in_knowledge`, summary "목업: 자료에 없는 질문")를 보낸다. 실제 모델은 도구 호출로 신호하며 문장이 다르다.
- 제안 버튼은 누르면 사라진다(`.notice-action`은 한 번만). 폼을 닫았다가 다시 열려면 머리글 `.handoff`를 쓴다.
- 폼은 한 번에 하나만 열린다. 이미 열려 있으면 머리글 버튼은 그 폼으로 초점만 옮긴다.
- 이메일이 아니면 서버가 400 `invalid_contact` → 폼은 남고 "이메일 주소를 확인해 주세요." 오류 문구가 보인다. 입력의 `type="email"`·`required` 때문에 브라우저가 먼저 막을 수도 있으니 유효한 주소만 쓴다.
- 방문자 요청의 reason은 서버가 `needs_human`으로 고정한다(콘솔 배지 "사람이 처리할 요청"). 모델 신호의 reason은 `not_in_knowledge`("자료에 없는 질문").
- 큐는 최근순이다. 3건 중 특정 항목은 순서가 아니라 source·contact로 찾는다.
- 접수 요율 제한(분당 20회/IP)에 걸리면 429 → 폼에 "요청이 너무 많아요." 이 여정은 2회만 보낸다.
