# ADR-0003: 위젯 격리 전략 — Shadow DOM 단일 vs iframe + postMessage

- 상태: proposed → 본인이 결정·트레이드오프를 채운 뒤 accepted로 변경할 것
- 날짜: 2026-11-01
- 작성: 강지원

> 왜 이 ADR이 필요한가: 초기 설계 목표에는 "Shadow DOM 격리"와 함께 "postMessage 통신"(iframe 기반 구조)이
> 있었지만, W1 스캐폴드(`packages/widget/src/index.ts`)는 iframe 없이
> **호스트 문서 안에서 Shadow DOM만으로** 동작한다. postMessage는 어디에도 없다.
> 설계 목표와 코드 중 하나는 고쳐야 하며, 그 결정을 여기 남긴다.

## 맥락

위젯은 남의 사이트(고객 사이트)에 스크립트 한 줄로 삽입된다. 격리해야 할 것은 세 가지다.

1. **CSS**: 호스트의 전역 스타일이 위젯을 깨뜨리거나, 위젯 CSS가 호스트로 새는 것.
2. **JS 전역 스코프**: 호스트 스크립트와 위젯 코드가 같은 `window`를 공유하는 것.
3. **오리진(보안 경계)**: 호스트 페이지의 XSS가 위젯의 상태·대화 내용에 손대는 것.

현재 구조는 1번만 격리한다 (`:host { all: initial }` + `attachShadow({ mode: 'open' })`).
`mode: 'open'`이므로 호스트 스크립트는 `host.shadowRoot`로 내부 DOM에 접근할 수 있다.

## 고려한 대안

| 대안 | 장점 | 단점 |
| --- | --- | --- |
| A. Shadow DOM 단일 (현재) | 번들 하나·스크립트 요청 하나로 동작(W1 `widget.js`), 호스트 문서 안이라 열림·크기를 맞출 메시지가 없음 | 호스트와 같은 `window`·오리진이라 JS·오리진 격리가 없음(호스트 XSS가 곧 위젯 XSS), `mode: 'open'`이면 호스트 스크립트가 `host.shadowRoot`로 대화 DOM을 읽음, 대화 API를 호스트 오리진에서 불러 CORS가 필요(W1은 `Access-Control-Allow-Origin: *`) |
| B. iframe(위젯 오리진) + 런처만 호스트에 + postMessage 브리지 | 다른 오리진 iframe이라 호스트 스크립트가 대화 DOM에 닿지 못하고 `postMessage`로만 주고받음, 대화 API가 같은 오리진이라 CORS가 없음(상대 경로 `/api/chat`), 대화창 문서는 `no-store`·앱 번들은 매번 재검증이라 배포가 다음 열림에 반영 | 로더 뒤 iframe 문서·앱 번들을 한 번 더 받음(열 때 `/frame`·`app.js`·`app.css`), 열림·닫힘·안 읽은 수를 `postMessage`로 맞추고 받는 쪽마다 오리진·창·형식을 검사, iframe 저장소는 최상위 사이트별로 분할(Chrome 115+, Firefox 103+) |
| C. 하이브리드 — 런처·패널 셸은 Shadow DOM, 대화 영역만 iframe | 패널 틀(크기·위치·열림)을 호스트 CSS가 정해 크기를 맞출 메시지가 없음, 대화 내용·API 호출은 서버 오리진 iframe 안이라 호스트 스크립트가 못 읽음, 대화창 iframe은 처음 열 때 만들어 열지 않은 방문자는 대화창 문서를 받지 않음 | 번들 둘(런처 IIFE·대화창 앱)에 열 때 iframe 문서·자산을 받는 2단 로딩, 패널 틀과 대화 영역이 다른 문서라 닫기·Esc·안 읽은 수를 `postMessage`로 주고받음, iframe 저장소는 최상위 사이트별로 분할 |

## 결정

(본인 작성 — A를 유지한다면 설계 목표에서 "postMessage 통신"을 빼고,
B/C로 간다면 W2 위젯 작업 범위에 로더/iframe 분리를 넣는다.)

## 스스로 답해볼 유도 질문

1. 이 위젯이 다루는 데이터 중 호스트 사이트가 **보면 안 되는** 것이 있는가? (대화 내용? 테넌트 키는 공개값)
   없다면 오리진 격리의 효익은 무엇으로 정당화되는가 — 혹은 정당화되지 않는가?
2. `mode: 'closed'`로 바꾸면 무엇이 달라지고, 무엇은 달라지지 않는가?
3. 채널톡·인터콤이 iframe을 쓰는 이유 중 "우리 규모(1~10인 고객사)"에도 해당하는 것은?
4. LINE·슬랙 핸드오프 알림이나 W3 사람 연결에서 위젯↔콘솔 간 실시간 통신이 생기면 결정이 바뀌는가?
5. README에 채널톡 대비 설계 트레이드오프를 쓴다면 이 결정을 어떻게 한 줄로 쓸 것인가?

## 트레이드오프

(본인 작성)

## 결과 확인 방법

- `packages/widget/demo.html`의 공격적 전역 CSS(`* { font-family: serif !important; color: red }`) 아래에서 위젯 스타일이 유지되는지 — CSS 격리 검증.
- (B/C 선택 시) 호스트 콘솔에서 `document.querySelector('#qrate-host').shadowRoot`로 대화 DOM에 접근 **불가**함을 확인 — 오리진 격리 검증.
