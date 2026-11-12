import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('QRATE_HOST', () => {
  it('개발(NODE_ENV=development)의 기본은 127.0.0.1, 그 밖의 기본은 undefined(모든 인터페이스)', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).host).toBe('127.0.0.1');
    expect(loadConfig({}).host).toBeUndefined();
    expect(loadConfig({ NODE_ENV: 'test' }).host).toBeUndefined();
    expect(loadConfig({ NODE_ENV: 'production' }).host).toBeUndefined();
    expect(loadConfig({ QRATE_HOST: '' }).host).toBeUndefined();
  });

  it('값이 있으면 개발에서도 그 주소에 연다 — .env로 바꿀 수 있다', () => {
    expect(loadConfig({ NODE_ENV: 'development', QRATE_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(loadConfig({ QRATE_HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
  });
});

describe('QRATE_PAYMENT_PROVIDER', () => {
  it('auto(기본)는 NODE_ENV가 development·test일 때만 mock이고, 비어 있거나 그 밖이면 none', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).payments.provider).toBe('mock');
    expect(loadConfig({ NODE_ENV: 'test' }).payments.provider).toBe('mock');
    expect(loadConfig({}).payments.provider).toBe('none');
    expect(loadConfig({ NODE_ENV: 'production' }).payments.provider).toBe('none');
    expect(loadConfig({ NODE_ENV: 'production', QRATE_PAYMENT_PROVIDER: 'auto' }).payments.provider).toBe('none');
    expect(loadConfig({ NODE_ENV: 'staging' }).payments.provider).toBe('none');
  });

  it('명시하면 그대로 — 운영에서도 mock을 켤 수 있고(데모 배포), 개발에서도 끌 수 있다', () => {
    expect(loadConfig({ NODE_ENV: 'production', QRATE_PAYMENT_PROVIDER: 'mock' }).payments.provider).toBe('mock');
    expect(loadConfig({ QRATE_PAYMENT_PROVIDER: 'none' }).payments.provider).toBe('none');
  });

  it('모의 결제 비밀은 16자 이상이어야 시작한다. 없으면 undefined(서버가 프로세스마다 무작위로 만든다)', () => {
    expect(() => loadConfig({ QRATE_MOCK_PAYMENT_SECRET: 'short' })).toThrow(/QRATE_MOCK_PAYMENT_SECRET/);
    expect(loadConfig({ QRATE_PAYMENT_PROVIDER: 'mock', QRATE_MOCK_PAYMENT_SECRET: '0123456789abcdef' }).payments).toEqual({
      provider: 'mock',
      webhookSecret: '0123456789abcdef',
    });
    expect(loadConfig({ QRATE_PAYMENT_PROVIDER: 'mock' }).payments).toEqual({ provider: 'mock', webhookSecret: undefined });
  });

  it('toss는 적을 때만 켜지고 두 키를 시작 때 검사한다 — auto는 키가 있어도 토스를 켜지 않는다', () => {
    const keys = { QRATE_TOSS_CLIENT_KEY: 'test_gck_fake0001', QRATE_TOSS_SECRET_KEY: 'test_gsk_fake0001' };
    expect(loadConfig({ QRATE_PAYMENT_PROVIDER: 'toss', ...keys }).payments).toEqual({
      provider: 'toss',
      clientKey: 'test_gck_fake0001',
      secretKey: 'test_gsk_fake0001',
    });
    expect(() => loadConfig({ QRATE_PAYMENT_PROVIDER: 'toss' })).toThrow(/QRATE_TOSS_CLIENT_KEY·QRATE_TOSS_SECRET_KEY/);
    expect(() => loadConfig({ QRATE_PAYMENT_PROVIDER: 'toss', ...keys, QRATE_TOSS_SECRET_KEY: 'live_gsk_real0001' })).toThrow(/QRATE_TOSS_SECRET_KEY/);
    expect(loadConfig({ NODE_ENV: 'development', ...keys }).payments.provider).toBe('mock');
  });
});

describe('데모 회사 콘솔 키', () => {
  it('데모 회사마다 환경변수 하나(demo는 QRATE_DEMO_CONSOLE_KEY, reception은 QRATE_RECEPTION_CONSOLE_KEY)이고, 값이 있는 회사만 담는다', () => {
    expect(loadConfig({}).demoConsoleKeys).toEqual({});
    expect(loadConfig({ QRATE_DEMO_CONSOLE_KEY: 'k-demo' }).demoConsoleKeys).toEqual({ demo: 'k-demo' });
    expect(loadConfig({ QRATE_RECEPTION_CONSOLE_KEY: 'k-reception', QRATE_DEMO_CONSOLE_KEY: '' }).demoConsoleKeys).toEqual({ reception: 'k-reception' });
    expect(loadConfig({ QRATE_DEMO_CONSOLE_KEY: 'k-demo', QRATE_RECEPTION_CONSOLE_KEY: 'k-reception' }).demoConsoleKeys).toEqual({
      demo: 'k-demo',
      reception: 'k-reception',
    });
  });
});

