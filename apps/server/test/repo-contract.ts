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
