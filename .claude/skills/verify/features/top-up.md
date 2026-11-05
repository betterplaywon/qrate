# 크레딧 충전

운영자는 콘솔 "크레딧" 화면에서 충전할 묶음을 골라 충전 요청을 보내고, 모의 결제 제공자일 때는 주문마다 "결제 성공(테스트)"·"결제 실패(테스트)"로 제공자의 웹훅을 흉내 낸다. 같은 이벤트가 다시 오거나(재배달) 완료 뒤에 실패가 늦게 와도 상태는 앞으로만 가고 잔액은 한 번만 늘어난다. 제공자 쪽에서 직접 보내는 서명 웹훅도 같은 규칙을 따르고, 서명이 틀리거나 오래된 웹훅은 401이다.

## Sub-features

- `top-up-open` 로그인 뒤 `#/billing`에 잔액 100(시드 지급)과 충전 폼이 보이고, `GET /api/console/top-ups`의 `provider`가 `mock`이다.
- `top-up-request` 100크레딧 묶음으로 "충전 요청" → 201, 목록에 "결제 대기" 주문.
- `top-up-pay` "결제 성공(테스트)" → "100크레딧을 충전했어요.", 상태 "결제 완료", 잔액 200.
- `top-up-redelivery` 같은 버튼을 다시 누름(같은 이벤트 id) → 재배달 안내, 잔액 200 그대로.
- `top-up-late-failure` "결제 실패(테스트)" → "이미 처리된 주문이라 상태가 바뀌지 않았어요.", 결제 완료 유지.
- `top-up-request-replay` 같은 `Idempotency-Key`로 충전 요청을 다시 보내면 같은 201·본문 + `Idempotent-Replayed: true`, 같은 키·다른 묶음은 422 `idempotency_key_reused`.
- `top-up-webhook` 서명한 웹훅을 `POST /api/payments/mock/webhook`으로 직접: 재배달 200 `applied` + `Idempotent-Replayed: true`, 다른 이벤트 id 200 `stale`, 변조·다른 비밀·만료(301초 전) 401 `invalid_signature`.
- `top-up-ledger` 콘솔 API 원장에 `topup:<주문 id>` 한 줄(+100), 잔액 200. 새로 고쳐도 200.

## How to get to it (user POV)

- 콘솔 `http://localhost:8787/console/` 로그인 → 머리글 "크레딧" → 화면 "충전" 절.
- 결제 제공자 쪽 입구: `POST http://localhost:8787/api/payments/mock/webhook`(서명 헤더 `qrate-mock-signature: t=<unix초>,v1=<hex>`, 값은 HMAC-SHA256(비밀, `"<t>." + 원문`)).

## Driving it with verify

Preconditions:

- `node .claude/skills/verify/scripts/launch.mjs top-up`로 띄우고 `doctor.mjs`가 `DOCTOR OK`. 서버 env에 `QRATE_PAYMENT_PROVIDER=mock`과 고정 비밀 `QRATE_MOCK_PAYMENT_SECRET`(scripts/lib.mjs `MOCK_PAYMENT_SECRET`)이 있다. server.log에 `[server] payments=mock webhook secret=env`.
- 실행: `node .claude/skills/verify/scripts/drive.mjs`.

- **열기(`top-up-open`).** `/console/` → `#tenant` `demo`, `#key` 콘솔 키, "로그인" → `#/billing` → `getByTestId('credit-balance')` "100", 버튼 "충전 요청" 보임.
- **충전 요청(`top-up-request`).** `getByTestId('package-credits_100')` 체크 → "충전 요청" → `POST /api/console/top-ups` 201 → `getByTestId('top-up-item')`(주문 id 포함) 안 `top-up-status` "결제 대기".
- **결제 성공(`top-up-pay`).** 그 주문 행의 "결제 성공(테스트)" → `getByTestId('simulate-result')` "100크레딧을 충전했어요." → 상태 "결제 완료" → 잔액 "200".
- **재배달(`top-up-redelivery`).** 같은 버튼 → simulate 응답 `{ outcome: 'applied', replayed: true }` → 안내 "같은 이벤트가 다시 왔어요. 처리 결과는 처음과 같고 잔액은 그대로예요." → 잔액 "200".
- **늦은 실패(`top-up-late-failure`).** "결제 실패(테스트)" → `{ outcome: 'stale' }` → 안내 "이미 처리된 주문이라 상태가 바뀌지 않았어요." → 상태 "결제 완료", 잔액 "200".
- **요청 재전송(`top-up-request-replay`).** 브라우저 세션 쿠키로 같은 키 `POST /api/console/top-ups` 두 번(500크레딧) → 둘 다 201·같은 본문, 두 번째만 `idempotent-replayed: true` → 같은 키·100크레딧 → 422.
- **서명 웹훅(`top-up-webhook`).** 같은 비밀로 서명한 `payment.paid`를 `evt_<주문 id>_paid`로 보내면 200 `{"outcome":"applied"}` + 헤더, 새 이벤트 id면 200 `stale`, 본문 금액을 바꾼 것·다른 비밀·`t`가 301초 전인 것은 401.
- **원장(`top-up-ledger`).** `GET /api/console/credits` → 잔액 200, `topup:<주문 id>` 한 줄(+100) → 새로 고침 뒤 잔액 "200".
- **Proof.** `steps.md`, `01-top-up-open.png`~`08-top-up-ledger.png`(04: 재배달 안내와 잔액 200, 원장 두 줄), `top-up-request*.txt`, `webhook-*.txt`(상태·헤더·본문), `console-credits.json`, `server.log`(`payments=mock`), `trace.zip`.

## Gotchas

- 시뮬레이션 버튼의 이벤트 id는 `evt_<주문 id>_<결과>`로 고정이라 같은 버튼을 다시 누르는 것이 곧 재배달이다. 다른 이벤트 id로 온 같은 결과는 서명 웹훅 단계에서만 재현된다.
- 고정 비밀 없이 띄운 서버(`QRATE_MOCK_PAYMENT_SECRET` 없음)는 프로세스마다 무작위 비밀을 써서 밖에서 서명한 웹훅이 전부 401이다. 이 스킬의 launch로 띄운다.
- `NODE_ENV=production`이거나 `QRATE_PAYMENT_PROVIDER=none`이면 충전 폼 대신 "결제 제공자가 설정되지 않아" 안내가 보이고 웹훅은 404다. 그 상태를 PASS로 보고하지 않는다.
- 서명 웹훅 본문은 원문 바이트 그대로 보내야 한다(재직렬화하면 서명이 깨진다). 요청 컨텍스트에 문자열로 넘긴다.
