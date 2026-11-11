# 응답 품질 평가 (W5)

시험지 `cases.json`의 30개 질문을 운영과 같은 대화 유스케이스(`createChatService`)에 넣어 Sonnet 5.5와 Haiku 5.5(둘 다 운영 설정: 사고 끔)의 답을 받고, 기계 채점과 Opus 5.5 심판으로 채점한다. 이 폴더는 서버 빌드(`dist`)와 이미지에 들어가지 않는다.

## 단계

| 명령 | 하는 일 | 모델 호출 |
| --- | --- | --- |
| `answers` | 변형 × 회차 × 사례마다 답을 받아 `answers.jsonl`에 쌓는다 | 엔진(`--engine claude`일 때) |
| `judge` | 변형·사례마다 회차 답을 한 번에 심판에게 보내 `judgments.jsonl`에 쌓는다 | 심판(`--judge claude`일 때) |
| `judge-check` | 일부러 나쁜 답(빈 답, "모르겠습니다", 확신에 찬 틀린 답)을 심판이 모두 실패로 보는지 본다. 사례 2개, 호출 2건 | 심판 |
| `report` | 기록만으로 `summary.json`과 `report.md`를 만든다 | 없음 |
| `labels` | sonnet 1회차 답과 판정을 `labels-input.json`으로 내보낸다(사람 라벨용) | 없음 |
| `agreement` | 사람이 쓴 `labels.json`(`{answerKey: {fabricated, appropriate}}`)과 판정의 일치를 `agreement.md`로 낸다 | 없음 |

모든 단계는 `--run <폴더>`에 기록하고, 다시 돌리면 끝난 키를 건너뛴다. 오류로 끝난 키는 다음 실행에서 다시 시도한다. 폴백으로 다른 모델이 답했거나 거절된 키는 다시 뽑지 않는다. 오류는 `errors.jsonl`에만 남고 0점으로 세지 않는다.

## 예산 장부

- 모든 호출은 시작 전에 `calls.jsonl`에 적힌다. `--max-calls`와 `--max-usd`는 **그 실행 폴더의 누계** 상한이다. 같은 폴더에서 단계를 이어 가면 앞 단계의 호출과 비용이 함께 들어간다.
- 새 호출은 "시작한 호출 + 1 ≤ 호출 상한"이고 "쓴 돈 + 진행 중 호출들의 상한 + 이번 호출의 상한 ≤ 비용 상한"일 때만 시작한다. 한 번 막히면 그 명령은 새 호출을 더 시작하지 않고 이유를 찍는다.
- 호출 1건의 상한은 입력을 바이트 수만큼 캐시 쓰기 단가로, 출력을 `max_tokens` 전부로 친 값이다. 지금 시드 기준으로 Sonnet 답 $0.047, Haiku 답 $0.0023, Opus 심판 $0.21쯤이다. 심판은 3건까지 동시에 돌므로 비용 상한에 $0.65쯤 여유가 있어야 끝까지 간다.
- 실제 호출이 있는 명령은 상한 두 개와 `ANTHROPIC_API_KEY`(`eval:paid`가 `.env`에서 읽는다)가 없으면 시작하지 않는다. 같은 실행 폴더를 두 프로세스가 동시에 쓰지 못한다(`run.lock`).

## 실제 호출 (사용자가 직접 실행)

레포 루트에서 순서대로 실행한다. `--run`은 `apps/server` 기준이다. 상한은 그 폴더의 누계라 단계마다 앞 단계의 호출이 들어 있다. 실행 폴더를 바꾸면 장부가 0부터 다시 시작하므로, 폴더를 여러 개 쓰는 전체 합은 아래 표로 센다.

| 폴더 | 내용 | 호출 상한 | 비용 상한 |
| --- | --- | --- | --- |
| `eval/runs/w5` | 1회차(시험지 v1). 시험 실행, Sonnet 답 60건과 판정 30건, 심판 점검 | 92건(끝남) | $0.651(실측) |
| `eval/runs/w5-v2-try`, `w5-v2-try2` | v2 짧은 시험(각 28건, 두 번째는 필요할 때만) | 56건 | $0.6 |
| `eval/runs/w5-v2` | v2 본 실행 | 212건 | $2.7 |
| 합계 | | 360건 | $4 안 |

1회차는 사람 채점에서 답 기준이 바뀌어(2026-11-11 답 기준 C: 지원하지 않는 기능은 자료에 적힌 것만 단정, 무관한 질문은 넘기지 않음, 내부 표현·덧붙임·반복 금지) 시험지 v2로 다시 잰다.

사람 채점으로 심판을 검증한 뒤에 Haiku를 돌린다. 심판 지시를 고치면 심판 버전이 바뀌어 그 버전으로 판정을 다시 받아야 하는데, 검증을 먼저 하면 다시 채점할 묶음이 Sonnet 30개로 끝난다.

**v2 짧은 시험.** 바뀐 기준이 걸리는 사례 14개를 두 모델로 1회씩 받아(28건) 말투를 본다. 고칠 것이 있으면 프롬프트를 고친 뒤 `w5-v2-try2`로 한 번 더 한다.

`pnpm --filter @qrate/server eval:paid answers --run eval/runs/w5-v2-try --engine claude --variant all --reps 1 --cases n01,n02,n03,n04,n05,n06,n07,b01,b03,h01,h02,o01,m02,k05 --max-calls 28 --max-usd 0.3`

**v2 본 실행** (`eval/runs/w5-v2`):

1. Sonnet 답(30개 × 2회 = 60건):
   `pnpm --filter @qrate/server eval:paid answers --run eval/runs/w5-v2 --engine claude --variant sonnet --max-calls 60 --max-usd 0.8`
2. 심판 점검(2건). 실패하면 판정 전에 멈추고 심판 지시를 고친다:
   `pnpm --filter @qrate/server eval:paid judge-check --run eval/runs/w5-v2 --judge claude --max-calls 62 --max-usd 1.2`
3. Sonnet 판정(30건). 끝나면 `labels`로 Sonnet 1회차 답 30개를 내보내 사람이 채점하고, `agreement`로 심판과 맞춰 본다. 두 판정이 모두 90% 넘게 같아야 다음으로 간다:
   `pnpm --filter @qrate/server eval:paid judge --run eval/runs/w5-v2 --judge claude --variant sonnet --max-calls 92 --max-usd 1.6`
   - 일치율이 낮으면 심판 지시를 고친 뒤 Sonnet을 다시 채점한다(30건):
     `pnpm --filter @qrate/server eval:paid judge --run eval/runs/w5-v2 --judge claude --variant sonnet --max-calls 122 --max-usd 2.1`
4. Haiku 답(30개 × 2회 = 60건):
   `pnpm --filter @qrate/server eval:paid answers --run eval/runs/w5-v2 --engine claude --variant haiku --max-calls 182 --max-usd 2.2`
5. Haiku 판정(30건):
   `pnpm --filter @qrate/server eval:paid judge --run eval/runs/w5-v2 --judge claude --variant haiku --max-calls 212 --max-usd 2.7`
6. 오류로 빠진 키는 같은 명령을 남은 상한 안에서 다시 실행한다. 재채점을 하지 않았다면 30건이 남는다.

관문은 진행 중인 호출마다 상한을 미리 잡아 두므로(Sonnet 답 약 $0.05, 심판 약 $0.21), 실제로 쓴 돈이 상한보다 한참 아래여도 끝자락에서 멈출 수 있다. 그때는 `--concurrency 1`로 줄인다. 위 상한은 1회차 실측(답 평균 $0.004, 판정 평균 $0.013)으로 잡았다.

장부가 알 수 없는 것이 둘 있다.

- 서버 측 폴백으로 더 비싼 모델이 답하면 그 한 건은 잡아 둔 상한보다 더 쓸 수 있다. 넘치는 양은 많아야 동시 실행 수 × 한 건 분량이다. 이런 답은 `served-model-mismatch` 오류로 남고 점수에 들어가지 않는다.
- 스트림이 열린 뒤 첫 글자 전에 과부하로 끊긴 호출은 사용량을 받지 못해 장부에 금액 0으로 남는다(호출 수는 센다).

## 무료 명령

목업 엔진과 가짜 심판으로 파이프라인 전체를 키 없이 돌린다. 이때 토큰은 글자 수로 만든 합성값이고 점수에는 뜻이 없다.

- `pnpm --filter @qrate/server eval answers --run eval/runs/dry`
- `pnpm --filter @qrate/server eval judge --run eval/runs/dry`
- `pnpm --filter @qrate/server eval judge-check --run eval/runs/dry`
- `pnpm --filter @qrate/server eval report --run eval/runs/dry`

실제 실행 폴더의 보고서와 라벨:

- `pnpm --filter @qrate/server eval report --run eval/runs/w5`
- `pnpm --filter @qrate/server eval labels --run eval/runs/w5`
- `pnpm --filter @qrate/server eval agreement --run eval/runs/w5`

그 밖의 플래그: `--variant sonnet|haiku|all`(기본 all), `--reps <n>`(기본 2), `--cases <id,id>`, `--limit <n>`, `--concurrency <1~3>`(기본 3), `--labels <파일>`(agreement, 기본은 실행 폴더의 `labels.json`).
