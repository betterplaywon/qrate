import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MemoryConversationRepository, MemoryKnowledgeRepository, MemoryTenantRepository } from './memory.js';
import type { KnowledgeItem, Repositories, Tenant } from './types.js';

// 시드 파일: W2의 데이터 원천. 테넌트 1개와 FAQ 목록을 JSON으로 두고 서버 시작 때 메모리 저장소에 올린다.
// W3에서 Postgres로 옮길 때는 같은 파일을 prisma seed의 입력으로 쓴다.

export type SeedKnowledge = Omit<KnowledgeItem, 'tenantId'>;

export interface SeedFile {
  tenant: Tenant;
  knowledge: SeedKnowledge[];
}

// src/repo/ 와 dist/repo/ 모두 apps/server 아래 두 단계라 같은 상대 경로로 seed/ 를 찾는다.
// 컨테이너에는 pnpm deploy가 패키지 디렉터리의 seed/ 를 함께 담는다.
export const DEFAULT_SEED_PATH = fileURLToPath(new URL('../../seed/demo-tenant.json', import.meta.url));

export function loadSeedFile(path: string = DEFAULT_SEED_PATH): SeedFile {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parseSeed(raw, path);
}

export function createRepositoriesFromSeed(seed: SeedFile): Repositories {
  const knowledge: KnowledgeItem[] = seed.knowledge.map((k) => ({ ...k, tenantId: seed.tenant.id }));
  return {
    tenants: new MemoryTenantRepository([seed.tenant]),
    knowledge: new MemoryKnowledgeRepository(knowledge),
    conversations: new MemoryConversationRepository(),
  };
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
  const allowedOrigins = Array.isArray(t.allowedOrigins) ? t.allowedOrigins : fail('tenant.allowedOrigins 배열 아님');
  if (!allowedOrigins.every((o) => typeof o === 'string')) return fail('tenant.allowedOrigins 항목이 문자열 아님');

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

  return { tenant: { id, apiKey, name, allowedOrigins: allowedOrigins as string[] }, knowledge };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}
