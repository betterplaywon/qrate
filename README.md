# Support Widget — 임베더블 AI 상담 위젯 SDK

소규모 SaaS·커머스 사이트에 **스크립트 한 줄**로 설치하는 AI 상담 위젯과
운영자용 웹 콘솔. 채널톡·인터콤이 검증한 문제를, 위젯 SDK(Shadow DOM 격리) +
SSE 스트리밍 + 크레딧 과금(멱등) + 품질 평가셋 관점에서 처음부터 다시 구현한다.

```html
<!-- 고객 사이트에 들어가는 전부 -->
<script src="https://cdn.example.com/widget.js" data-tenant="KEY" defer></script>
```

## 왜 이걸 만들었나 (문제 근거)

> [W1에 채움] 운영자 미니 인터뷰 2~3건 익명 인용 + 공개 통계(출처 링크).
> 가설: 1~10인 팀의 고객 문의 중 절반 이상은 FAQ·문서로 답할 수 있는 반복 질문이다.

## 구조

```
apps/server       Express 5 + TS — SSE 스트리밍, 입력 모더레이션, (W2~) Prisma/PostgreSQL
apps/console      React + Vite — 운영 콘솔 (W3)
packages/widget   임베더블 SDK — IIFE 번들, Shadow DOM, fetch 스트림 SSE 파서
scripts/blog      티스토리 발행 파이프라인 (Playwright)
docs/adr          아키텍처 결정 기록 (직접 작성)
docs/interview    주차별 면접 질문 뱅크
docs/reviews.md   AI 코드 리뷰에서 실제 발견한 문제 기록
```

## 진행 상황

- [x] W1 기반: 모노레포(pnpm workspace) · CI 게이트(GitHub Actions) · Sentry · Docker · SSE 목업 스트리밍 · 입력 모더레이션(3단계) + 테스트
- [ ] W2 위젯 SSE 실모델 연결 · 지식(FAQ/문서) 연결 · 테넌트 CORS
- [ ] W3 운영 콘솔(대화 로그 · 미응답 큐 · 핸드오프)
- [ ] W4 크레딧 결제(멱등) · 이벤트 로그 · 간단 A/B
- [ ] W5 응답 품질 평가셋(30케이스) · 실패 사례 기록
- [ ] W6 k6 부하 테스트(시뮬레이션 기준 명시) · 문서화

성능·해결률 수치는 **실측만** 기재하며, 시뮬레이션 수치는 그렇게 표기한다.

## 실행

```bash
pnpm install
pnpm dev                              # API 서버 http://localhost:8787
pnpm --filter @sw/widget build        # 위젯 번들 → packages/widget/dist/widget.js
open packages/widget/demo.html        # 데모 페이지 (서버 켠 상태에서)
pnpm --filter @sw/console dev         # 운영 콘솔 셸

pnpm lint && pnpm typecheck && pnpm test && pnpm build   # CI 게이트와 동일
docker compose up --build             # Postgres + 서버 (Docker)
```

## AI 워크플로우 (작업 방식)

구현은 AI 에이전트가, **설계·리뷰·설명 책임은 사람이** 맡는다.

- 아키텍처 결정은 [docs/adr](docs/adr)에 직접 작성 — 결정·대안·트레이드오프
- 머지는 CI 게이트(typecheck·lint·test·build) 통과 시에만 — [ci.yml](.github/workflows/ci.yml)
- 결제·인증·SSE·모더레이션 코드는 줄 단위로 읽는다 — [PR 템플릿](.github/pull_request_template.md)
- AI 생성 코드에서 실제 발견한 문제만 [docs/reviews.md](docs/reviews.md)에 기록
- 주 1회: [면접 질문 뱅크](docs/interview)에 코드 안 보고 답하기 → 블로그로 발행(`pnpm blog:new`)
