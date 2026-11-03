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
