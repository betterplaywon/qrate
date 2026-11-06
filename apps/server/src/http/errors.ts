import type { ApiErrorBody, ApiErrorCode } from '@qrate/contracts';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ErrorReporter } from '../report.js';

// 계약 밖의 실패도 계약의 오류 본문(JSON)으로 답한다. Express 기본 핸들러에 맡기면 HTML 페이지가 나가고,
// 기본 핸들러는 오류 객체를 통째로 찍는데 body-parser의 오류 객체에는 요청 본문이 들어 있어 사용자 메시지가 로그에 남는다.

/**
 * 클라이언트가 잘못 보낸 요청이라 운영자에게 알릴 일이 아닌가. status만 보면 외부 SDK 오류처럼 4xx를 단 서버 쪽 실패까지 숨긴다.
 * body-parser: 실패를 http-errors로 만들어 expose: true를 단다. 압축 해제 실패에는 type이 없어 type으로는 가릴 수 없다.
 * 라우터: 경로 매개변수의 퍼센트 인코딩이 깨지면 status 400을 단 URIError를 던진다. 그런 경로의 자원은 없다.
 */
function clientFailure(err: unknown): { status: number; code: ApiErrorCode } | null {
  if (typeof err !== 'object' || err === null) return null;
  const { status, expose } = err as { status?: unknown; expose?: unknown };
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;
  if (err instanceof URIError) return { status: 404, code: 'not_found' };
  if (expose !== true) return null;
  return status === 413 ? { status: 413, code: 'payload_too_large' } : { status: 400, code: 'invalid_json' };
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
