import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NewTurn, Repositories } from '../src/repo/types.js';

// 저장소 계약 테스트 — 메모리(repo.test.ts)와 Postgres(repo-postgres.test.ts) 두 구현이 똑같이 통과해야 한다.
// 구현별로만 뜻이 있는 것(FK, 트랜잭션 되돌리기, 프로세스가 바뀌어도 남는지)은 각 파일이 더한다.

export interface RepositoryContractContext {
  repos: Repositories;
  /** 시드 테넌트(apiKey 'demo')의 id. 지식이 있는 쪽. */
  tenantId: string;
  /** 같은 저장소에 있는 다른 테넌트의 id — 테넌트 경계 케이스용. 지식은 없어야 한다. */
  otherTenantId: string;
}

export const turn = (question: string, answer: string | null, handoff: NewTurn['handoff'] = null): NewTurn => ({
  question: { role: 'user', content: question },
  answer: answer === null ? null : { role: 'assistant', content: answer },
  handoff,
});

export function describeRepositoryContract(name: string, setup: () => Promise<RepositoryContractContext>): void {
  describe(`저장소 계약 — ${name}`, () => {
    let ctx: RepositoryContractContext;
    beforeAll(async () => {
      ctx = await setup();
    });

    it('테넌트: 키로 찾고(허용 오리진 포함), 모르는 키는 null', async () => {
      const tenant = await ctx.repos.tenants.findByKey('demo');
      expect(tenant?.id).toBe(ctx.tenantId);
      expect(tenant?.name).toBeTruthy();
      expect(tenant?.allowedOrigins).toContain('http://localhost:5173');
      expect(await ctx.repos.tenants.findByKey('nope')).toBeNull();
    });

    it('지식: 테넌트별로, id 오름차순 고정 (프롬프트 캐시 접두사가 요청마다 같아야 한다)', async () => {
      const items = await ctx.repos.knowledge.listByTenant(ctx.tenantId);
      expect(items.length).toBeGreaterThanOrEqual(20);
      const ids = items.map((k) => k.id);
      expect(ids).toEqual([...ids].sort());
      expect(items.every((k) => k.tenantId === ctx.tenantId && k.blocks.length > 0)).toBe(true);
      expect(await ctx.repos.knowledge.listByTenant(ctx.otherTenantId)).toEqual([]);
    });

    it('대화: 첫 턴 저장으로 생긴다 → 질문 시각은 넘긴 값, 답변은 저장 시각 → 같은 테넌트로만 찾는다', async () => {
      const id = randomUUID();
      expect(await ctx.repos.conversations.find(id, ctx.tenantId)).toBeNull(); // 아직 없다 — 대화는 첫 턴과 함께 생긴다

      const asked = new Date('2026-11-03T12:00:00Z');
      const before = Date.now();
      await ctx.repos.conversations.appendTurn(id, ctx.tenantId, {
        question: { role: 'user', content: '환불되나요?', createdAt: asked },
        answer: { role: 'assistant', content: '7일 이내면 됩니다.' },
        handoff: null,
      });

      const found = await ctx.repos.conversations.find(id, ctx.tenantId);
      expect(found?.id).toBe(id);
      expect(found?.tenantId).toBe(ctx.tenantId);
      expect(found?.createdAt).toEqual(asked);
      expect(found?.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
        'user:환불되나요?',
        'assistant:7일 이내면 됩니다.',
      ]);
      expect(found?.messages[0]?.createdAt).toEqual(asked);
      // 저장 시각(초 단위 비교 — DB는 밀리초 셋째 자리까지 저장하고, 시계가 다를 수 있다)
      expect(found?.messages[1]?.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(found?.handoffs).toEqual([]);
      expect(await ctx.repos.conversations.find(id, ctx.otherTenantId)).toBeNull();
      expect(await ctx.repos.conversations.find('missing', ctx.tenantId)).toBeNull();
    });

    it('턴: 답이 없으면(거절) 질문만, 핸드오프 신호는 handoffs에 시각과 함께', async () => {
      const id = randomUUID();
      await ctx.repos.conversations.appendTurn(id, ctx.tenantId, turn('거절될 질문', null));
      await ctx.repos.conversations.appendTurn(
        id,
        ctx.tenantId,
        turn('카카오톡 알림 되나요?', '자료에 없어요.', { reason: 'not_in_knowledge', summary: '카카오톡 알림 문의' }),
      );

      const found = await ctx.repos.conversations.find(id, ctx.tenantId);
      expect(found?.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
      expect(found?.handoffs).toHaveLength(1);
      expect(found?.handoffs[0]).toMatchObject({ reason: 'not_in_knowledge', summary: '카카오톡 알림 문의' });
      expect(found?.handoffs[0]?.createdAt).toBeInstanceOf(Date);
    });

    it('find의 lastMessages는 최근 n개만 싣는다 — 프롬프트 문맥용. 없으면 전부, 0이면 하나도', async () => {
      const id = randomUUID();
      for (let i = 0; i < 3; i += 1) await ctx.repos.conversations.appendTurn(id, ctx.tenantId, turn(`q${i}`, `a${i}`));
      const last = await ctx.repos.conversations.find(id, ctx.tenantId, { lastMessages: 2 });
      expect(last?.messages.map((m) => m.content)).toEqual(['q2', 'a2']);
      expect((await ctx.repos.conversations.find(id, ctx.tenantId, { lastMessages: 0 }))?.messages).toEqual([]);
      expect((await ctx.repos.conversations.find(id, ctx.tenantId))?.messages).toHaveLength(6);
    });

    it('같은 시각에 찍힌 질문·답변도 저장 순서를 지킨다 — 시각으로는 순서를 못 정하는 경우', async () => {
      const id = randomUUID();
      const at = new Date('2026-11-04T09:00:00Z');
      for (let i = 0; i < 3; i += 1) {
        await ctx.repos.conversations.appendTurn(id, ctx.tenantId, {
          question: { role: 'user', content: `q${i}`, createdAt: at },
          answer: { role: 'assistant', content: `a${i}`, createdAt: at },
          handoff: null,
        });
      }
      const found = await ctx.repos.conversations.find(id, ctx.tenantId);
      expect(found?.messages.map((m) => m.content)).toEqual(['q0', 'a0', 'q1', 'a1', 'q2', 'a2']);
      expect((await ctx.repos.conversations.find(id, ctx.tenantId, { lastMessages: 3 }))?.messages.map((m) => m.content)).toEqual([
        'a1',
        'q2',
        'a2',
      ]);
    });

    it('다른 테넌트의 대화 id로는 쓸 수 없다 — 테넌트 경계는 쓰기에서도', async () => {
      const id = randomUUID();
      await ctx.repos.conversations.appendTurn(id, ctx.tenantId, turn('x', null));
      await expect(ctx.repos.conversations.appendTurn(id, ctx.otherTenantId, turn('y', 'z'))).rejects.toThrow(
        /another tenant/,
      );
      expect(await ctx.repos.conversations.find(id, ctx.otherTenantId)).toBeNull();
      expect((await ctx.repos.conversations.find(id, ctx.tenantId))?.messages).toHaveLength(1);
    });

    it('목록: 테넌트별 최근 시작순, 커서로 이어 받기, 미리보기·개수, 깨진 커서는 거부', async () => {
      // 다른 테넌트에 대화를 만든다 — 시드 테넌트에는 앞 테스트들의 대화가 섞여 있어 정확한 페이지를 셀 수 없다.
      const t = ctx.otherTenantId;
      const base = Date.parse('2026-11-04T10:00:00Z');
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const id = randomUUID();
        ids.push(id);
        await ctx.repos.conversations.appendTurn(id, t, {
          question: { role: 'user', content: `질문 ${i}\n` + 'x'.repeat(100), createdAt: new Date(base + i * 1000) },
          answer: { role: 'assistant', content: `답 ${i}` },
          handoff: i === 4 ? { reason: 'other', summary: null } : null,
        });
      }
      // 같은 시각에 시작한 두 대화 — id 내림차순(코드 단위)으로 순서가 고정된다
      const tied: string[] = [randomUUID(), randomUUID()];
      for (const id of tied) {
        await ctx.repos.conversations.appendTurn(id, t, {
          question: { role: 'user', content: '동시 시작', createdAt: new Date(base + 10_000) },
          answer: null,
          handoff: null,
        });
      }
      const tiedNewestFirst = [...tied].sort().reverse();

      const list = (opts: { limit: number; cursor?: string | null }) => ctx.repos.conversations.listByTenant(t, opts);
      const p1 = await list({ limit: 3 });
      expect(p1.items.map((c) => c.id)).toEqual([...tiedNewestFirst, ids[4]]);
      expect(p1.nextCursor).toEqual(expect.any(String));
      expect(p1.items[0]).toMatchObject({ tenantId: t, messageCount: 1, handoffCount: 0, preview: '동시 시작' });
      expect(p1.items[2]).toMatchObject({ messageCount: 2, handoffCount: 1 });
      expect(p1.items[2]?.preview).toBe(('질문 4 ' + 'x'.repeat(100)).slice(0, 80)); // 줄바꿈은 공백, 80자에서 자름

      const p2 = await list({ limit: 3, cursor: p1.nextCursor });
      expect(p2.items.map((c) => c.id)).toEqual([ids[3], ids[2], ids[1]]);
      const p3 = await list({ limit: 3, cursor: p2.nextCursor });
      expect(p3.items.map((c) => c.id)).toEqual([ids[0]]);
      expect(p3.nextCursor).toBeNull();

      // 딱 맞아떨어지는 마지막 페이지에도 다음 커서는 없다
      const exact = await list({ limit: 7 });
      expect(exact.items).toHaveLength(7);
      expect(exact.nextCursor).toBeNull();

      // 테넌트 경계: 시드 테넌트의 목록에는 이 대화들이 없다
      const others = await ctx.repos.conversations.listByTenant(ctx.tenantId, { limit: 100 });
      expect(others.items.some((c) => ids.includes(c.id) || tied.includes(c.id))).toBe(false);

      await expect(list({ limit: 3, cursor: 'not-a-cursor' })).rejects.toThrow(/cursor/);
      await expect(list({ limit: 0 })).rejects.toThrow(/limit/);
    });

    it('돌려준 객체를 바꿔도 저장소는 변하지 않는다', async () => {
      const first = await ctx.repos.knowledge.listByTenant(ctx.tenantId);
      first[0]?.blocks.push('oops');
      const second = await ctx.repos.knowledge.listByTenant(ctx.tenantId);
      expect(second[0]?.blocks).not.toContain('oops');

      const id = randomUUID();
      await ctx.repos.conversations.appendTurn(id, ctx.tenantId, turn('q', 'a'));
      const found = await ctx.repos.conversations.find(id, ctx.tenantId);
      found?.messages.push({ role: 'user', content: 'ghost', createdAt: new Date() });
      found?.handoffs.push({ reason: 'other', summary: null, createdAt: new Date() });
      const again = await ctx.repos.conversations.find(id, ctx.tenantId);
      expect(again?.messages).toHaveLength(2);
      expect(again?.handoffs).toEqual([]);
    });
  });
}
