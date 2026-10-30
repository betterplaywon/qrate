// Sentry가 가장 먼저 로드되어야 한다 — 아래 import 순서는 의도된 것. (src/sentry.ts 참고)
import { Sentry, sentryEnabled } from './sentry.js';
import express from 'express';
import { handleChat } from './chat.js';

const app = express();
app.use(express.json({ limit: '32kb' })); // 채팅 입력에 32kb면 충분 — 과대 페이로드 차단

// CORS: W1 데모용 전체 허용.
// W2에서 테넌트별 허용 도메인 목록으로 좁힌다(위젯이 남의 사이트에 임베드되므로 필수 설계 지점).
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.options('/api/chat', (_req, res) => {
  res.sendStatus(204);
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, sentry: sentryEnabled });
});

app.post('/api/chat', handleChat);

// Sentry 에러 핸들러는 라우트 등록 "이후", 리스닝 "이전"에 단다.
if (sentryEnabled) {
  Sentry.setupExpressErrorHandler(app);
}

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
});
