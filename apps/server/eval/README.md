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

레포 루트에서 순서대로 실행한다. `--run`은 `apps/server` 기준이고, 상한은 그 폴더의 누계라 단계마다 앞 단계의 호출이 들어 있다. 합계는 230건·$4를 넘지 않는다.

사람 채점으로 심판을 검증한 뒤에 Haiku를 돌린다. 심판 지시를 고치면 심판 버전이 바뀌어 그 버전으로 판정을 다시 받아야 하는데, 검증을 먼저 하면 다시 채점할 묶음이 Sonnet 30개로 끝난다. Haiku까지 채점한 뒤에 고치면 60개를 다시 불러야 해서 이 상한에 들어가지 않는다.

1. 시험 실행 답(Sonnet, 사례 5개 × 2회 = 10건). 넘김·인용·이어지는 대화가 모두 들어가게 고른 사례다:
   `pnpm --filter @qrate/server eval:paid answers --run eval/runs/w5 --engine claude --variant sonnet --cases k01,c01,n04,b02,m02 --max-calls 12 --max-usd 0.4`
2. 시험 실행 판정(5건):
   `pnpm --filter @qrate/server eval:paid judge --run eval/runs/w5 --judge claude --variant sonnet --cases k01,c01,n04,b02,m02 --max-calls 20 --max-usd 1.2`
3. 심판 점검(2건). 실패하면 본 판정 전에 멈추고 심판 지시를 고친다. 끝나면 `report`로 실측 비용을 보고 본 실행을 이어 갈지 정한다:
   `pnpm --filter @qrate/server eval:paid judge-check --run eval/runs/w5 --judge claude --max-calls 25 --max-usd 1.4`
4. Sonnet 나머지 답(25개 × 2회 = 50건):
   `pnpm --filter @qrate/server eval:paid answers --run eval/runs/w5 --engine claude --variant sonnet --max-calls 80 --max-usd 1.6`
5. Sonnet 나머지 판정(25건). 끝나면 `labels`로 Sonnet 1회차 답 30개를 내보내 사람이 채점하고, `agreement`로 심판과 맞춰 본다. 두 판정이 모두 90% 넘게 같아야 다음으로 간다:
   `pnpm --filter @qrate/server eval:paid judge --run eval/runs/w5 --judge claude --variant sonnet --max-calls 105 --max-usd 2.8`
   - 일치율이 낮으면 심판 지시를 고친 뒤 Sonnet을 다시 채점한다(30건):
     `pnpm --filter @qrate/server eval:paid judge --run eval/runs/w5 --judge claude --variant sonnet --max-calls 135 --max-usd 3.6`
6. Haiku 답(30개 × 2회 = 60건):
   `pnpm --filter @qrate/server eval:paid answers --run eval/runs/w5 --engine claude --variant haiku --max-calls 195 --max-usd 3.7`
7. Haiku 판정(30건). 예산 끝자락이라 동시 수를 1로 줄인다:
   `pnpm --filter @qrate/server eval:paid judge --run eval/runs/w5 --judge claude --variant haiku --concurrency 1 --max-calls 225 --max-usd 4`
8. 오류로 빠진 키만 다시 부른다(답이면 `answers`, 판정이면 `judge`):
   `pnpm --filter @qrate/server eval:paid judge --run eval/runs/w5 --judge claude --concurrency 1 --max-calls 230 --max-usd 4`

관문은 진행 중인 호출마다 상한을 미리 잡아 두므로, 실제로 쓴 돈이 상한보다 한참 아래여도 끝자락에서 멈출 수 있다. 그때는 `--concurrency 1`로 줄이거나 실측 비용을 보고 상한을 다시 정한다. 위 상한은 시험 실행 전의 추정으로 잡았고, 시험 실행의 실측으로 다시 계산한다.

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
