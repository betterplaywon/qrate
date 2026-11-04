import type { ApiErrorBody, ApiErrorCode } from '@qrate/contracts';
import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

// IP당 고정 창 요율 제한(express-rate-limit). 넘으면 계약의 오류 본문(JSON)으로 429. 콘솔 로그인(무차별 대입)과
// 상담원 연결 접수(공개 쓰기)가 같은 모양으로 쓴다 — 코드만 다르다.
// 프로세스 메모리에 센다(서버 하나). 프록시 뒤에서는 app.set('trust proxy', …)가 있어야 req.ip가 실제 클라이언트다.

export interface RateLimitOptions {
  max: number;
  windowMs: number;
  /** 넘었을 때의 오류 코드. */
  code: ApiErrorCode;
}

export function jsonRateLimit({ max, windowMs, code }: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: code } satisfies ApiErrorBody);
    },
  });
}
