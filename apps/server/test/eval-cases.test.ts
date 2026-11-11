import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCaseFile, selectCases } from '../eval/cases.js';
import { DEFAULT_SEED_PATH, loadSeedFile } from '../src/repo/seed.js';

// 시험지 읽기: 실제 시험지가 읽히고, 모양이 틀린 시험지는 실행 전에 막힌다.
// 실제 시험지는 사람이 계속 고치므로 id·그룹 이름이 아니라 수만 확인한다.

const seed = loadSeedFile(DEFAULT_SEED_PATH);
const knowledgeIds = new Set(seed.knowledge.map((k) => k.id));
const realFile = JSON.parse(readFileSync(fileURLToPath(new URL('../eval/cases.json', import.meta.url)), 'utf8')) as unknown;

function validFile(): Record<string, unknown> & { cases: Record<string, unknown>[] } {
  return {
    version: 1,
    status: 'approved',
    tenantKey: 'demo',
    cases: [
      {
        id: 'a01',
        group: '그룹',
        source: 'draft',
        message: '질문',
        history: [
          { role: 'user', text: '앞 질문' },
          { role: 'assistant', text: '앞 답' },
        ],
        expect: { handoff: false, cites: [seed.knowledge[0]?.id ?? ''], judge: '기대' },
      },
    ],
  };
}

describe('시험지 — parseCaseFile', () => {
  it('실제 시험지가 읽히고 수가 맞다(30개: 넘김 9·안 넘김 18·채점 안 함 3)', () => {
    const file = parseCaseFile(realFile, knowledgeIds);
    expect(file.cases).toHaveLength(30);
    const count = (h: boolean | null) => file.cases.filter((c) => c.expect.handoff === h).length;
    expect([count(true), count(false), count(null)]).toEqual([9, 18, 3]);
  });

  it('맞는 모양은 기본값을 채워 읽는다', () => {
    const file = parseCaseFile(validFile(), knowledgeIds);
    expect(file.cases[0]?.expect.mustInclude).toEqual([]);
    expect(file.cases[0]?.tags).toEqual([]);
  });

  it.each([
    ['모르는 필드', (f: ReturnType<typeof validFile>) => ({ ...f, extra: 1 })],
    ['status가 draft·approved가 아님', (f: ReturnType<typeof validFile>) => ({ ...f, status: 'final' })],
    ['judge 설명 없음', (f: ReturnType<typeof validFile>) => ({ ...f, cases: [{ ...f.cases[0], expect: { handoff: true } }] })],
    ['history가 쌍이 아님', (f: ReturnType<typeof validFile>) => ({ ...f, cases: [{ ...f.cases[0], history: [{ role: 'user', text: '혼자' }] }] })],
    [
      'history가 assistant로 시작',
      (f: ReturnType<typeof validFile>) => ({
        ...f,
        cases: [{ ...f.cases[0], history: [{ role: 'assistant', text: '답' }, { role: 'user', text: '질문' }] }],
      }),
    ],
    ['id 중복', (f: ReturnType<typeof validFile>) => ({ ...f, cases: [f.cases[0], f.cases[0]] })],
    ['운영 길이 상한을 넘는 질문', (f: ReturnType<typeof validFile>) => ({ ...f, cases: [{ ...f.cases[0], message: '가'.repeat(2001) }] })],
    ['시드에 없는 FAQ 인용', (f: ReturnType<typeof validFile>) => ({ ...f, cases: [{ ...f.cases[0], expect: { handoff: false, cites: ['faq:없음'], judge: '기대' } }] })],
  ])('%s → 거부', (_name, mutate) => {
    expect(() => parseCaseFile(mutate(validFile()), knowledgeIds)).toThrow();
  });
});

describe('사례 고르기 — selectCases', () => {
  const cases = parseCaseFile(realFile, knowledgeIds).cases;

  it('id로 고르고 limit으로 앞에서 자른다', () => {
    const [first, second, third] = cases;
    if (!first || !second || !third) throw new Error('시험지가 비었다');
    expect(selectCases(cases, { ids: [third.id, first.id] }).map((c) => c.id)).toEqual([first.id, third.id]);
    expect(selectCases(cases, { limit: 2 }).map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it('없는 id는 오타로 보고 실패한다', () => {
    expect(() => selectCases(cases, { ids: ['없는-id'] })).toThrow(/없는-id/);
  });
});
