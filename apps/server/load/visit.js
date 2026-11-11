/* global __ENV */
// 위젯이 실제로 보내는 요청과 헤더를 따른다. 같은 오리진 POST에만 Origin이 붙고, GET(대화창 문서·정적 파일·인사말)에는 붙지 않는다.
import { sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:8789';
const TENANT = __ENV.TENANT || 'demo';
const SITE = __ENV.SITE_ORIGIN || 'http://localhost:5173';
const THINK_S = Number(__ENV.THINK_S || 3);
const HANDOFF_EVERY = Number(__ENV.HANDOFF_EVERY || 5);
const VUS = Number(__ENV.VUS || 10);
const RAMP_S = Number(__ENV.RAMP_S || 15);
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

const chatTtfb = new Trend('chat_ttfb', true);
const chatDuration = new Trend('chat_duration', true);
const chatOk = new Rate('chat_ok');
const turns = new Counter('chat_turns');
const frameDuration = new Trend('step_frame', true);
const assetDuration = new Trend('step_assets', true);
const greetingDuration = new Trend('step_greeting', true);
const eventDuration = new Trend('step_event', true);
const stepOk = new Rate('step_ok');

let asked = 0;

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

const JSON_HEADERS = { 'Content-Type': 'application/json', Origin: BASE };

function postJson(path, body, tags) {
  return http.post(`${BASE}${path}`, JSON.stringify(body), { headers: JSON_HEADERS, tags });
}

function eventBody(type, variant) {
  return variant ? { tenant: TENANT, type, variant } : { tenant: TENANT, type };
}

function step(trend, res, expectedStatus, measured) {
  if (!measured) return;
  trend.add(res.timings.duration);
  stepOk.add(res.status === expectedStatus);
}

function sendEvent(type, variant) {
  const measured = inHold();
  const res = postJson('/api/events', eventBody(type, variant), { step: 'event' });
  step(eventDuration, res, 202, measured);
}

// 위젯은 첫 질문 사건을 기다리지 않고 보내고 곧바로 질문을 보낸다. 두 요청이 겹쳐 서버에 닿는다.
function sendEventWithoutWaiting(type, variant) {
  const measured = inHold();
  http
    .asyncRequest('POST', `${BASE}/api/events`, JSON.stringify(eventBody(type, variant)), { headers: JSON_HEADERS, tags: { step: 'event' } })
    .then((res) => step(eventDuration, res, 202, measured));
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

  // 방문자마다 캐시가 빈 브라우저다. 문서를 읽은 브라우저처럼 두 파일을 함께 받는다.
  measured = inHold();
  const assets = http.batch(
    ['app.js', 'app.css'].map((file) => ['GET', `${BASE}/frame/${file}`, null, { tags: { step: 'assets' } }]),
  );
  for (const res of assets) step(assetDuration, res, 200, measured);

  measured = inHold();
  const greeting = http.get(`${BASE}/api/greeting?tenant=${TENANT}`, { tags: { step: 'greeting' } });
  step(greetingDuration, greeting, 200, measured);
  const variant = greeting.status === 200 ? greeting.json('greeting.variant') : null;
  sendEvent('widget_open', variant);

  think();
  sendEventWithoutWaiting('first_question', variant);
  const conversationId = ask(nextQuestion(), null);

  think();
  ask(nextQuestion(), conversationId);
  think();
}
