import type { ApiErrorBody, ApiErrorCode } from '@qrate/contracts';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ErrorReporter } from '../report.js';

// 계약 밖의 실패도 계약의 오류 본문(JSON)으로 답한다. Express 기본 핸들러에 맡기면 HTML 페이지가 나가고,
// 기본 핸들러는 오류 객체를 통째로 찍는데 body-parser의 오류 객체에는 요청 본문이 들어 있어 사용자 메시지가 로그에 남는다.

/**
 * 클라이언트 쪽 문제인가. 4xx status를 단 오류가 그렇다 — 지금은 body-parser와 라우터만 이런 오류를 만든다.
 * body-parser: 본문 상한 초과는 413, 그 밖(JSON 아님, 문자셋·인코딩 미지원, 압축 해제 실패)은 400. 압축 해제 실패에는 type이 없다.
 * 라우터: 경로 매개변수의 퍼센트 인코딩이 깨지면 URIError(400)를 던진다. 그런 자원은 없으므로 404로 답한다.
 */
function clientFailure(err: unknown): { status: number; code: ApiErrorCode } | null {
  if (typeof err !== 'object' || err === null) return null;
  const { status } = err as { status?: unknown };
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;
  if (status === 413) return { status: 413, code: 'payload_too_large' };
  if (err instanceof URIError) return { status: 404, code: 'not_found' };
  return { status: 400, code: 'invalid_json' };
}

/** 모르는 경로. 라우터들 뒤, 오류 핸들러 앞에 둔다. */
export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'not_found' } satisfies ApiErrorBody);
};

/** 라우트가 던진 예외. Express 5는 async 핸들러의 거절도 여기로 보낸다. 본문은 보고 통로에 넘기지 않는다. */
export function createErrorHandler(reportError: ErrorReporter): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const failure = clientFailure(err);
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
