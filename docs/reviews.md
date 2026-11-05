# AI 코드 리뷰 기록

AI 에이전트가 생성한 코드에서 **실제로 발견한** 버그·보안 결함·설계 이탈만 기록한다.
없는 사례를 만들지 않는다 — 이 파일이 "AI 생성 코드를 어떻게 검증했는가"의 근거가 되려면
진짜여야 한다. PR 템플릿의 "리뷰에서 잡은 것" 항목과 연동.

**기록 규칙: 내가 직접 원인을 이해하고 재현·설명할 수 있는 것만 "내 사례"로 쓴다.**
AI가 스스로 잡은 것은 참고용으로 (AI) 표시하고 면접에서 내 성과로 말하지 않는다.

| 날짜 | 위치 | 발견한 문제 | 심각도 | 발견 주체 | 수정 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-30 | packages/widget/src/index.ts | `document.currentScript`를 DOMContentLoaded 콜백 안에서 읽으면 null → data-endpoint/tenant 설정이 조용히 기본값으로 떨어짐. 스크립트 평가 시점에 즉시 캡처해야 함 | 중 | (AI, 스캐폴드 생성 중) — 본인이 원인을 설명할 수 있게 되면 학습 사례로 전환 | 모듈 최상위에서 `CONFIG` 캡처 |
| 2026-10-30 | apps/server/src/chat.ts | `req.on('close')`로 스트리밍 타이머를 정리했는데, 최신 Node에서 req의 'close'는 "요청 본문 수신 완료" 시점에 발생 → 응답 토큰이 한 글자도 나가기 전에 타이머가 정리되어 **SSE가 즉시 멈추는** 버그. 타입체크·단위테스트는 전부 통과했고, 실제 curl 스모크 테스트에서만 드러남 | 상 | (AI 작성 코드, 스모크 테스트로 발견) — "테스트가 녹색이어도 통합 경로는 직접 쏴봐야 한다"는 교훈. 재현·설명 연습 후 본인 사례로 전환 | `res.on('close')`로 교체 |
| 2026-11-03 | apps/server/Dockerfile, (없던) .dockerignore | Dockerfile이 `COPY apps/server apps/server`를 하는데 `.dockerignore`가 없어 **gitignore된 `.env`(API 키 포함)가 서버 이미지 `/app/.env`로 복사됨**. `.gitignore`는 git만 막고 Docker 빌드 컨텍스트는 막지 않는다. 첫 compose 빌드 뒤 `docker run --rm qrate-server ls -la /app`으로 확인. 이미지는 로컬에만 있었고 레지스트리에 올라간 적은 없음 | 상 | (AI 작성 Dockerfile, 이미지 내용 점검으로 발견) — "비밀값은 .gitignore와 .dockerignore 두 곳에서 막아야 한다"는 교훈 | 루트 `.dockerignore` 추가(`**/.env`, `**/.env.*`, `!**/.env.example` 등), 해당 이미지 삭제 + 빌드 캐시 정리, 재빌드 후 `/app/.env` 부재 확인 |
| 2026-11-04 | apps/server/src/chat/moderation.ts | 욕설 차단이 부분 문자열 검사(`/씨발\|시발\|병신\|개새끼/`)라 업무 어휘를 막음 — "청구서 즉시발행 되나요?"(즉**시발**행), 즉시발송·출시발표·시발점·병신년이 전부 422. 정상 문장 테스트가 한 개뿐이라 통과했음 | 상 | (AI 코드 리뷰 2026-11-03, curl로 재현) — 본인이 원인을 설명할 수 있게 되면 학습 사례로 전환 | 한글 경계 lookaround + 규칙 id, 오탐·정탐 표를 테스트로 고정 |
| 2026-11-04 | apps/server/src/app.ts | 오류·404 핸들러가 없어 잘못된 JSON(400)·32kb 초과(413)·모르는 경로(404)가 Express 기본 HTML로 나가고, 기본 핸들러가 body-parser 오류 객체를 통째로 찍어 **요청 본문(사용자 메시지)이 stdout 로그에 남음**(`NODE_ENV=production`에서도) | 상 | (AI 코드 리뷰 2026-11-03, curl + 로그로 재현) | JSON 404·오류 핸들러, 보고 통로(reportError)에 본문 없이 전달 |
| 2026-11-04 | apps/server/src/http/chat.ts | 메시지 길이 상한이 본문 32kb뿐 — 30,000자 메시지가 200으로 모델까지 감. 테넌트 키가 공개값이라 요청당 입력 토큰 비용 구멍 | 중 | (AI 코드 리뷰 2026-11-03, curl로 재현) | `MAX_MESSAGE_CHARS`(계약 상수) 400 + 대화창 입력 maxLength |
| 2026-11-04 | apps/server/src/chat/service.ts | 턴 저장이 답변 뒤에 실패하면 예외가 http 계층으로 흘러 `event: error upstream_error`(재시도 불가)로 둔갑하고, 사용량 로그의 토큰·종료 사유가 사라짐 — DB 장애가 모델 장애로 집계됨 | 중 | (AI 코드 리뷰 2026-11-03, 저장소 throw 주입으로 재현) | 저장 실패는 reportError로만, 스트림은 정상 종료 |
| 2026-11-04 | apps/server/src/engine/claude.ts | 스트림 도중 `event: error`(overloaded_error·api_error)는 SDK가 상태 코드 없는 `APIError`로 던져(core/streaming.js) 상태별 분기를 못 타고 `upstream_error` 재시도 불가로 매핑됨 — 재시도의 대표 사례에 다시 보내기 버튼이 없음 | 하 | (AI 코드 리뷰 2026-11-03, SDK 소스로 확인) | `err.type`으로 분기 |
| 2026-11-04 | apps/server/src/repo/memory.ts | 메모리 저장소의 핸드오프 id가 `randomUUID`라 큐 정렬의 tie-break(createdAt 같으면 id 내림차순)가 저장 순서와 무관했음 — 같은 밀리초에 생긴 두 건의 순서가 실행마다 달라져 계약 테스트가 간헐 실패(5회 중 1회). Postgres는 cuid(시각+카운터)라 순서가 보존돼 두 구현이 달랐다 | 하 | (AI 작성 코드, 계약 테스트 반복 실행으로 발견) | 시각 base36 + 프로세스 카운터 id로 저장 순서 보존 |
| 2026-11-04 | apps/console/src/api.ts | ky 2는 4xx·5xx의 응답 본문을 미리 읽어 `error.data`에 두는데, 코드가 `error.response.clone().json()`으로 다시 읽어 `Response body is already used`가 났음. 그래서 401(로그인 필요)이 "서버에 연결할 수 없어요"로 보였고 로그인 화면이 뜨지 않았음. 단위 테스트는 없고 브라우저 E2E에서만 드러남 | 중 | (AI 작성 코드, E2E 실패 추적으로 발견) — 라이브러리 메이저 버전의 동작 변화를 문서로 확인해야 한다는 교훈 | `error.data` 사용 |
| 2026-11-05 | apps/server/src/billing/service.ts | 같은 `Idempotency-Key`로 충전 요청을 다시 보내면 주문의 **현재 상태**를 돌려줬다. 그 사이 결제가 끝나면 재요청 본문이 `paid`라서 처음 201 본문(`pending`)과 달랐고, "중복은 같은 응답" 계약과 어긋났다. 기존 테스트는 상태가 바뀌기 전에만 재요청해서 통과했다. 원장·주문 수에는 영향이 없다 | 하 | (AI 작성 코드, 코드를 쓰지 않은 적대적 검토 에이전트 둘(opus·fable)이 따로 같은 재현을 냄, 메모리·Postgres 모두) | 재요청에는 만든 직후의 주문(pending, settledAt 없음)을 돌려준다. 처음 응답은 늘 그 모양이라 저장이 필요 없다. 결제 뒤 재요청 테스트 추가 |
| 2026-11-05 | apps/server/src/http/chat.ts | 이벤트 로그 브랜치가 차단(422)·크레딧 부족(402) 요청도 `chat_request` 사건으로 DB에 썼다. 두 경로는 모델을 부르지 않아 비용이 0이고 `/api/chat`에는 요율 제한이 없어서, 공개 키만 알면 Origin 없는 요청으로 행을 끝없이 만들 수 있었다. 같은 IP에서 욕설 300건을 보내면 300건 모두 422였고 Event 행이 300개 늘었으며 429는 없었다. 브랜치 전에는 거절 요청이 아무것도 쓰지 않았고 `chat/service.ts`도 "공개 키로 요청을 반복해도 저장소가 늘지 않는다"고 적고 있었다. 테스트는 "요청당 1건"만 봤고 반복했을 때 쌓이는 양은 보지 않았다 | 상 | (AI 작성 코드, 코드를 쓰지 않은 적대적 검토 에이전트(opus)가 Postgres에서 재현) | 거절 요청은 사건으로 남기지 않는다(엔진을 부른 요청당 1건). 거절 변형 타입을 지워 다시 쓸 자리를 없앴고, 422·402를 20건씩 반복해도 사건 저장소가 그대로인지 보는 테스트를 더했다 |
