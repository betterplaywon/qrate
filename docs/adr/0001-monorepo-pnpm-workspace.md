# ADR-0001: pnpm workspace 모노레포

- 상태: proposed → 본인이 근거를 채운 뒤 accepted로 변경할 것
- 날짜: 2026-10-30
- 작성: 강지원

> 결정 자체는 스캐폴드에 반영되어 있다. 아래 "맥락/대안/트레이드오프"를 **본인 언어로** 채우고
> 상태를 accepted로 바꾸는 것까지가 이 ADR의 완료 조건이다.

## 맥락

위젯 SDK(`packages/widget`), API 서버(`apps/server`), 운영 콘솔(`apps/console`)이
서로 "SSE 이벤트 형식"이라는 계약을 공유한다. 이 세 개를 어떻게 관리할 것인가?

## 고려한 대안

| 대안 | 장점 | 단점 |
| --- | --- | --- |
| 레포 3개 분리 | (채워 넣기) | (채워 넣기) |
| pnpm workspace 모노레포 | (채워 넣기) | (채워 넣기) |
| npm/yarn workspaces | (채워 넣기) | (채워 넣기) |

## 결정

pnpm workspace 모노레포. `pnpm-workspace.yaml`에 `apps/*`, `packages/*`, `scripts/*`.

## 스스로 답해볼 유도 질문 (답을 위 표와 트레이드오프에 녹일 것)

1. devdive에서 yarn classic → pnpm 마이그레이션을 했을 때 해결한 "유령 의존성"이
   정확히 무엇이고, pnpm의 어떤 구조(심볼릭 링크 기반 node_modules)가 그걸 막는가?
2. 포트폴리오 평가자는 레포 1개만 본다. 레포를 3개로 쪼갰다면 무엇을 잃었을까?
3. 모노레포의 비용은? (CI 시간, 도구 설정 복잡도, 부분 배포의 어려움 등 — 솔직하게)

## 트레이드오프

(본인 작성)

## 결과 확인 방법

- `pnpm -r typecheck/test/build`가 CI 한 번에 세 패키지를 검증한다.
- 위젯·서버의 SSE 계약 변경이 한 PR 안에서 함께 리뷰된다.
