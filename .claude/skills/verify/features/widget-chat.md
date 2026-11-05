# 위젯 대화

방문자가 고객 사이트의 런처를 눌러 대화창을 열고 질문하면 답변이 한 글자씩 흘러오고 끝에 출처가 붙는다. 다음 질문은 같은 대화로 이어지고, 그 대화는 운영 콘솔의 대화 로그에 메시지 전문과 함께 남는다.

## Sub-features

- `chat-launcher` 런처는 Shadow DOM에 격리돼 호스트 CSS를 받지 않고, 열기 전에는 서버에 아무 요청도 보내지 않는다.
- `chat-open` 런처를 누르면 서버 오리진의 `/frame` iframe이 열리고(응답 CSP `frame-ancestors`가 허용 목록), 대화창이 ready를 보내면 로딩 문구가 사라진다.
- `chat-stream` 질문을 보내면 답변 말풍선이 `aria-busy`로 흐르다가 끝나고, 출처 접기(출처 N건·자료 제목·인용문)가 붙는다.
- `chat-continue` 다음 질문은 첫 응답 헤더 `X-Conversation-Id`를 싣고 같은 대화로 이어진다. `/api/chat`은 iframe 문서에서만 나간다.
- `chat-logged` 대화가 콘솔 API의 대화 로그에 메시지 4건(방문자 2·AI 2)으로 저장돼 있다.
- `chat-console-ui` 운영 콘솔의 대화 로그 화면에 그 대화가 보이고, 열면 메시지 4건이 있다.
- `chat-no-errors` 정상 흐름에서 브라우저 콘솔 오류가 없다.

## How to get to it (user POV)

- 방문자: 위젯이 설치된 사이트(검증에서는 `http://localhost:5173/demo.html`)의 우하단 💬 버튼("상담 열기")을 누른다 → 머리글 "무엇을 도와드릴까요?"가 있는 대화창 → 입력창 "메시지를 입력하세요"에 질문을 적고 "전송".
- 답변 말풍선 아래 "출처 N건"을 펼치면 자료 제목과 인용문이 보인다.
- 운영자: `http://localhost:8787/console/`에서 테넌트 키 `demo`와 콘솔 키로 로그인 → 상단 "대화 로그" → 항목을 눌러 상세.

## Driving it with verify

Preconditions:

- `node .claude/skills/verify/scripts/launch.mjs widget-chat`로 띄우고 `doctor.mjs`가 `DOCTOR OK`.
- 메모리 저장소가 비어 있다(새 launch). 다른 대화가 있으면 `chat-console-ui`의 "1건" 기대가 어긋난다.
- 실행: `node .claude/skills/verify/scripts/drive.mjs` (run.json의 feature가 `widget-chat`).

- **런처 확인(`chat-launcher`).** 데모 페이지를 연다. `page.goto('http://localhost:5173/demo.html')` → `#qrate-host .launcher`가 보이고 aria-label이 "상담 열기", computed color가 `rgb(255, 0, 0)`이 아니고 font-family에 `system-ui`(호스트의 빨간 serif 전역 CSS가 닿지 않음), `#qrate-host iframe` 0개, 8787로 간 요청 0건.
- **열기(`chat-open`).** 런처를 누른다. `.launcher` 클릭 → `#qrate-host iframe.frame`의 src가 `http://localhost:8787/frame?t=demo&o=http://localhost:5173`, 그 `/frame` 응답이 200이고 CSP에 `frame-ancestors http://localhost:5173`, cache-control `no-store`, `#qrate-host .loading` 0개(ready 수신), launcher aria-expanded `true`, 프레임 안 `.title`이 "무엇을 도와드릴까요?".
- **질문·스트리밍·출처(`chat-stream`).** 질문을 보낸다. 프레임 안 `#qrate-input`에 "요금제가 뭐가 있나요?" 입력 후 `.send` 클릭 → `.msg.user` 텍스트가 질문, `.msg.bot` 첫 말풍선이 `aria-busy="true"`로 "목업 응답"을 포함하며 자라다가 `.msg.bot:not([aria-busy])` 1개. `.text`가 `목업 응답입니다. 자료 "<제목>"에 따르면: <문장>` 형식, `.sources summary`가 "출처 1건", `.source-title`이 그 <제목>, `.quote q` 1개가 그 <문장>. summary를 눌러 펼친 상태로 스크린샷.
- **이어 가기(`chat-continue`).** 두 번째 질문 "추가 인원 비용은요?"를 보낸다 → 끝난 답변 2개. 기록된 `/api/chat` 요청 2건의 요청 문서가 모두 `http://localhost:8787/frame?…`, 첫 요청의 conversationId가 null, 둘째 요청의 conversationId가 첫 응답 헤더 `X-Conversation-Id`와 같다.
- **저장 확인(`chat-logged`).** 별도 요청 컨텍스트로 `POST /api/console/login`(Origin `http://localhost:8787`, `{tenant:'demo', key:'e2e-widget-console-key'}`) 200 → `GET /api/console/conversations`에 그 id가 messageCount 4, preview에 질문 → `GET /api/console/conversations/<id>`의 messages roles가 user,assistant,user,assistant이고 답변 본문이 화면과 같다. 응답은 `console-conversations.txt`·`console-conversation-detail.txt`.
- **콘솔 화면(`chat-console-ui`).** 새 페이지로 `http://localhost:8787/console/` → `#tenant`에 `demo`, `#key`에 콘솔 키, 버튼 "로그인" → `[data-testid=tenant-name]`이 "마루인보이스" → `#/conversations`로 이동 → `[data-testid=conversation-item]` 1개에 질문과 "메시지 4" → 클릭 → `[data-testid=messages] li` 4개.
- **오류 없음(`chat-no-errors`).** 데모 페이지의 콘솔 오류 0건, 콘솔 페이지는 로그인 전 `/api/console/me`의 401 리소스 오류를 제외하고 0건.
- **Proof.** `steps.md`(단계별 관찰), `01-chat-launcher.png`~`07-chat-no-errors.png`(03은 출처가 펼쳐진 대화창, 06은 콘솔 상세의 메시지 4건), `chat-1.sse.txt`·`chat-2.sse.txt`(SSE 원문: `data: {"delta":…}` 조각들, `event: citation`, `event: done`, `data: [DONE]`, 헤더 `x-conversation-id`), `network.jsonl`, `trace.zip`, `result.json`.

## Gotchas

- 목업의 인용은 "그 요청에 들어간 지식 중 id 오름차순 첫 항목"의 첫 블록이다(apps/server/src/repo/knowledge-order.ts). 시드에서는 `faq:annual-billing` "연간 결제 할인"이라 질문이 무엇이든 같은 출처가 붙는다. 질문으로 출처를 단정하지 말고, 답변 본문의 제목과 출처 접기의 제목이 같은지로 본다.
- 목업은 글자당 20ms — 답 하나에 2~3초. 하네스의 expect 시간은 10초다. 고정 sleep을 두지 말고 `.msg.bot:not([aria-busy])` 개수를 기다린다.
- 대화창 하나는 대화 하나를 이어 간다(conversationId를 보존). 새 대화가 필요하면 데모 페이지를 새로 연다.
- `/api/chat` 응답 본문은 CDP `response.text()`로 못 읽는다(위젯이 스트림을 다 읽고 취소한다). 하네스가 페이지 안에서 복제본을 읽어 `chat-N.sse.txt`로 남기므로 여정에서 직접 읽지 않는다.
- 출처 접기(`details`)는 기본 접힘이다. 스크린샷에 인용문을 보이려면 `summary`를 클릭한다.
- 실제 모델(`QRATE_ENGINE=claude`)에서는 문장·출처 수가 달라 이 여정의 기대값이 맞지 않는다. 이 스킬은 목업만 드라이브한다.
