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
| 레포 3개 분리 | 저장소마다 CI·릴리스·접근 권한을 따로 둠, 한 패키지만 바꾸면 그 저장소 CI만 돎 | `@qrate/contracts`(SSE 이벤트 계약)를 레지스트리에 배포하고 세 저장소가 버전을 맞춰야 함, 계약을 바꾸면 PR이 저장소마다 나뉨, 서버가 위젯·콘솔 빌드 결과를 서빙해 E2E가 저장소를 넘나듦 |
| pnpm workspace 모노레포 | 계약과 세 패키지를 한 PR·한 CI 잡(`pnpm -r`)에서 검증, 직접 의존성만 심볼릭 링크로 두어 선언하지 않은 패키지를 import하지 못함(유령 의존성 차단), `--filter @qrate/server...`·`pnpm deploy`로 서버 이미지에 필요한 패키지만 담음 | 한 패키지만 바꿔도 CI가 전체 lint·test·build·E2E를 돎, pnpm을 따로 설치(Docker는 corepack, CI는 `pnpm/action-setup`), pnpm 전용 설정이 생김(`.pnpmfile.cjs`의 peer 제거 훅, 빌드 스크립트 허용 목록 `onlyBuiltDependencies`) |
| npm/yarn workspaces | npm은 Node.js와 함께 설치돼 따로 깔 도구가 없음, 평탄한 `node_modules`라 의존성 선언을 빠뜨린 패키지도 그대로 동작(pnpm FAQ가 드는 비호환이 없음) | npm·Yarn Classic은 의존성을 루트 `node_modules`로 끌어올려 선언하지 않은 패키지도 import됨(유령 의존성), Yarn Classic은 끌어올리기 방식이 표준화되지 않았고 버전이 어긋나면 로컬 패키지 대신 레지스트리에서 받음 |

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
