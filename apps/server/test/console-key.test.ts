import { describe, expect, it } from 'vitest';
import { hashConsoleKey, verifyConsoleKey } from '../src/console/key.js';

describe('콘솔 키 해시', () => {
  it('같은 키는 통과, 다른 키·빈 해시·깨진 형식은 실패. 해시마다 소금이 달라 원문이 같아도 값이 다르다', async () => {
    const a = hashConsoleKey('demo-console');
    const b = hashConsoleKey('demo-console');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(await verifyConsoleKey('demo-console', a)).toBe(true);
    expect(await verifyConsoleKey('demo-console', b)).toBe(true);
    expect(await verifyConsoleKey('demo-consol', a)).toBe(false);
    expect(await verifyConsoleKey('demo-console', null)).toBe(false);
    expect(await verifyConsoleKey('demo-console', 'sha256$x$y')).toBe(false);
    expect(await verifyConsoleKey('demo-console', 'scrypt$')).toBe(false);
    expect(await verifyConsoleKey('demo-console', 'scrypt$abc$short')).toBe(false);
  });
});
