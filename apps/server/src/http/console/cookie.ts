import { CONSOLE_API_PATH } from '@qrate/contracts';
import { parseCookie, stringifySetCookie } from 'cookie';
import type { Request } from 'express';

// 콘솔 세션 쿠키. 이름 하나, 값은 JWT(console/session.ts).
// Path=/api/console — 이 API에만 실린다. HttpOnly — 페이지 스크립트가 읽을 수 없다. SameSite=Strict — 다른 사이트에서 시작한
// 요청에는 실리지 않는다. 공개 오리진이 https면 Secure.

export const SESSION_COOKIE = 'qrate_console';

export interface SessionCookieOptions {
  secure: boolean;
  /** 0이면 삭제(로그아웃). */
  maxAgeSec: number;
}

export function sessionCookie(token: string, { secure, maxAgeSec }: SessionCookieOptions): string {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: token,
    path: CONSOLE_API_PATH,
    httpOnly: true,
    sameSite: 'strict',
    maxAge: maxAgeSec,
    secure,
  });
}

/** 요청의 쿠키 헤더에서 세션 토큰만. 없으면 null. */
export function readSessionToken(req: Request): string | null {
  return parseCookie(req.headers.cookie ?? '')[SESSION_COOKIE] ?? null;
}
