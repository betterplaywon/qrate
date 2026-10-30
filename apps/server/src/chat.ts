import type { Request, Response } from 'express';
import { moderateInput } from './moderation.js';

// W2에서 실제 LLM 스트리밍으로 교체한다.
// 지금 단계의 목적: SSE "전송 형태"를 확정해 위젯 쪽 파서와 계약을 맺는 것.
const MOCK_ANSWER =
  '안녕하세요! 아직 목업 응답이지만, 이 글자들이 한 글자씩 도착하고 있다면 SSE 파이프라인은 정상입니다. W2에서 실제 모델 응답으로 교체됩니다.';

export function handleChat(req: Request, res: Response): void {
  const body = req.body as { message?: unknown } | undefined;
  const message = typeof body?.message === 'string' ? body.message : '';

  if (!message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  // 모더레이션은 토큰을 한 글자라도 내보내기 전에 수행한다.
  const moderation = moderateInput(message);
  if (moderation.level === 'block') {
    // 422: 요청 형식은 맞지만 내용 정책 위반. (400과 구분 — 면접 소재)
    res.status(422).json({ error: 'blocked_by_moderation', reasons: moderation.reasons });
    return;
  }

  // SSE 헤더. EventSource가 아니라 fetch 스트림으로 읽으므로 POST가 가능하다. (ADR-0002)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (moderation.level === 'warn') {
    // 경고 레벨은 응답을 계속하되, 위젯과 콘솔이 알 수 있게 별도 이벤트로 알린다.
    res.write(`event: moderation\ndata: ${JSON.stringify(moderation)}\n\n`);
  }

  // 목업 스트리밍: 글자 단위 전송. 실제 LLM도 "delta 조각의 연속"이라는 형태는 같다.
  const tokens = [...MOCK_ANSWER];
  let i = 0;
  const timer = setInterval(() => {
    const delta = tokens[i];
    if (delta === undefined) {
      res.write('data: [DONE]\n\n');
      clearInterval(timer);
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    i += 1;
  }, 25);

  // 클라이언트가 먼저 끊으면 타이머를 반드시 정리한다.
  // (Beyond Meet의 "통화 종료 시 모더레이션 interval 정리"와 같은 종류의 누수 방지)
  //
  // 주의: req.on('close')가 아니라 res.on('close')여야 한다.
  // 최신 Node에서 req의 'close'는 "요청 본문 수신 완료" 시점에 발생하므로,
  // req에 걸면 스트리밍이 시작하자마자 타이머가 정리되어 첫 토큰도 못 나간다.
  // (실제로 스모크 테스트에서 잡은 버그 — docs/reviews.md 2번 항목)
  res.on('close', () => clearInterval(timer));
}
