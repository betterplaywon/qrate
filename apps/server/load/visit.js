/* global __ENV */
// k6 시나리오(W6 부하 측정): 반복 한 번이 대화창을 연 방문자 한 명이다. 실행과 집계는 ladder.ts가 맡는다(load/README.md).
//   대화창 문서 → 인사말 → 위젯 열림 사건 → 생각 → 질문 1 + 첫 질문 사건 → 읽고 생각 → 질문 2(같은 대화) → 생각 → 떠남
// 위젯이 실제로 보내는 요청과 헤더를 따른다. 같은 오리진 POST에만 Origin이 붙고, GET(대화창 문서·인사말)에는 붙지 않는다.
// 대화창 정적 파일(app.js·app.css)은 브라우저 캐시가 받으므로 넣지 않았다.
import { sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:8789';
const TENANT = __ENV.TENANT || 'demo';
const SITE = __ENV.SITE_ORIGIN || 'http://localhost:5173';
/** 질문 사이 생각 시간의 평균(초). 실제로는 0.5배~1.5배에서 고르게 뽑는다. 사람보다 짧게 잡아 방문자 한 명이 내는 부하를 키웠다. */
const THINK_S = Number(__ENV.THINK_S || 3);
/** 질문 몇 개마다 하나를 넘김 턴(목업 훅 [[handoff]])으로 보낼지. 넘김 턴은 상담원 연결 행을 하나 더 쓴다. */
const HANDOFF_EVERY = Number(__ENV.HANDOFF_EVERY || 5);
const VUS = Number(__ENV.VUS || 10);
/** 방문자를 0명에서 VUS명까지 늘리는 시간(초). 모두 한꺼번에 들어오면 첫 몇 초가 실제와 다른 몰림이 된다. */
const RAMP_S = Number(__ENV.RAMP_S || 15);
/** VUS명을 유지하는 시간(초). 지표는 이 구간에 시작한 요청만 담는다. */
const HOLD_S = Number(__ENV.HOLD_S || 60);

const QUESTIONS = [
  '요금제가 어떻게 되나요?',
  '연간 결제하면 할인되나요?',
  '청구서를 카드로 결제받을 수 있나요?',
  '세금계산서도 발행되나요?',
  '팀원을 추가하려면 어떻게 하나요?',
  '견적서를 청구서로 바꿀 수 있나요?',
  '무료 플랜에서 몇 건까지 발행되나요?',
  '반복 청구는 어떻게 설정하나요?',
];

export const options = {
  scenarios: {
    visitors: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: `${RAMP_S}s`, target: VUS },
        { duration: `${HOLD_S}s`, target: VUS },
      ],
      gracefulRampDown: '30s',
      gracefulStop: '30s',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max', 'count'],
};

// 대화: 응답 첫 바이트(SSE 헤더가 나가는 순간 = 첫 조각을 받은 순간)와 스트림 끝까지.
const chatTtfb = new Trend('chat_ttfb', true);
const chatDuration = new Trend('chat_duration', true);
// 200이고 종료 센티널까지 왔으며 event: error가 없으면 성공.
const chatOk = new Rate('chat_ok');
const turns = new Counter('chat_turns');
// 대화 밖의 요청(대화창 문서·인사말·위젯 사건).
const frameDuration = new Trend('step_frame', true);
const greetingDuration = new Trend('step_greeting', true);
const eventDuration = new Trend('step_event', true);
const stepOk = new Rate('step_ok');

let asked = 0;

/** 유지 구간에 시작한 요청인가. 램프와 끝난 뒤 마무리(gracefulStop) 동안의 요청은 지표에 넣지 않는다. */
function inHold() {
  const elapsedS = exec.instance.currentTestRunDuration / 1000;
  return elapsedS >= RAMP_S && elapsedS < RAMP_S + HOLD_S;
}

function think(scale = 1) {
  sleep(THINK_S * scale * (0.5 + Math.random()));
}

function nextQuestion() {
  asked += 1;
  const q = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
  return asked % HANDOFF_EVERY === 0 ? `${q} [[handoff]]` : q;
}

function postJson(path, body, tags) {
  return http.post(`${BASE}${path}`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    tags,
  });
}

function step(trend, res, expectedStatus, measured) {
  if (!measured) return;
  trend.add(res.timings.duration);
  stepOk.add(res.status === expectedStatus);
}

function sendEvent(type, variant) {
  const measured = inHold();
  const res = postJson('/api/events', variant ? { tenant: TENANT, type, variant } : { tenant: TENANT, type }, { step: 'event' });
  step(eventDuration, res, 202, measured);
}

function ask(message, conversationId) {
  const measured = inHold();
  const res = postJson('/api/chat', conversationId ? { tenant: TENANT, message, conversationId } : { tenant: TENANT, message }, {
    step: 'chat',
  });
  if (measured) {
    const ok = res.status === 200 && typeof res.body === 'string' && res.body.includes('data: [DONE]') && !res.body.includes('event: error');
    chatOk.add(ok);
    turns.add(1);
    if (res.status === 200) {
      chatTtfb.add(res.timings.waiting);
      chatDuration.add(res.timings.duration);
    }
  }
  return res.headers['X-Conversation-Id'] || null;
}

export default function visit() {
  let measured = inHold();
  const frame = http.get(`${BASE}/frame?t=${TENANT}&o=${encodeURIComponent(SITE)}`, { tags: { step: 'frame' } });
  step(frameDuration, frame, 200, measured);

  measured = inHold();
  const greeting = http.get(`${BASE}/api/greeting?tenant=${TENANT}`, { tags: { step: 'greeting' } });
  step(greetingDuration, greeting, 200, measured);
  const variant = greeting.status === 200 ? greeting.json('greeting.variant') : null;
  sendEvent('widget_open', variant);

  think();
  // 위젯은 첫 질문을 보내는 순간 사건도 보낸다(서버 결과와 무관). k6 요청은 차례로 가므로 질문 바로 앞에 둔다.
  sendEvent('first_question', variant);
  const conversationId = ask(nextQuestion(), null);

  think();
  ask(nextQuestion(), conversationId);
  think();
}
