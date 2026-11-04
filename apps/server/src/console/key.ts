import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// 콘솔 로그인 키의 해시. 키는 사람이 정할 수 있어(낮은 엔트로피) 빠른 해시(sha256)가 아니라 scrypt를 쓴다 —
// DB가 새도 키를 되찾기 어렵게. Node 내장이라 의존성이 없다. 형식: scrypt$<salt base64url>$<hash base64url>
// 콘솔 결정(2026-11-04): 인증 단위는 테넌트(테넌트마다 키 하나). 검증 비용(수십 ms)이 로그인 시도 제한의 일부이기도 하다.

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// Node 기본값(N=16384, r=8, p=1). 메모리 16MB, 한 번에 수십 ms.
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } as const;

export function hashConsoleKey(key: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const hash = scryptSync(key, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return ['scrypt', salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/** 틀린 형식의 해시는 조용히 false — 로그인 실패와 같은 결과. 길이가 다르면 timingSafeEqual이 던지므로 먼저 거른다. */
export function verifyConsoleKey(key: string, stored: string | null): boolean {
  if (!stored) return false;
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = scryptSync(key, Buffer.from(saltB64, 'base64url'), KEY_LENGTH, SCRYPT_OPTIONS);
  return timingSafeEqual(actual, expected);
}
