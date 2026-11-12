import { KNOWLEDGE_ID_PATTERN, KNOWLEDGE_LIMITS, knowledgeChars } from '@qrate/contracts';
import { knowledgeInputSchema } from '@qrate/contracts/schemas';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isOriginString } from '../origin.js';
import {
  MemoryConversationRepository,
  MemoryCreditRepository,
  MemoryEventRepository,
  MemoryHandoffRepository,
  MemoryKnowledgeRepository,
  MemoryStore,
  MemoryTenantRepository,
  MemoryTopUpRepository,
} from './memory.js';
import { appendCredit } from './memory/credits.js';
import type { KnowledgeItem, Repositories, Tenant } from './types.js';

// 시드 파일: 데모 테넌트의 데이터 원천. 파일 하나가 테넌트 1개와 FAQ 목록이고, 서버 시작 때 메모리 저장소에 올린다.
// Postgres에서는 같은 파일을 prisma seed의 입력으로 쓴다.

export type SeedKnowledge = Omit<KnowledgeItem, 'tenantId'>;
/** 시드 파일의 테넌트에는 비밀이 없다. 콘솔 키 해시는 환경변수(QRATE_DEMO_CONSOLE_KEY)에서 따로 붙인다. */
export type SeedTenant = Omit<Tenant, 'consoleKeyHash'>;

export interface SeedFile {
  tenant: SeedTenant;
  knowledge: SeedKnowledge[];
  /** 데모 테넌트에 한 번 지급하는 크레딧(W4 결정: 시드 지급). 0이면 지급하지 않는다. */
  initialCredits: number;
}

/** 초기 지급의 멱등 키. 시드를 다시 돌려도 한 번만 들어간다. */
export const INITIAL_CREDIT_KEY = 'seed:initial';

// src/repo/ 와 dist/repo/ 모두 apps/server 아래 두 단계라 같은 상대 경로로 seed/ 를 찾는다.
// 컨테이너에는 pnpm deploy가 패키지 디렉터리의 seed/ 를 함께 담는다.
const seedPath = (file: string): string => fileURLToPath(new URL(`../../seed/${file}`, import.meta.url));

/** 첫 번째 데모 테넌트(마루인보이스). 평가·부하 측정·시험이 쓰고, 콘솔 키 환경변수(QRATE_DEMO_CONSOLE_KEY)도 이 테넌트의 것이다. */
export const DEFAULT_SEED_PATH = seedPath('demo-tenant.json');

/** 서버(메모리 저장소)와 prisma seed가 올리는 데모 테넌트 전부. 첫 번째가 DEFAULT_SEED_PATH다. */
export const DEMO_SEED_PATHS: readonly string[] = [DEFAULT_SEED_PATH, seedPath('reception-tenant.json')];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** zod 오류 경로를 시드 메시지의 모양(.blocks[0])으로. */
const issuePath = (path: readonly PropertyKey[]): string =>
  path.map((key) => (typeof key === 'number' ? `[${key}]` : `.${String(key)}`)).join('');

/** 모양이 틀린 시드는 서버 시작 때 바로 실패시킨다. 런타임에 조용히 깨지는 것보다 낫다. */
export function parseSeed(raw: unknown, source = 'seed'): SeedFile {
  const fail = (msg: string): never => {
    throw new Error(`${source}: ${msg}`);
  };
  if (!isRecord(raw)) return fail('최상위가 객체가 아님');

  const t = raw.tenant;
  if (!isRecord(t)) return fail('tenant 누락');
  const id = nonEmptyString(t.id) ?? fail('tenant.id');
  const apiKey = nonEmptyString(t.apiKey) ?? fail('tenant.apiKey');
  const name = nonEmptyString(t.name) ?? fail('tenant.name');
  if (!Array.isArray(t.allowedOrigins)) return fail('tenant.allowedOrigins 배열 아님');
  const allowedOrigins = t.allowedOrigins.map((o, i): string => {
    if (typeof o !== 'string') return fail(`tenant.allowedOrigins[${i}] 문자열 아님`);
    // CSP frame-ancestors 헤더에 글자 그대로 들어간다. 정규형(scheme://host[:port]) 외의 값은 헤더를 깨뜨리거나
    // 다른 지시어를 끼워 넣을 수 있어 시드 단계에서 거부한다. W3 콘솔의 입력 검증도 같은 isOriginString을 쓴다.
    if (!isOriginString(o)) return fail(`tenant.allowedOrigins[${i}] 정규형 오리진 아님: ${o}`);
    return o;
  });

  if (!Array.isArray(raw.knowledge) || raw.knowledge.length === 0) return fail('knowledge 비어 있음');
  const seen = new Set<string>();
  const knowledge = raw.knowledge.map((item, i): SeedKnowledge => {
    const at = `knowledge[${i}]`;
    if (!isRecord(item)) return fail(`${at} 객체 아님`);
    const kid = nonEmptyString(item.id) ?? fail(`${at}.id`);
    // 콘솔은 이 모양의 id만 고치고 지운다(PUT·DELETE /api/console/knowledge/:id). 회사 파일로 넣은 FAQ도 콘솔에서 다룰 수 있어야 한다.
    if (!KNOWLEDGE_ID_PATTERN.test(kid)) return fail(`${at}.id는 faq:와 소문자·숫자·하이픈이어야 한다: ${kid}`);
    if (seen.has(kid)) return fail(`${at}.id 중복: ${kid}`);
    seen.add(kid);
    const title = nonEmptyString(item.title) ?? fail(`${at}.title`);
    const category = nonEmptyString(item.category) ?? fail(`${at}.category`);
    if (!Array.isArray(item.blocks) || item.blocks.length === 0) return fail(`${at}.blocks 비어 있음`);
    const blocks = item.blocks.map((b, j) => nonEmptyString(b) ?? fail(`${at}.blocks[${j}] 빈 문자열`));
    // 콘솔이 저장할 때와 같은 상한. 값은 파일 그대로 두고 검사만 한다.
    const limits = knowledgeInputSchema.safeParse({ title, category, blocks });
    const issue = limits.success ? undefined : limits.error.issues[0];
    if (issue) return fail(`${at}${issuePath(issue.path)}: ${issue.message}`);
    return { id: kid, title, category, blocks };
  });
  if (knowledge.length > KNOWLEDGE_LIMITS.items) return fail(`knowledge ${knowledge.length}개, 상한은 ${KNOWLEDGE_LIMITS.items}개`);
  const chars = knowledge.reduce((sum, k) => sum + knowledgeChars(k), 0);
  if (chars > KNOWLEDGE_LIMITS.totalChars) return fail(`knowledge 제목·문단 합계 ${chars}자, 상한은 ${KNOWLEDGE_LIMITS.totalChars}자`);

  const initialCredits = raw.initialCredits === undefined ? 0 : raw.initialCredits;
  if (typeof initialCredits !== 'number' || !Number.isInteger(initialCredits) || initialCredits < 0) {
    return fail('initialCredits는 0 이상의 정수');
  }

  return { tenant: { id, apiKey, name, allowedOrigins }, knowledge, initialCredits };
}

export function loadSeedFile(path: string = DEFAULT_SEED_PATH): SeedFile {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parseSeed(raw, path);
}

/**
 * 여러 시드의 테넌트 id와 키가 겹치지 않는지 본다. id가 겹치면 뒤 시드가 앞 테넌트의 FAQ를 덮고,
 * 키가 겹치면 위젯의 data-tenant 하나가 어느 테넌트를 고를지 정해지지 않는다.
 */
export function assertDistinctTenants(seeds: readonly SeedFile[]): void {
  for (const field of ['id', 'apiKey'] as const) {
    const seen = new Set<string>();
    for (const { tenant } of seeds) {
      if (seen.has(tenant[field])) throw new Error(`시드 테넌트 ${field} 중복: ${tenant[field]}`);
      seen.add(tenant[field]);
    }
  }
}

export function loadSeedFiles(paths: readonly string[] = DEMO_SEED_PATHS): SeedFile[] {
  const seeds = paths.map((path) => loadSeedFile(path));
  assertDistinctTenants(seeds);
  return seeds;
}

/** 시드들을 메모리 저장소 하나에 올린다. 콘솔 키 해시는 시드 밖(환경변수)에서 테넌트 id별로 받고, 없는 테넌트는 콘솔 로그인이 안 된다. */
export function createRepositoriesFromSeeds(
  seeds: readonly SeedFile[],
  { consoleKeyHashes = {} }: { consoleKeyHashes?: Readonly<Record<string, string>> } = {},
): Repositories {
  assertDistinctTenants(seeds);
  const store = new MemoryStore();
  for (const seed of seeds) {
    if (seed.initialCredits > 0) {
      appendCredit(store, seed.tenant.id, { delta: seed.initialCredits, reason: 'seed', idempotencyKey: INITIAL_CREDIT_KEY });
    }
  }
  const knowledge: KnowledgeItem[] = seeds.flatMap((seed) => seed.knowledge.map((k) => ({ ...k, tenantId: seed.tenant.id })));
  return {
    tenants: new MemoryTenantRepository(seeds.map((seed) => ({ ...seed.tenant, consoleKeyHash: consoleKeyHashes[seed.tenant.id] ?? null }))),
    knowledge: new MemoryKnowledgeRepository(knowledge),
    conversations: new MemoryConversationRepository(store),
    handoffs: new MemoryHandoffRepository(store),
    credits: new MemoryCreditRepository(store),
    topUps: new MemoryTopUpRepository(store),
    events: new MemoryEventRepository(),
  };
}

export function createRepositoriesFromSeed(
  seed: SeedFile,
  { consoleKeyHash = null }: { consoleKeyHash?: string | null } = {},
): Repositories {
  return createRepositoriesFromSeeds([seed], consoleKeyHash ? { consoleKeyHashes: { [seed.tenant.id]: consoleKeyHash } } : {});
}
