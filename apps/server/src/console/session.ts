import { SignJWT, jwtVerify } from 'jose';

// 콘솔 세션 = 서명된 JWT(HS256, jose). HttpOnly 쿠키에 담긴다. 내용은 sub(테넌트 id)·kfp(콘솔 키 지문)·iat·exp이고 서버 비밀(QRATE_CONSOLE_SECRET)로
// 서명한다. 세션 테이블이 없어 서버가 여럿이어도 비밀만 같으면 검증된다. 비밀을 바꾸면 모든 세션이 끊긴다(=강제 로그아웃).
// 한 테넌트의 세션만 끊는 길은 kfp다: 콘솔 키를 다시 발급하거나 회수하면 지문이 달라져 requireSession이 그 세션을 거절한다.
// 직접 HMAC을 조립하지 않고 jose를 쓰는 이유: 서명·만료·알고리즘 고정(alg 혼동 방지)을 검증된 구현에 맡긴다.
// 콘솔 결정(2026-11-04): 인증 A — 테넌트 콘솔 키 + 서명된 HttpOnly 쿠키.

export interface ConsoleSession {
  tenantId: string;
  /** 로그인할 때 그 테넌트 콘솔 키 해시의 지문(console/key.ts consoleKeyFingerprint). */
  keyFingerprint: string;
  /** ms epoch. JWT 클레임(초)에서 환산한다. */
  issuedAt: number;
  expiresAt: number;
}

export interface SessionCodec {
  readonly ttlMs: number;
  issue(tenantId: string, keyFingerprint: string, now?: Date): Promise<string>;
  /** 서명이 틀리거나, 모양이 다르거나, 만료됐으면 null. 이유는 구분하지 않는다 — 어느 쪽이든 다시 로그인. */
  verify(token: string, now?: Date): Promise<ConsoleSession | null>;
}

/** 12시간. 운영자가 하루 일과 중 다시 로그인하지 않을 만큼이고, 분실한 브라우저가 열려 있는 기간을 그 이상 늘리지 않는다. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MIN_SECRET_LENGTH = 16;
const ALG = 'HS256';

export function createSessionCodec(secret: string, ttlMs: number = SESSION_TTL_MS): SessionCodec {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`console session secret must be at least ${MIN_SECRET_LENGTH} chars`);
  const key = new TextEncoder().encode(secret);

  return {
    ttlMs,
    issue(tenantId, keyFingerprint, now = new Date()) {
      return new SignJWT({ kfp: keyFingerprint })
        .setProtectedHeader({ alg: ALG })
        .setSubject(tenantId)
        .setIssuedAt(now)
        .setExpirationTime(new Date(now.getTime() + ttlMs))
        .sign(key);
    },
    async verify(token, now = new Date()) {
      try {
        // algorithms를 고정한다 — 헤더의 alg를 믿지 않는다. exp는 jose가 currentDate 기준으로 검사한다.
        const { payload } = await jwtVerify(token, key, { algorithms: [ALG], currentDate: now });
        // kfp가 없는 토큰(이 필드가 생기기 전에 받은 세션)은 지문을 맞춰 볼 수 없으니 다시 로그인하게 한다.
        if (!payload.sub || typeof payload.kfp !== 'string' || payload.iat === undefined || payload.exp === undefined) return null;
        return { tenantId: payload.sub, keyFingerprint: payload.kfp, issuedAt: payload.iat * 1000, expiresAt: payload.exp * 1000 };
      } catch {
        return null;
      }
    },
  };
}
