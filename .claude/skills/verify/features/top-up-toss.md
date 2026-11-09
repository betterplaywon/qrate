# 토스 테스트 결제

서버가 토스 결제 제공자(`QRATE_PAYMENT_PROVIDER=toss`, 결제창형 테스트 키)로 뜨면 콘솔 "크레딧" 화면의 버튼이 "결제하기"가 되고, 누르면 대기 주문이 생긴 뒤 토스 결제창(토스 SDK, 결제창형)이 콘솔 위에 뜬다. 결제를 마치면 토스가 `/console/?toss=success&…`로 돌려보내고 콘솔이 서버에 확정을 청한다. 서버는 토스 승인 API를 부르고, 답이 결제 객체가 아니면 조회 API로 다시 묻는다. 실패하거나 결제창을 닫으면 주문은 결제 대기로 남는다. 이 여정은 결제를 끝내지 않는다. 결제창의 인증은 사람이 한다.

## Sub-features

- `toss-csp` 토스일 때 `GET /console/`의 CSP가 측정한 토스 호스트(script-src 1, connect-src 4, frame-src 3)만 연다. 와일드카드 없음.
- `toss-open` 로그인 뒤 `#/billing`에 잔액 100과 "결제하기", `GET /api/console/top-ups`의 `provider`가 `toss`이고 `clientKey`가 `test_gck_`로 시작한다. 이때까지 토스로 나간 요청 0건.
- `toss-window` 100크레딧으로 "결제하기" → 201 대기 주문 → 토스 결제창 iframe(`payment-widget.tosspayments.com`)이 뜨고 우리 문서의 CSP 위반 0건.
- `toss-unknown-payment` 토스가 모르는 결제 키로 성공 주소에 돌아오면 확정 응답 200 `{"outcome":"unconfirmed"}`, 안내 "토스에서 결제 완료를 아직 확인하지 못했어요." + "다시 확인", 주소의 쿼리는 남고 해시는 `#/billing`, server.log에 승인·조회 답(`confirm 404 …; lookup 404 …`).
- `toss-fail-return` 실패 주소(`code=PAY_PROCESS_CANCELED`, 임의 `message`)로 돌아오면 "결제를 취소했어요. 주문은 결제 대기로 남아요."만 보이고 `message` 문장은 화면에 없으며 주소는 `/console/#/billing`.
- `toss-ledger` 잔액 100 그대로, 주문은 결제 대기.

## How to get to it (user POV)

- 콘솔 `http://localhost:8787/console/` 로그인 → 머리글 "크레딧" → "충전" 절의 "결제하기".
- 결제창에서 돌아오는 주소: 성공 `/console/?toss=success&paymentType=…&orderId=…&paymentKey=…&amount=…`, 실패 `/console/?toss=fail&code=…&message=…&orderId=…`.
- 토스 쪽 입구(배포 뒤): `POST /api/payments/toss/webhook`(PAYMENT_STATUS_CHANGED). 로컬 서버에는 토스가 닿지 못해 이 여정은 다루지 않는다.

## Driving it with verify

Preconditions:

- 결제창형 테스트 키 한 쌍을 실행 환경으로 넘긴다: `QRATE_VERIFY_TOSS_CLIENT_KEY`(test_gck_…)·`QRATE_VERIFY_TOSS_SECRET_KEY`(test_gsk_…). 토스 공식 샘플(github.com/tosspayments/tosspayments-sample)의 공개 키나 본인 키. launch는 이 두 값만 서버 env의 `QRATE_TOSS_CLIENT_KEY`·`QRATE_TOSS_SECRET_KEY`로 옮기고 run.json·증거에 남기지 않는다. 없으면 `LAUNCH FAIL`.
- `node .claude/skills/verify/scripts/launch.mjs top-up-toss` → `doctor.mjs`가 `DOCTOR OK`. server.log에 `[server] payments=toss keys=env(결제창형 테스트 키)`.
- 실행: `node .claude/skills/verify/scripts/drive.mjs`. 한 번에 실제 토스 호출은 결제창 1회, 승인 1회, 조회 1회다.

- **CSP(`toss-csp`).** `GET /console/` → `content-security-policy`에 `script-src 'self' https://js.tosspayments.com`, `connect-src 'self' https://api.tosspayments.com https://apigw-sandbox.tosspayments.com https://event.tosspayments.com https://log.tosspayments.com`, `frame-src 'self' https://payment-widget.tosspayments.com https://payment-gateway-sandbox.tosspayments.com https://toss.im`, `frame-ancestors 'none'`.
- **열기(`toss-open`).** 로그인 → `#/billing` → `getByTestId('credit-balance')` "100", 버튼 "결제하기" → 목록 API `provider: 'toss'` → 페이지가 `*.tosspayments.com`·`toss.im`에 보낸 요청 0건.
- **결제창(`toss-window`).** `getByTestId('package-credits_100')` 체크 → "결제하기" → `POST /api/console/top-ups` 201(`provider: 'toss'`, `status: 'pending'`) → `payment-widget.tosspayments.com` 프레임이 생김 → `securitypolicyviolation` 0건.
- **모르는 결제 키(`toss-unknown-payment`).** `page.goto('/console/?toss=success&paymentType=NORMAL&orderId=<주문 id>&paymentKey=tgen_verify_<무작위>&amount=10000')` → `POST /api/console/top-ups/<주문 id>/confirm` 200 `unconfirmed` → `getByTestId('toss-return')` 안내와 "다시 확인" → 주소 쿼리 유지·해시 `#/billing` → server.log `"where":"billing.confirm"` 줄의 detail에 `confirm 404`·`lookup 404`.
- **실패 주소(`toss-fail-return`).** `page.goto('/console/?toss=fail&code=PAY_PROCESS_CANCELED&message=<임의 문장>&orderId=<주문 id>')` → `toss-return` "결제를 취소했어요. 주문은 결제 대기로 남아요." → 페이지에 그 문장 없음 → 주소 `/console/#/billing`.
- **원장(`toss-ledger`).** `GET /api/console/credits` 잔액 100 → 목록에서 그 주문 `pending` → 새로 고쳐도 "100".
- **Proof.** `steps.md`, `01-toss-csp.png`~`06-toss-ledger.png`(03: 콘솔 위의 토스 결제창), `console-csp.txt`, `csp-violations.json`, `toss-requests.json`(토스로 간 요청의 호스트·경로), `confirm-unknown-payment.json.txt`, `top-ups-before.json`·`top-ups-after.json`(clientKey는 앞 9자만), `console-credits.json`, `server.log`, `trace.zip`.

## Gotchas

- 이 여정은 바깥 서비스(토스 테스트 환경)를 부른다. 개발 중 실제 호출 상한(2026-11-09 사용자 결정: 결제창 20·승인 10·조회 10회, 공개 샘플 키)을 세면서 돌린다. 반복 실행으로 상한을 넘기지 않는다.
- 결제를 끝내는 경로(승인 성공)는 이 여정에 없다. 테스트 카드 번호가 없어 결제창의 인증은 사람이 한다. 승인 성공은 사용자 실측으로 따로 남긴다. 이 여정의 PASS를 승인 성공의 증거로 보고하지 않는다.
- 토스 공개 키는 남과 함께 쓰는 키라 분당 제한에 걸리면 결제창이 늦게 뜨거나 확정이 503 대신 `unconfirmed`로 끝날 수 있다. 몇 분 뒤 다시 돌린다.
- `toss-requests.json`에는 토스 결제창 iframe 안의 문서가 보낸 요청(`frontend-storage`·`homepage-api-gateway` 등)도 들어 있다. 그 요청은 토스 문서의 정책을 따르고 우리 CSP와는 무관하다. 우리 정책의 판정은 `csp-violations.json`(우리 문서의 `securitypolicyviolation`)으로 한다.
- CSP의 `-sandbox` 호스트는 테스트 모드 것이다. 상점의 결제수단 설정이 다르면 호스트가 더 필요할 수 있고, 그때는 `csp-violations.json`에 막힌 주소가 남는다.
- 키를 넘기지 않고 띄운 서버(`top-up` 등 다른 여정)는 모의 제공자라 "결제하기" 대신 "충전 요청"이 보인다. 그 상태를 이 여정의 PASS로 보고하지 않는다.
- 증거마다 기능 id와 들어간 입구를 적는다. 닿지 못한 경로는 시도한 명령과 못 채운 전제를 적는다.
