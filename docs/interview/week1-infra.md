# W1 면접 질문 뱅크 — 모노레포 · CI · Docker · SSE · Sentry

사용법 (백엔드·인프라 보강 루프):

1. 코드를 보지 않고 소리 내어(또는 글로) 답한다.
2. 답을 이 파일 아래에 적거나 메모해서 Claude 세션에 첨부하고 **"채점해줘"**라고 요청한다.
3. 막힌 질문은 해당 코드/설정 파일을 열어 읽고 다시 답한다.
4. 잘 답한 것 중 하나를 골라 그 주의 블로그 글로 옮긴다 (`pnpm blog:new`).

README 'AI 워크플로우'의 "주 1회 코드를 보지 않고 구조 설명 연습" 원칙을 실행하는 도구다.

---

## 모노레포 · pnpm

1. 이 프로젝트를 모노레포로 만든 이유를 한 문장으로? 레포를 3개로 쪼갰다면 뭐가 불편했을까?
2. pnpm이 "유령 의존성(phantom dependency)"을 구조적으로 막는 원리는?
   (힌트: node_modules가 평탄(flat)하지 않고 심볼릭 링크 기반이라는 점. devdive에서 직접 겪은 문제와 연결해 답할 것)
3. `pnpm-lock.yaml`을 커밋하는 이유는? CI의 `--frozen-lockfile` 플래그는 무엇을 막아주나?

## CI (GitHub Actions)

4. `.github/workflows/ci.yml`이 있다고 "머지 게이트"가 되는 게 아니다. 실제로 머지를 막으려면
   GitHub에서 무엇을 추가로 설정해야 하나? (Settings → Branches → ?)
5. `actions/setup-node`의 `cache: pnpm`은 정확히 무엇을 캐시하나? node_modules인가, 아닌가?
6. PR마다 lint→typecheck→test→build를 전부 돌리는 비용과 효익은? 레포가 커지면 뭘 먼저 최적화할 건가?

## Docker

7. 멀티 스테이지 빌드가 해결하는 문제 두 가지는? (이미지 크기 외에 하나 더 — 보안 관점)
8. 최종 이미지에 devDependencies(typescript, vitest 등)가 들어가면 안 되는 이유는?
   우리 Dockerfile에서 그걸 보장하는 줄은 어디인가? (`pnpm deploy --prod`)
9. `USER node`로 실행하는 이유는? 루트로 돌리면 어떤 시나리오에서 위험해지나?
10. Dockerfile에서 `package.json`들을 소스보다 **먼저** COPY하는 이유는? (레이어 캐시)

## SSE · 스트리밍

11. (0002 ADR 질문 1~4와 동일 — ADR에 답을 쓰면 여기서는 말로 재연습)
12. `drainSSEBuffer` 없이 "청크마다 바로 JSON.parse"로 구현하면 어떤 버그가, 왜 **간헐적으로만** 나는가?

## Sentry · 운영

13. Sentry init을 왜 다른 import보다 먼저 해야 하나? (모듈 로드 시점과 계측의 관계)
14. DSN은 비밀키인가? `.env`로 분리한 이유를 "비밀이라서"가 아닌 다른 말로 설명해보라.
    (힌트: 환경별 설정 분리 — dev에선 비활성, prod에선 활성)
15. `tracesSampleRate: 0.1`로 둔 이유는? 에러는 전수, 트랜잭션은 샘플링 — 왜 다르게 다루나?

---

답하다 막힌 번호를 기록해두면 그게 이번 주의 공부 우선순위다: [ ]
