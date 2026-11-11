# 부하 측정 (W6)

방문자 여러 명이 동시에 위젯으로 대화할 때 서버가 첫 응답을 얼마나 빨리 내는지 k6로 잰다. 모델 자리에는 목업 엔진을 두므로 결과는 **시뮬레이션**이다. 결과와 해석은 [docs/load](../../../docs/load/README.md)에 있다. 이 폴더는 서버 빌드(`dist`)와 이미지에 들어가지 않는다.

## 무엇을 재나

k6의 가상 방문자 한 명은 위젯이 실제로 보내는 요청을 차례로 보낸다(`visit.js`).

1. 대화창 문서 `GET /frame`, 인사말 `GET /api/greeting`, 위젯 열림 사건 `POST /api/events`
2. 생각한 뒤 첫 질문 사건과 질문 1 `POST /api/chat`
3. 답을 읽고 생각한 뒤 같은 대화로 질문 2
4. 생각한 뒤 떠나고, 새 방문자가 같은 순서를 다시 시작한다

생각 시간은 평균 3초(0.5배~1.5배)다. 사람보다 짧게 잡아 방문자 한 명이 내는 부하를 키웠다. 질문 다섯 개 중 하나는 목업 훅 `[[handoff]]`로 상담원 연결 기록까지 쓴다.

측정 서버(`server.ts`)는 운영과 같은 `createApp` 조립이고, 다른 점은 다음뿐이다.

- 엔진은 목업이다. 첫 조각을 바로 내고 이후 글자마다 20ms를 쉰다. 그래서 대화 응답의 첫 바이트까지가 서버 몫이고(테넌트·잔액·이전 대화·지식 조회, 모더레이션), 연결은 실제 답처럼 2초 넘게 열려 있다.
- 저장소는 Postgres뿐이고, DB 이름에 `load`가 들어 있어야 뜬다.
- 대화·위젯 사건의 IP당 요율 제한을 크게 올린다. k6는 127.0.0.1 한 곳에서 방문자를 흉내 내므로, 운영 상한(대화 분당 20회)이면 429만 잰다. 미들웨어는 그대로 지나가서 세는 비용은 측정에 들어간다.
- 콘솔·결제·Sentry를 끈다. 방문자 경로가 아니다.
- 1초마다 CPU, 이벤트 루프 사용률(ELU), 루프 지연, GC 정지, 처리 중 요청 수를 남긴다.

사다리 실행기(`ladder.ts`)는 측정 서버를 띄우고, 방문자 10명으로 데운 뒤, 동시 방문자 수마다 k6를 돌린다. 단계마다 방문자를 0명에서 목표까지 늘리고(램프), 목표 인원을 유지한다. 지표는 유지 구간에 시작한 요청만 센다. 단계마다 데모와 같은 지식을 가진 새 테넌트를 쓴다. 잔액이 크레딧 원장의 합계라서, 앞 단계가 쌓은 원장 행이 뒤 단계의 잔액 조회를 무겁게 하지 않게 하려는 것이다.

## 준비 (한 번)

```bash
brew install k6
docker compose up -d db
docker compose exec -T db createdb -U qrate qrate_load
DATABASE_URL=postgresql://qrate:qrate@localhost:5432/qrate_load pnpm --filter @qrate/server exec prisma migrate deploy
```

macOS 셸의 파일 한도가 낮으면(`ulimit -n`이 256) 방문자가 많을 때 소켓이 모자라 서버가 아니라 환경이 막힌다. 보고서 머리에 실행 때의 한도가 찍힌다.

## 실행

레포 루트에서 실행한다. `--run`은 `apps/server` 기준이고, `load/runs/`는 git에 들어가지 않는다.

```bash
# 동시 방문자 사다리(단계마다 램프 15초 + 유지 60초, 마지막에 첫 단계를 한 번 더 돌려 드리프트를 본다)
DATABASE_URL=postgresql://qrate:qrate@localhost:5432/qrate_load pnpm --filter @qrate/server load --run load/runs/ladder --vus 10,50,100,200,400,800,1200 --repeat-first

# 원장 크기 실험: 단계 테넌트의 원장에 차감 기록 10만 행을 미리 넣는다
DATABASE_URL=postgresql://qrate:qrate@localhost:5432/qrate_load pnpm --filter @qrate/server load --run load/runs/ledger-100k --vus 400 --ledger-rows 100000

# 서버 CPU 프로파일(node --cpu-prof)과 패키지별 자체 시간
DATABASE_URL=postgresql://qrate:qrate@localhost:5432/qrate_load pnpm --filter @qrate/server load --run load/runs/profile --vus 1200 --profile
pnpm --filter @qrate/server exec tsx load/profile.ts load/runs/profile/server.cpuprofile
```

| 옵션 | 기본값 | 뜻 |
| --- | --- | --- |
| `--vus` | `10,50,100,200,400` | 동시 방문자 수 단계 |
| `--ramp`, `--hold` | `15`, `60` | 단계마다 램프와 유지 시간(초) |
| `--think` | `3` | 생각 시간 평균(초) |
| `--delay` | `20` | 목업 엔진이 글자마다 쉬는 시간(ms) |
| `--pool` | `0` | DB 연결 풀 크기. 0이면 운영과 같은 기본값(node-postgres 10개) |
| `--ledger-rows` | `0` | 단계 테넌트의 원장에 미리 넣을 행 수 |
| `--repeat-first` | 끔 | 마지막에 첫 단계를 다시 돈다 |
| `--profile` | 끔 | 측정 서버를 `--cpu-prof`로 띄운다. 프로파일러 비용이 측정에 들어간다 |

## 실행 폴더

| 파일 | 내용 |
| --- | --- |
| `report.md` | 단계별 표: 방문자 쪽(k6), 서버 쪽(1초 표본과 DB에 서버가 적은 TTFT), 기기 CPU |
| `steps.json` | 표의 원자료(단계마다 구간·k6·서버·기기·DB 요약) |
| `meta.json` | 기기, Node·k6·Postgres 버전, 파일 한도, 설정 |
| `k6-<단계>.json`, `k6-<단계>.log` | k6 `--summary-export`와 콘솔 출력 |
| `server-stats.jsonl` | 측정 서버의 1초 표본 |
| `cpu.jsonl` | 기기 전체와 서버·k6·Docker VM(Postgres)·Docker 백엔드의 1초 CPU |
| `server.log` | 측정 서버 로그 |
| `server.cpuprofile` | `--profile`일 때만 |

## 한계

- 모델이 없다. 실제 답의 첫 토큰까지 걸리는 모델 몫(W5 실측 Sonnet 5.5 p50 1,123ms)은 여기에 들어가지 않는다. 실제 엔진은 상류 SSE를 해석하고 필터를 거치므로 스트림 하나가 쓰는 CPU가 목업보다 많을 수 있다.
- 서버·Postgres(Docker)·k6가 한 기기에서 CPU를 나눠 쓴다. 기기 CPU 표가 그 몫을 보여 준다.
- 대화창 정적 파일(`app.js`·`app.css`)과 콘솔은 넣지 않았다.
