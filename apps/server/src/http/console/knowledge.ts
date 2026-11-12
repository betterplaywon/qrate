import type { ApiErrorBody, KnowledgeItemDto, KnowledgeListResponse } from '@qrate/contracts';
import { knowledgeIdSchema, knowledgeInputSchema } from '@qrate/contracts/schemas';
import express, { Router, type RequestHandler, type Response } from 'express';
import { saveKnowledge } from '../../console/knowledge.js';
import type { KnowledgeItem, Repositories } from '../../repo/types.js';
import { tenantIdOf } from './session.js';

// FAQ 편집: 목록, 저장(PUT 하나로 만들기와 바꾸기), 지우기. 계약은 @qrate/contracts/console.ts.
// 새 항목의 id는 콘솔이 만들어 PUT한다. 저장을 두 번 누르거나 응답을 못 받아 다시 보내도 항목은 하나다.
// 바뀐 FAQ는 다음 질문부터 쓰인다. 대화 API가 질문마다 저장소에서 FAQ를 읽기 때문이다(chat/knowledge.ts).

// 문단 10개 × 1,000자가 한글(UTF-8 3바이트)이면 30kB를 넘는다. 다른 콘솔 요청의 4kb로는 모자란다.
const KNOWLEDGE_BODY_LIMIT = '64kb';

export interface KnowledgeRoutesOptions {
  repos: Repositories;
  session: RequestHandler;
  ownOrigin: RequestHandler;
}

const toDto = ({ id, title, category, blocks }: KnowledgeItem): KnowledgeItemDto => ({ id, title, category, blocks });

function invalid(res: Response): void {
  res.status(400).json({ error: 'invalid_knowledge' } satisfies ApiErrorBody);
}

export function createKnowledgeRoutes({ repos, session, ownOrigin }: KnowledgeRoutesOptions): Router {
  const router = Router();
  const json = express.json({ limit: KNOWLEDGE_BODY_LIMIT });

  router.get('/', session, async (_req, res) => {
    const items = await repos.knowledge.listByTenant(tenantIdOf(res));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: items.map(toDto) } satisfies KnowledgeListResponse);
  });

  router.put('/:id', session, ownOrigin, json, async (req, res) => {
    const id = knowledgeIdSchema.safeParse(req.params.id);
    const body = knowledgeInputSchema.safeParse(req.body);
    if (!id.success || !body.success) {
      invalid(res);
      return;
    }
    const item: KnowledgeItem = { ...body.data, id: id.data, tenantId: tenantIdOf(res) };
    const saved = await saveKnowledge(repos.knowledge, item);
    if (!saved.ok) {
      res.status(409).json({ error: saved.error } satisfies ApiErrorBody);
      return;
    }
    res.status(saved.created ? 201 : 200).json(toDto(item));
  });

  router.delete('/:id', session, ownOrigin, async (req, res) => {
    const id = knowledgeIdSchema.safeParse(req.params.id);
    if (!id.success) {
      invalid(res);
      return;
    }
    await repos.knowledge.remove(id.data, tenantIdOf(res));
    res.status(204).end();
  });

  return router;
}
