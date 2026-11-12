import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// 콘솔 로그인 키의 해시. 키는 사람이 정할 수 있어(낮은 엔트로피) 빠른 해시(sha256)가 아니라 scrypt를 쓴다 —
// DB가 새도 키를 되찾기 어렵게. Node 내장이라 의존성이 없다. 형식: scrypt$<salt base64url>$<hash base64url>
// 콘솔 결정(2026-11-04): 인증 단위는 테넌트(테넌트마다 키 하나). 검증 비용(수십 ms)이 로그인 시도 제한의 일부이기도 하다.

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// Node 기본값(N=16384, r=8, p=1). 메모리 16MB, 한 번에 수십 ms.
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } as const;
const scryptAsync = promisify<string, Buffer, number, typeof SCRYPT_OPTIONS, Buffer>(scrypt);

/** 발급하는 콘솔 키의 앞머리. 키가 로그·코드·채팅에 새어 나갔을 때 비밀 스캐너와 사람이 알아보게 한다. */
export const CONSOLE_KEY_PREFIX = 'qrc_';

/** 서버가 발급하는 콘솔 키: 앞머리 + 무작위 32바이트(base64url 43자). 사람이 정한 키와 달리 추측할 수 없다. */
export function generateConsoleKey(): string {
  return CONSOLE_KEY_PREFIX + randomBytes(32).toString('base64url');
}

/**
 * 저장된 해시의 지문. 로그인 세션이 이 값을 품고, 콘솔 요청마다 테넌트의 지금 해시와 맞춰 본다.
 * 키를 다시 발급하거나 회수하면 해시가 바뀌어(소금이 새로 붙는다) 그 전에 받은 세션이 바로 끝난다.
 * 세션 토큰은 서명만 되고 암호화되지 않으므로, 해시를 그대로 싣지 않고 한 번 더 줄인 값을 싣는다.
 */
export function consoleKeyFingerprint(hash: string): string {
  return createHash('sha256').update(hash).digest('base64url').slice(0, 22);
}

/** 시드·설정·발급 명령에서 한 번 쓰는 쪽이라 동기. */
export function hashConsoleKey(key: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const hash = scryptSync(key, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return ['scrypt', salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/**
 * 로그인 때 쓰는 쪽이라 비동기 — scrypt가 이벤트 루프를 수십 ms 막지 않게(스레드 풀에서 돈다).
 * 틀린 형식의 해시는 조용히 false — 로그인 실패와 같은 결과. 길이가 다르면 timingSafeEqual이 던지므로 먼저 거른다.
 */
export async function verifyConsoleKey(key: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await scryptAsync(key, Buffer.from(saltB64, 'base64url'), KEY_LENGTH, SCRYPT_OPTIONS);
  return timingSafeEqual(actual, expected);
}
