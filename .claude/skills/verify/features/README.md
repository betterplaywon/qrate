# qrate 검증 맵

이 폴더는 qrate의 사용자 가시 동작을 검증하는 유지 보수 원천이다. 앱을 드라이브하기 전에 이 색인을 읽고, 해당 기능 파일을 레시피로 쓴다. 띄우고 내리는 방법은 [../SKILL.md](../SKILL.md)에 있다.

## 기준 전제

- 루트에서 `pnpm build`한 산출물로 `node .claude/skills/verify/scripts/launch.mjs <feature>`가 띄운 인스턴스만 드라이브한다 — 서버 `http://localhost:8787`(목업 엔진, 메모리 저장소), 데모 `http://localhost:5173/demo.html`, 허용 목록 밖 데모 `http://localhost:5174/demo.html`.
- 메모리 저장소는 launch마다 비어 있고 시드만 있다: 테넌트 키 `demo`, 이름 "마루인보이스", allowedOrigins `http://localhost:5173`·`http://127.0.0.1:5173`, FAQ 26건. 콘솔 키는 `e2e-widget-console-key`.
- `node .claude/skills/verify/scripts/doctor.mjs`가 `DOCTOR OK`를 찍어야 한다.
- 직접 띄우지 않은 인스턴스는 드라이브하지 않는다.

## 드라이브 규칙

- 모든 레시피는 기준 상태(새 launch)에서 시작한다. 기능 파일의 Preconditions가 다르게 말하면 그것을 따른다.
- 브라우저 행동은 `node .claude/skills/verify/scripts/drive.mjs`가 `scripts/journeys/<feature>.mjs`로 수행한다. 기능 파일의 "Driving it" 항목은 그 여정의 단계(id)와 같다. 여정이 없는 기능은 여정을 추가한 뒤 드라이브한다.
- 선택자는 안정적인 손잡이만: 위젯은 소스의 클래스·id(`#qrate-host .launcher`, `#qrate-input`, `.msg.bot`), 콘솔은 data-testid와 역할·이름(`getByRole('button', { name: '로그인' })`). 좌표·탭 순서는 쓰지 않는다.
- 문구는 글자 그대로 본다: "상담 열기", "무엇을 도와드릴까요?", "출처 1건", "상담원에게 연결해 드릴까요?", "접수됐어요", "맞지 않아요", "처리 중".
- 변경(접수·상태 이동)은 메모리에만 남고 cleanup으로 사라진다. 시드를 되돌릴 일은 없다. 증거는 cleanup이 지우지 않는다.

## 증거와 건너뜀 보고

- 사용자 행동과 그 결과 상태를 함께 남긴다 — `steps.md`의 단계별 관찰, 단계별 스크린샷, `trace.zip`.
- UI 증거에는 앱의 정체가 보여야 한다: 대화창 머리글 "무엇을 도와드릴까요?", 콘솔 머리글 "Qrate 콘솔 마루인보이스".
- 변경 증거는 두 번째 읽기를 포함한다 — 콘솔 API `GET /api/console/conversations/:id`, `GET /api/console/handoffs?status=`의 응답 파일.
- 증거마다 기능 id와 들어간 입구를 적는다(`steps.md`·`result.json`의 단계 id가 그 역할이다).
- 닿지 못한 경로는 시도한 명령과 못 채운 전제를 적는다. 다른 경로로 통과한 것을 그 경로의 검증으로 보고하지 않는다.

## 기능 파일 규약

기능 파일은 H1 제목과 사용자 가시 동작을 설명하는 한 문단으로 시작하고, 이 순서로 정확히 네 개의 H2를 가진다.

1. `Sub-features` — 짧은 id와 한 줄 설명. id는 여정의 단계 id와 같다.
2. `How to get to it (user POV)` — 사용자가 들어가는 모든 입구.
3. `Driving it with verify` — `Preconditions:`로 시작하고, 사용자 행동마다 정확한 동작(선택자·입력값)과 관찰 가능한 결과를 짝지은 항목.
4. `Gotchas` — 검증을 낭비하거나 무효로 만드는 함정.

구현 세부는 적지 않는다. 사용자 경로, 안정적인 손잡이, 필요한 상태, 명령, 관찰 가능한 증거만 적는다.

## Features

- [위젯 대화](./widget-chat.md) — 런처(Shadow DOM) → 대화창 iframe → 스트리밍 답변·출처 → 대화 이어 가기 → 콘솔 대화 로그.
- [상담원 연결 접수](./handoff-queue.md) — 모델 신호 뒤 제안 / 머리글 버튼 → 연락처 폼 → 201 접수 → 콘솔 미응답 큐.
- [운영 콘솔](./console.md) — 문서 CSP, 로그인(틀린 키·맞는 키), 대화 로그·상세, 큐 상태 이동, 로그아웃.
- [허용되지 않은 오리진 차단](./origin-guard.md) — `/frame` 403 안내 문서, 브라우저 CSP frame-ancestors 거부, 허용 오리진 대조군.
- [크레딧 충전](./top-up.md) — 충전 요청 → 결제 성공(테스트) → 재배달 → 늦은 실패, 요청 키 재전송, 서명 웹훅 재배달·위조·만료, 원장 한 줄.
- [토스 테스트 결제](./top-up-toss.md) — 토스일 때만 열리는 콘솔 CSP → 결제하기 → 토스 결제창(진짜 SDK, 위반 0) → 모르는 결제 키로 돌아옴(승인·조회 뒤 "확인하지 못함") → 실패 주소의 문장 미표시 → 원장 그대로. 결제창형 테스트 키를 실행 환경으로 넘긴다.
- [콘솔 지표](./metrics.md) — 위젯 열림 사건 → 답한 질문·연결만 요청한 대화 → 콘솔 "지표"의 TTFT·자동 해결률·위젯 열림 → server.log 사건 줄.
- [인사말 A/B](./greeting-ab.md) — 서버 배정 인사말 → 이 사이트 localStorage 보존(`v=`) → 열림·첫 질문 사건의 변형 → 다른 변형·지금 실험에 없는 보존값 → 콘솔 변형별 노출·첫 질문 → server.log.

아직 맵에 없는 것(다음 후보): 재시도 정책(`[[fail:429]]`·`[[fail:401]]`), 닫기·안 읽은 배지, 모더레이션 차단(422), 콘솔 "더 보기" 페이지네이션. 기대값은 packages/widget/e2e/widget.spec.ts와 apps/console/e2e/console.spec.ts에 있다.
