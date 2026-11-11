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

레포 루트에서 순서대로 실행한다. `--run`은 `apps/server` 기준이다. 상한은 누계이고, 합계 230건·$4를 넘지 않게 잡았다.

1. 시험 실행 답(Sonnet, 사례 5개 × 2회 = 10건):
   `pnpm --filter @qrate/server eval:paid answers --run eval/runs/w5 --engine claude --variant sonnet --limit 5 --max-calls 15 --max-usd 0.5`
2. 시험 실행 판정(5건). 끝나면 `report`로 캐시 읽기 토큰과 1건 비용을 확인한다:
   `pnpm --filter @qrate/server eval:paid judge --run eval/runs/w5 --judge claude --variant sonnet --limit 5 --max-calls 25 --max-usd 1.2`
3. 심판 점검(2건). 실패하면 본 판정 전에 멈추고 심판 지시를 고친다:
   `pnpm --filter @qrate/server eval:paid judge-check --run eval/runs/w5 --judge claude --max-calls 30 --max-usd 1.4`
4. 본 실행 답(두 모델 × 30개 × 2회 중 남은 110건):
   `pnpm --filter @qrate/server eval:paid answers --run eval/runs/w5 --engine claude --max-calls 145 --max-usd 2`
5. 본 실행 판정(남은 55건):
   `pnpm --filter @qrate/server eval:paid judge --run eval/runs/w5 --judge claude --max-calls 205 --max-usd 3.5`
6. 다시 채점(오류로 빠진 묶음만 다시 부른다):
   `pnpm --filter @qrate/server eval:paid judge --run eval/runs/w5 --judge claude --max-calls 230 --max-usd 4`

심판 지시·출력 스키마·설정을 고치면 심판 버전이 바뀌어 모든 묶음(60건)을 다시 부른다. 이 상한 안에 들어가지 않으므로 그때는 예산을 다시 정한다.

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

그 밖의 플래그: `--variant sonnet|haiku|all`(기본 all), `--reps <n>`(기본 2), `--cases <id,id>`, `--limit <n>`, `--labels <파일>`(agreement, 기본은 실행 폴더의 `labels.json`).
