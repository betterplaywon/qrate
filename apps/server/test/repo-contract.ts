import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { decideSettlement } from '../src/billing/settlement.js';
import type { NewTopUp, NewTurn, PaymentResult, Repositories, SettleResult } from '../src/repo/types.js';

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

export const order = (requestKey = `req-${randomUUID()}`): NewTopUp => ({
  requestKey,
  packageId: 'credits_100',
  credits: 100,
  amount: 10_000,
  provider: 'mock',
});

export async function deliver(repos: Repositories, orderId: string, eventId: string, result: PaymentResult): Promise<SettleResult> {
  const decision = decideSettlement(await repos.topUps.findById(orderId), { provider: 'mock', eventId, orderId, result, amount: 10_000 });
  if (decision.kind !== 'settle') throw new Error(`settlement ignored: ${decision.reason}`);
  return repos.topUps.settle(decision.settlement);
}

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
      expect((await ctx.repos.tenants.findById(ctx.tenantId))?.apiKey).toBe('demo');
      expect(await ctx.repos.tenants.findById('nope')).toBeNull();
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
      expect(found?.handoffs[0]).toMatchObject({
        source: 'model',
        reason: 'not_in_knowledge',
        summary: '카카오톡 알림 문의',
        contact: null,
        status: 'open',
      });
      expect(found?.handoffs[0]?.id).toEqual(expect.any(String));
      expect(found?.handoffs[0]?.createdAt).toBeInstanceOf(Date);
      expect(found?.handoffs[0]?.updatedAt).toBeInstanceOf(Date);
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

    it('핸드오프 큐: 모델 신호는 open으로 들어가고, 상태 필터·전이는 테넌트 경계 안에서만', async () => {
      const t = ctx.otherTenantId;
      const base = Date.parse('2026-11-04T11:00:00Z');
      const conv: string[] = [randomUUID(), randomUUID()];
      for (const [i, id] of conv.entries()) {
        await ctx.repos.conversations.appendTurn(id, t, {
          question: { role: 'user', content: `연결 요청 ${i}`, createdAt: new Date(base + i * 1000) },
          answer: { role: 'assistant', content: '자료에 없어요.' },
          handoff: { reason: 'not_in_knowledge', summary: `요약 ${i}` },
        });
      }
      const open = await ctx.repos.handoffs.list(t, { status: 'open', limit: 10 });
      const mine = open.items.filter((h) => conv.includes(h.conversationId));
      expect(mine.map((h) => h.summary)).toEqual(['요약 1', '요약 0']); // 최근순
      expect(mine[0]).toMatchObject({ tenantId: t, source: 'model', reason: 'not_in_knowledge', status: 'open', contact: null, preview: '연결 요청 1' });

      const first = mine[0];
      if (!first) throw new Error('핸드오프가 없다');
      const moved = await ctx.repos.handoffs.updateStatus(first.id, t, 'in_progress');
      expect(moved).toMatchObject({ id: first.id, status: 'in_progress', conversationId: first.conversationId });
      expect(moved?.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
      expect((await ctx.repos.handoffs.list(t, { status: 'open', limit: 10 })).items.map((h) => h.id)).not.toContain(first.id);
      expect((await ctx.repos.handoffs.list(t, { status: 'in_progress', limit: 10 })).items.map((h) => h.id)).toContain(first.id);
      expect((await ctx.repos.handoffs.list(t, { limit: 10 })).items.map((h) => h.id)).toContain(first.id); // 상태 없음 = 전부
      // 대화 상세에도 바뀐 상태가 보인다
      expect((await ctx.repos.conversations.find(first.conversationId, t))?.handoffs[0]?.status).toBe('in_progress');

      // 테넌트 경계: 다른 테넌트로는 못 바꾸고 못 본다
      expect(await ctx.repos.handoffs.updateStatus(first.id, ctx.tenantId, 'done')).toBeNull();
      expect(await ctx.repos.handoffs.updateStatus('missing', t, 'done')).toBeNull();
      expect((await ctx.repos.handoffs.list(ctx.tenantId, { limit: 100 })).items.some((h) => conv.includes(h.conversationId))).toBe(false);

      // 커서로 이어 받기
      const p1 = await ctx.repos.handoffs.list(t, { limit: 1 });
      expect(p1.items).toHaveLength(1);
      expect(p1.nextCursor).toEqual(expect.any(String));
      const p2 = await ctx.repos.handoffs.list(t, { limit: 1, cursor: p1.nextCursor });
      expect(p2.items[0]?.id).not.toBe(p1.items[0]?.id);
      await expect(ctx.repos.handoffs.list(t, { limit: 1, cursor: 'bad' })).rejects.toThrow(/cursor/);
    });

    it('방문자 요청: 대화가 없어도 접수되고(빈 대화와 함께), 연락처·메모가 남는다. 다른 테넌트의 대화에는 못 붙인다', async () => {
      const t = ctx.otherTenantId;
      const fresh = randomUUID();
      const { id } = await ctx.repos.handoffs.requestByVisitor(fresh, t, { contact: 'visitor@example.com', summary: '전화 주세요' });
      expect(id).toEqual(expect.any(String));
      const conversation = await ctx.repos.conversations.find(fresh, t);
      expect(conversation?.messages).toEqual([]);
      expect(conversation?.handoffs[0]).toMatchObject({
        id,
        source: 'visitor',
        reason: 'needs_human',
        contact: 'visitor@example.com',
        summary: '전화 주세요',
        status: 'open',
      });
      const inQueue = (await ctx.repos.handoffs.list(t, { status: 'open', limit: 50 })).items.find((h) => h.id === id);
      expect(inQueue).toMatchObject({ conversationId: fresh, preview: '' });
      expect((await ctx.repos.conversations.listByTenant(t, { limit: 50 })).items.find((c) => c.id === fresh)).toMatchObject({
        messageCount: 0,
        handoffCount: 1,
        preview: '',
      });

      // 이미 있는 대화에 붙이기 + 테넌트 경계
      const existing = randomUUID();
      await ctx.repos.conversations.appendTurn(existing, t, turn('환불 가능한가요?', '7일 이내면 됩니다.'));
      await ctx.repos.handoffs.requestByVisitor(existing, t, { contact: 'a@b.c', summary: null });
      expect((await ctx.repos.conversations.find(existing, t))?.handoffs).toHaveLength(1);
      await expect(ctx.repos.handoffs.requestByVisitor(existing, ctx.tenantId, { contact: 'x@y.z', summary: null })).rejects.toThrow(
        /another tenant/,
      );
      expect((await ctx.repos.conversations.find(existing, t))?.handoffs).toHaveLength(1);
    });

    it('크레딧: 잔액은 원장 합계, 같은 멱등 키는 한 번만, 턴 차감은 턴 저장과 함께 들어가고 중복 키는 건너뛴다', async () => {
      const t = ctx.otherTenantId; // 시드 지급이 없는 테넌트 — 0에서 시작
      const credits = ctx.repos.credits;
      expect(await credits.balance(t)).toBe(0);

      const first = await credits.append(t, { delta: 5, reason: 'adjustment', idempotencyKey: 'adj:contract-grant' });
      expect(first.duplicate).toBe(false);
      expect(first.entry).toMatchObject({ tenantId: t, delta: 5, reason: 'adjustment', idempotencyKey: 'adj:contract-grant' });
      const again = await credits.append(t, { delta: 5, reason: 'adjustment', idempotencyKey: 'adj:contract-grant' });
      expect(again.duplicate).toBe(true);
      expect(again.entry.id).toBe(first.entry.id);
      expect(await credits.balance(t)).toBe(5);

      // 답이 있는 턴은 -1. 같은 턴이 다시 저장돼도(같은 키) 한 번만 빠진다
      const id = randomUUID();
      const charged = { ...turn('질문', '답'), charge: { delta: -1, reason: 'turn' as const, idempotencyKey: `turn:${id}` } };
      await ctx.repos.conversations.appendTurn(id, t, charged);
      expect(await credits.balance(t)).toBe(4);
      await ctx.repos.conversations.appendTurn(id, t, charged);
      expect(await credits.balance(t)).toBe(4);
      expect((await ctx.repos.conversations.find(id, t))?.messages).toHaveLength(4); // 턴은 두 번 저장됐다 — 차감만 한 번
      // 답이 없는 턴(거절)은 charge가 null이라 빠지지 않는다
      await ctx.repos.conversations.appendTurn(id, t, { ...turn('거절될 질문', null), charge: null });
      expect(await credits.balance(t)).toBe(4);

      // 원장은 최근순, 커서로 이어 받는다. 다른 테넌트의 원장에는 없다
      const p1 = await credits.list(t, { limit: 1 });
      expect(p1.items.map((e) => e.reason)).toEqual(['turn']);
      const p2 = await credits.list(t, { limit: 1, cursor: p1.nextCursor });
      expect(p2.items.map((e) => e.reason)).toEqual(['adjustment']);
      expect(p2.nextCursor).toBeNull();
      expect((await credits.list(ctx.tenantId, { limit: 100 })).items.some((e) => e.idempotencyKey === 'adj:contract-grant')).toBe(false);
    });

    it('충전 주문: 같은 요청 키는 같은 주문(created=false), 키의 범위는 테넌트, 콘솔 조회는 테넌트 경계 안에서만', async () => {
      const topUps = ctx.repos.topUps;
      const t = ctx.otherTenantId;
      const key = `req-${randomUUID()}`;
      const first = await topUps.create(t, order(key));
      expect(first.created).toBe(true);
      expect(first.topUp).toMatchObject({
        tenantId: t,
        requestKey: key,
        packageId: 'credits_100',
        credits: 100,
        amount: 10_000,
        provider: 'mock',
        status: 'pending',
        settledAt: null,
      });
      expect(await topUps.create(t, order(key))).toEqual({ topUp: first.topUp, created: false });

      const elsewhere = await topUps.create(ctx.tenantId, order(key));
      expect(elsewhere.created).toBe(true);
      expect(elsewhere.topUp.id).not.toBe(first.topUp.id);

      expect(await topUps.findForTenant(first.topUp.id, t)).toEqual(first.topUp);
      expect(await topUps.findForTenant(first.topUp.id, ctx.tenantId)).toBeNull();
      expect(await topUps.findById(first.topUp.id)).toEqual(first.topUp);
      expect(await topUps.findById('missing')).toBeNull();
    });

    it('결제 완료: 주문이 paid로 가고 원장에 topup:<주문 id> 한 줄. 같은 이벤트 재배달은 처음 판정 그대로(replayed), 원장은 그대로', async () => {
      const t = ctx.tenantId;
      const { topUp } = await ctx.repos.topUps.create(t, order());
      const before = await ctx.repos.credits.balance(t);
      const eventId = `evt-${randomUUID()}`;

      const first = await deliver(ctx.repos, topUp.id, eventId, 'paid');
      expect(first).toMatchObject({ outcome: 'applied', replayed: false, topUp: { id: topUp.id, status: 'paid' } });
      expect(first.topUp.settledAt).toBeInstanceOf(Date);
      expect(await ctx.repos.credits.balance(t)).toBe(before + 100);

      for (let i = 0; i < 3; i += 1) {
        const again = await deliver(ctx.repos, topUp.id, eventId, 'paid');
        expect(again).toMatchObject({ outcome: 'applied', replayed: true, topUp: { id: topUp.id, status: 'paid' } });
      }
      expect(await ctx.repos.credits.balance(t)).toBe(before + 100);
      const lines = (await ctx.repos.credits.list(t, { limit: 100 })).items.filter((e) => e.idempotencyKey === `topup:${topUp.id}`);
      expect(lines).toEqual([expect.objectContaining({ delta: 100, reason: 'topup' })]);
    });

    it('다른 이벤트 id로 온 같은 결과는 stale — 원장 키가 주문 id라 두 줄이 되지 않고, stale도 기록돼 재배달하면 stale 그대로', async () => {
      const t = ctx.tenantId;
      const { topUp } = await ctx.repos.topUps.create(t, order());
      const before = await ctx.repos.credits.balance(t);
      expect((await deliver(ctx.repos, topUp.id, `evt-a-${topUp.id}`, 'paid')).outcome).toBe('applied');
      expect(await deliver(ctx.repos, topUp.id, `evt-b-${topUp.id}`, 'paid')).toMatchObject({ outcome: 'stale', replayed: false });
      expect(await deliver(ctx.repos, topUp.id, `evt-b-${topUp.id}`, 'paid')).toMatchObject({ outcome: 'stale', replayed: true });
      expect(await ctx.repos.credits.balance(t)).toBe(before + 100);
    });

    it('순서 뒤바뀜: 실패 뒤에 온 결제 완료는 paid로 가며 충전, 결제 완료 뒤에 온 실패는 stale이고 paid 그대로', async () => {
      const t = ctx.tenantId;
      const before = await ctx.repos.credits.balance(t);

      const late = (await ctx.repos.topUps.create(t, order())).topUp;
      expect(await deliver(ctx.repos, late.id, `evt-${randomUUID()}`, 'failed')).toMatchObject({ outcome: 'applied', topUp: { status: 'failed' } });
      expect(await ctx.repos.credits.balance(t)).toBe(before);
      expect(await deliver(ctx.repos, late.id, `evt-${randomUUID()}`, 'paid')).toMatchObject({ outcome: 'applied', topUp: { status: 'paid' } });
      expect(await ctx.repos.credits.balance(t)).toBe(before + 100);

      const early = (await ctx.repos.topUps.create(t, order())).topUp;
      await deliver(ctx.repos, early.id, `evt-${randomUUID()}`, 'paid');
      expect(await deliver(ctx.repos, early.id, `evt-${randomUUID()}`, 'failed')).toMatchObject({ outcome: 'stale', topUp: { status: 'paid' } });
      expect((await ctx.repos.topUps.findById(early.id))?.status).toBe('paid');
      expect(await ctx.repos.credits.balance(t)).toBe(before + 200);
    });

    it('충전 목록: 테넌트별 최근순, 커서로 이어 받기, 깨진 커서는 거부', async () => {
      const t = ctx.otherTenantId;
      for (let i = 0; i < 3; i += 1) await ctx.repos.topUps.create(t, order());
      const all = await ctx.repos.topUps.list(t, { limit: 100 });
      expect(all.items.length).toBeGreaterThanOrEqual(3);
      expect(all.items.every((x) => x.tenantId === t)).toBe(true);
      const times = all.items.map((x) => x.createdAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));

      const paged: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await ctx.repos.topUps.list(t, { limit: 2, cursor });
        paged.push(...page.items.map((x) => x.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(paged).toEqual(all.items.map((x) => x.id));

      const seedIds = (await ctx.repos.topUps.list(ctx.tenantId, { limit: 100 })).items.map((x) => x.id);
      expect(seedIds.some((id) => paged.includes(id))).toBe(false);
      await expect(ctx.repos.topUps.list(t, { limit: 2, cursor: 'bad' })).rejects.toThrow(/cursor/);
      await expect(ctx.repos.topUps.list(t, { limit: 0 })).rejects.toThrow(/limit/);
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
      found?.handoffs.push({
        id: 'ghost',
        source: 'model',
        reason: 'other',
        summary: null,
        contact: null,
        status: 'open',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const again = await ctx.repos.conversations.find(id, ctx.tenantId);
      expect(again?.messages).toHaveLength(2);
      expect(again?.handoffs).toEqual([]);
    });
  });
}
