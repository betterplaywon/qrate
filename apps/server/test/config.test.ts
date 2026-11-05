import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('QRATE_PAYMENT_PROVIDER', () => {
  it('auto(기본)는 NODE_ENV가 development·test일 때만 mock이고, 비어 있거나 그 밖이면 none', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).paymentProvider).toBe('mock');
    expect(loadConfig({ NODE_ENV: 'test' }).paymentProvider).toBe('mock');
    expect(loadConfig({}).paymentProvider).toBe('none');
    expect(loadConfig({ NODE_ENV: 'production' }).paymentProvider).toBe('none');
    expect(loadConfig({ NODE_ENV: 'production', QRATE_PAYMENT_PROVIDER: 'auto' }).paymentProvider).toBe('none');
    expect(loadConfig({ NODE_ENV: 'staging' }).paymentProvider).toBe('none');
  });

  it('명시하면 그대로 — 운영에서도 mock을 켤 수 있고(데모 배포), 개발에서도 끌 수 있다', () => {
    expect(loadConfig({ NODE_ENV: 'production', QRATE_PAYMENT_PROVIDER: 'mock' }).paymentProvider).toBe('mock');
    expect(loadConfig({ QRATE_PAYMENT_PROVIDER: 'none' }).paymentProvider).toBe('none');
  });

  it('모의 결제 비밀은 16자 이상이어야 시작한다. 없으면 undefined(서버가 프로세스마다 무작위로 만든다)', () => {
    expect(() => loadConfig({ QRATE_MOCK_PAYMENT_SECRET: 'short' })).toThrow(/QRATE_MOCK_PAYMENT_SECRET/);
    expect(loadConfig({ QRATE_MOCK_PAYMENT_SECRET: '0123456789abcdef' }).mockPaymentSecret).toBe('0123456789abcdef');
    expect(loadConfig({}).mockPaymentSecret).toBeUndefined();
  });
});
