import type { ApiErrorBody, ApiErrorCode } from '@qrate/contracts';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ErrorReporter } from '../report.js';

// 계약 밖의 실패도 계약의 오류 본문(JSON)으로 답한다. Express 기본 핸들러에 맡기면 HTML 페이지가 나가고,
// 기본 핸들러는 오류 객체를 통째로 찍는데 body-parser의 오류 객체에는 요청 본문이 들어 있어 사용자 메시지가 로그에 남는다.

/**
 * express.json(body-parser)의 실패인가. type과 4xx status가 함께 있으면 클라이언트 쪽 문제다 —
 * 32kb 초과는 413 그대로, 그 밖(JSON 아님, 문자셋·인코딩 미지원)은 400으로 답한다.
 */
function bodyParserFailure(err: unknown): { status: number; code: ApiErrorCode } | null {
  if (typeof err !== 'object' || err === null) return null;
  const { type, status } = err as { type?: unknown; status?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number' || status < 400 || status >= 500) return null;
  return type === 'entity.too.large' ? { status: 413, code: 'payload_too_large' } : { status: 400, code: 'invalid_json' };
}

/** 모르는 경로. 라우터들 뒤, 오류 핸들러 앞에 둔다. */
export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'not_found' } satisfies ApiErrorBody);
};

/** 라우트가 던진 예외. Express 5는 async 핸들러의 거절도 여기로 보낸다. 본문은 보고 통로에 넘기지 않는다. */
export function createErrorHandler(reportError: ErrorReporter): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const failure = bodyParserFailure(err);
    if (failure) {
      res.status(failure.status).json({ error: failure.code } satisfies ApiErrorBody);
      return;
    }
    reportError(err, { where: 'express', method: req.method, path: req.path });
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({ error: 'internal_error' } satisfies ApiErrorBody);
  };
}
