import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { toEngineError } from '../src/engine/claude.js';
import { EngineError } from '../src/engine/types.js';
import { statusFor } from '../src/http/chat.js';

// SDK 예외 → 엔진 오류 코드·재시도 여부(engine/claude.ts), 코드 → HTTP 상태(http/chat.ts). 실제 API 호출 없이 고정한다.

const headers = new Headers();

describe('toEngineError — SDK 예외를 계약으로', () => {
  it('상태 코드별 예외 클래스', () => {
    expect(toEngineError(new Anthropic.AuthenticationError(401, {}, 'auth', headers))).toMatchObject({
      code: 'upstream_auth',
      retryable: false,
    });
    expect(toEngineError(new Anthropic.PermissionDeniedError(403, {}, 'perm', headers))).toMatchObject({ code: 'upstream_auth' });
    expect(toEngineError(new Anthropic.RateLimitError(429, {}, 'rl', headers))).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    expect(toEngineError(new Anthropic.BadRequestError(400, {}, 'bad', headers))).toMatchObject({
      code: 'upstream_bad_request',
      retryable: false,
    });
    expect(toEngineError(new Anthropic.InternalServerError(500, {}, 'ise', headers))).toMatchObject({
      code: 'upstream_unavailable',
      retryable: true,
    });
    expect(toEngineError(new Anthropic.APIConnectionError({ message: 'conn' }))).toMatchObject({
      code: 'upstream_unavailable',
      retryable: true,
    });
    expect(toEngineError(new Anthropic.APIUserAbortError())).toMatchObject({ code: 'aborted', retryable: false });
  });

  it('인증 실패 메시지는 그대로 내보내지 않는다 — 비밀값이 섞일 수 있다', () => {
    const e = toEngineError(new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key sk-ant-…', headers));
    expect(e.message).toBe('upstream rejected credentials');
  });

  it('스트림 도중 event: error는 상태 없는 APIError — overloaded·api_error는 재시도 가능, rate_limit은 rate_limited, 그 밖은 upstream_error', () => {
    const midStream = (type: string) =>
      new Anthropic.APIError(
        undefined,
        { type: 'error', error: { type, message: 'x' } },
        undefined,
        undefined,
        type as ConstructorParameters<typeof Anthropic.APIError>[4],
      );
    expect(toEngineError(midStream('overloaded_error'))).toMatchObject({ code: 'upstream_unavailable', retryable: true });
    expect(toEngineError(midStream('api_error'))).toMatchObject({ code: 'upstream_unavailable', retryable: true });
    expect(toEngineError(midStream('rate_limit_error'))).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(toEngineError(midStream('invalid_request_error'))).toMatchObject({ code: 'upstream_error', retryable: false });
  });

  it('이미 계약의 오류면 그대로, 모르는 예외는 upstream_error', () => {
    const own = new EngineError('rate_limited', true, 'mine');
    expect(toEngineError(own)).toBe(own);
    expect(toEngineError(new TypeError('boom'))).toMatchObject({ code: 'upstream_error', retryable: false, message: 'boom' });
    expect(toEngineError('string')).toMatchObject({ code: 'upstream_error', message: 'string' });
  });
});

describe('statusFor — 코드 → 첫 이벤트 전 실패의 HTTP 상태', () => {
  it('재시도 가능한 코드는 503, 상류 문제는 502, 우리 요청이 잘못된 것은 500', () => {
    expect(statusFor('rate_limited')).toBe(503);
    expect(statusFor('upstream_unavailable')).toBe(503);
    expect(statusFor('upstream_auth')).toBe(502);
    expect(statusFor('upstream_error')).toBe(502);
    expect(statusFor('upstream_bad_request')).toBe(500);
  });
});
