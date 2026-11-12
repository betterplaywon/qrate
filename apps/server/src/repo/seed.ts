import { KNOWLEDGE_ID_PATTERN, KNOWLEDGE_LIMITS, knowledgeChars } from '@qrate/contracts';
import { knowledgeInputSchema } from '@qrate/contracts/schemas';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
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
/** 시드 파일의 테넌트에는 비밀이 없다. 콘솔 키 해시는 데모 회사마다의 환경변수(config.ts DEMO_CONSOLE_KEY_ENV)에서 따로 붙인다. */
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

/** 첫 번째 데모 테넌트(마루인보이스). 평가·부하 측정·시험이 쓴다. */
export const DEFAULT_SEED_PATH = seedPath('demo-tenant.json');

/** 서버(메모리 저장소)와 prisma seed가 올리는 데모 테넌트 전부. 첫 번째가 DEFAULT_SEED_PATH다. */
export const DEMO_SEED_PATHS: readonly string[] = [DEFAULT_SEED_PATH, seedPath('reception-tenant.json')];

const nonBlank = z.string().refine((v) => v.trim().length > 0, '비어 있음');

const seedTenantSchema = z.object({
  id: nonBlank,
  apiKey: nonBlank,
  name: nonBlank,
  // CSP frame-ancestors 헤더에 글자 그대로 들어간다. 정규형(scheme://host[:port]) 외의 값은 헤더를 깨뜨리거나
  // 다른 지시어를 끼워 넣을 수 있어 시드 단계에서 거부한다. W3 콘솔의 입력 검증도 같은 isOriginString을 쓴다.
  allowedOrigins: z.array(z.string().refine(isOriginString, { error: (issue) => `정규형 오리진 아님: ${String(issue.input)}` })),
});

// 콘솔이 FAQ를 저장할 때(PUT)와 같은 스키마다. 앞뒤 공백도 콘솔처럼 떼고 올린다.
const seedKnowledgeSchema = knowledgeInputSchema.extend({
  // 콘솔은 이 모양의 id만 고치고 지운다(PUT·DELETE /api/console/knowledge/:id). 회사 파일로 넣은 FAQ도 콘솔에서 다룰 수 있어야 한다.
  id: z.string().regex(KNOWLEDGE_ID_PATTERN, { error: (issue) => `faq:와 소문자·숫자·하이픈이어야 한다: ${String(issue.input)}` }),
});

const { items: maxItems, totalChars: maxChars } = KNOWLEDGE_LIMITS;
const CREDITS_MESSAGE = '0 이상의 정수여야 한다';

const seedFileSchema = z.object({
  tenant: seedTenantSchema,
  knowledge: z
    .array(seedKnowledgeSchema)
    .min(1, '비어 있음')
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      items.forEach(({ id }, i) => {
        if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `앞 항목과 중복: ${id}` });
        seen.add(id);
      });
      if (items.length > maxItems) ctx.addIssue({ code: 'custom', message: `${items.length}개, 상한은 ${maxItems}개` });
      const chars = items.reduce((sum, item) => sum + knowledgeChars(item), 0);
      if (chars > maxChars) ctx.addIssue({ code: 'custom', message: `제목·문단 합계 ${chars}자, 상한은 ${maxChars}자` });
    }),
  initialCredits: z.int({ error: CREDITS_MESSAGE }).min(0, CREDITS_MESSAGE).default(0),
});

/** 모양이 틀린 시드는 서버 시작 때 바로 실패시킨다. 런타임에 조용히 깨지는 것보다 낫다. */
export function parseSeed(raw: unknown, source = 'seed'): SeedFile {
  const parsed = seedFileSchema.safeParse(raw, { error: z.locales.ko().localeError });
  if (parsed.success) return parsed.data;
  const { path, message } = parsed.error.issues[0] ?? { path: [], message: parsed.error.message };
  const at = path.length > 0 ? `${z.core.toDotPath(path)}: ` : '';
  throw new Error(`${source}: ${at}${message}`);
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
