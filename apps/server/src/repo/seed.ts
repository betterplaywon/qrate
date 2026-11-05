import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isOriginString } from '../origin.js';
import {
  MemoryConversationRepository,
  MemoryCreditRepository,
  MemoryHandoffRepository,
  MemoryKnowledgeRepository,
  MemoryStore,
  MemoryTenantRepository,
} from './memory.js';
import { appendCredit } from './memory/credits.js';
import type { KnowledgeItem, Repositories, Tenant } from './types.js';

// 시드 파일: W2의 데이터 원천. 테넌트 1개와 FAQ 목록을 JSON으로 두고 서버 시작 때 메모리 저장소에 올린다.
// W3에서 Postgres로 옮길 때는 같은 파일을 prisma seed의 입력으로 쓴다.

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
export const DEFAULT_SEED_PATH = fileURLToPath(new URL('../../seed/demo-tenant.json', import.meta.url));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

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
    if (seen.has(kid)) return fail(`${at}.id 중복: ${kid}`);
    seen.add(kid);
    const title = nonEmptyString(item.title) ?? fail(`${at}.title`);
    const category = nonEmptyString(item.category) ?? fail(`${at}.category`);
    if (!Array.isArray(item.blocks) || item.blocks.length === 0) return fail(`${at}.blocks 비어 있음`);
    const blocks = item.blocks.map((b, j) => nonEmptyString(b) ?? fail(`${at}.blocks[${j}] 빈 문자열`));
    return { id: kid, title, category, blocks };
  });

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

export function createRepositoriesFromSeed(
  seed: SeedFile,
  { consoleKeyHash = null }: { consoleKeyHash?: string | null } = {},
): Repositories {
  const knowledge: KnowledgeItem[] = seed.knowledge.map((k) => ({ ...k, tenantId: seed.tenant.id }));
  const store = new MemoryStore();
  if (seed.initialCredits > 0) {
    appendCredit(store, seed.tenant.id, { delta: seed.initialCredits, reason: 'seed', idempotencyKey: INITIAL_CREDIT_KEY });
  }
  return {
    tenants: new MemoryTenantRepository([{ ...seed.tenant, consoleKeyHash }]),
    knowledge: new MemoryKnowledgeRepository(knowledge),
    conversations: new MemoryConversationRepository(store),
    handoffs: new MemoryHandoffRepository(store),
    credits: new MemoryCreditRepository(store),
  };
}
