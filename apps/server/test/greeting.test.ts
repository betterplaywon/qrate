import { GREETING_PATH, VARIANT_ID_PATTERN, type GreetingResponse } from '@qrate/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppOptions } from '../src/app.js';
import { GREETING_EXPERIMENT, assignGreeting, defineGreetingExperiment, type GreetingExperimentInput } from '../src/greeting/experiment.js';
import type { AppEvent } from '../src/repo/types.js';
import { startApp } from './helpers/app.js';

const OWN_ORIGIN = 'http://widget.test';

const A = { key: 'a', label: 'A', weight: 1, text: '가' };
const B = { key: 'b', label: 'B', weight: 1, text: '나' };
const EVEN = defineGreetingExperiment({ id: 'exp', variants: [A, B] });
const PAUSED_B = defineGreetingExperiment({ id: 'exp', variants: [A, { ...B, weight: 0 }] });

describe('defineGreetingExperiment', () => {
  it('변형 id는 실험 id와 키를 이은 것이고, 지금 실험의 id는 런처가 받아 주는 형식이다', () => {
    expect(EVEN.variants.map((v) => v.id)).toEqual(['exp.a', 'exp.b']);
    expect(GREETING_EXPERIMENT?.variants.length).toBeGreaterThan(1);
    for (const v of GREETING_EXPERIMENT?.variants ?? []) expect(v.id).toMatch(VARIANT_ID_PATTERN);
  });

  it('틀린 정의는 던진다 — 서버가 시작하지 않는다', () => {
    const wrong: GreetingExperimentInput[] = [
      { id: 'exp', variants: [] },
      { id: 'e.x', variants: [A] },
      { id: 'Exp', variants: [A] },
      { id: 'exp', variants: [{ ...A, key: '' }] },
      { id: 'exp', variants: [{ ...A, key: 'a.b' }] },
      { id: 'exp', variants: [A, { ...B, key: 'a' }] },
      { id: 'exp', variants: [{ ...A, weight: -1 }, B] },
      { id: 'exp', variants: [{ ...A, weight: 0.5 }, B] },
      { id: 'exp', variants: [{ ...A, weight: 0 }, { ...B, weight: 0 }] },
      { id: 'exp', variants: [{ ...A, text: ' ' }] },
      { id: 'exp', variants: [{ ...A, label: '' }] },
    ];
    for (const input of wrong) expect(() => defineGreetingExperiment(input), JSON.stringify(input)).toThrow(/^인사말 실험/);
  });
});

describe('assignGreeting', () => {
  it('보존값이 없으면 가중치 비율로 고른다 — 1:1이면 random 0·0.4999는 a, 0.5·0.9999는 b', () => {
    const pick = (r: number) => assignGreeting(EVEN, null, () => r).id;
    expect([0, 0.4999, 0.5, 0.9999].map(pick)).toEqual(['exp.a', 'exp.a', 'exp.b', 'exp.b']);
  });

  it('가중치 0인 변형은 새로 배정되지 않지만, 이미 가진 방문자에게는 random과 무관하게 그대로다', () => {
    for (const r of [0, 0.5, 0.9999]) {
      expect(assignGreeting(PAUSED_B, null, () => r).id).toBe('exp.a');
      expect(assignGreeting(PAUSED_B, 'exp.b', () => r).id).toBe('exp.b');
    }
  });

  it('다른 실험의 변형·모르는 값은 무시하고 새로 고른다', () => {
    for (const requested of ['old.b', 'b', 'exp.c', '']) expect(assignGreeting(EVEN, requested, () => 0).id).toBe('exp.a');
  });
});

describe('GET /api/greeting', () => {
  const recorded: AppEvent[] = [];
  const closers: (() => Promise<void>)[] = [];

  async function serve(options: Partial<AppOptions>): Promise<string> {
    const { url, close } = await startApp({ publicOrigin: OWN_ORIGIN, recordEvent: (event) => recorded.push(event), ...options });
    closers.push(close);
    return url;
  }

  let url: string;
  const get = (query: string, headers: Record<string, string> = {}, base = url) => fetch(`${base}${GREETING_PATH}?${query}`, { headers });
  const greetingOf = async (res: Response) => ((await res.json()) as GreetingResponse).greeting;

  beforeAll(async () => {
    url = await serve({ greeting: PAUSED_B });
  });

  afterAll(() => Promise.all(closers.map((close) => close())));

  it('보존값이 없으면 새로 배정한다(가중치 0인 b는 받지 않는다). 캐시 금지, 사건은 남기지 않는다', async () => {
    const res = await get('tenant=demo', { origin: OWN_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await greetingOf(res)).toEqual({ variant: 'exp.a', text: '가' });
    expect(recorded).toEqual([]);
  });

  it('보존값이 지금 실험의 변형이면 그대로 돌려준다 — 새 배정을 멈춘 b도', async () => {
    expect(await greetingOf(await get('tenant=demo&variant=exp.b'))).toEqual({ variant: 'exp.b', text: '나' });
  });

  it('옛 실험·모르는 값·빈 값·여러 개 실린 값은 무시하고 새로 배정한다', async () => {
    for (const query of ['tenant=demo&variant=old.b', 'tenant=demo&variant=made-up', 'tenant=demo&variant=', 'tenant=demo&variant=exp.b&variant=exp.b']) {
      expect(await greetingOf(await get(query)), query).toEqual({ variant: 'exp.a', text: '가' });
    }
  });

  it('실험이 꺼져 있으면 { greeting: null }, 정하지 않으면 지금 실험(GREETING_EXPERIMENT)에서 배정한다', async () => {
    const off = await serve({ greeting: null });
    expect(await greetingOf(await get('tenant=demo&variant=exp.a', {}, off))).toBeNull();

    const current = await serve({});
    const assigned = await greetingOf(await get('tenant=demo', {}, current));
    const ids = GREETING_EXPERIMENT?.variants.map((v) => v.id) ?? [];
    expect(ids).toContain(assigned?.variant);
  });

  it('tenant 없음 400, 모르는 테넌트 404, 다른 오리진의 문서 403', async () => {
    const missing = await get('variant=exp.a');
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'tenant is required' });

    const unknown = await get('tenant=nope');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown_tenant' });

    const foreign = await get('tenant=demo', { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: 'origin_not_allowed' });
    expect(recorded).toEqual([]);
  });
});
