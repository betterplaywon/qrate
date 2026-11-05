import type { ApiErrorBody, ApiErrorCode, HandoffStatus } from '@qrate/contracts';
import { consoleListQuerySchema } from '@qrate/contracts/schemas';
import type { Response } from 'express';
import { InvalidCursorError } from '../../repo/types.js';

// 목록 조회(?limit=&cursor=&status=)의 쿼리 해석과 커서 오류의 HTTP 변환.

export interface ListQuery {
  limit: number;
  cursor: string | null;
  status: HandoffStatus | null;
}

/** 어느 항목이 틀렸는지 → 오류 코드. 그 밖의 항목(알 수 없음)은 limit 오류로 본다. */
const QUERY_ERROR_CODES: Record<string, ApiErrorCode> = {
  status: 'invalid_status',
  cursor: 'invalid_cursor',
  limit: 'invalid_limit',
};

/** 틀린 값이면 400을 보내고 null. 맞으면 기본값이 채워진 쿼리. */
export function parseListQuery(raw: unknown, res: Response): ListQuery | null {
  const parsed = consoleListQuerySchema.safeParse(raw);
  if (parsed.success) {
    return { limit: parsed.data.limit, cursor: parsed.data.cursor ?? null, status: parsed.data.status ?? null };
  }
  const field = String(parsed.error.issues[0]?.path[0] ?? 'limit');
  res.status(400).json({ error: QUERY_ERROR_CODES[field] ?? 'invalid_limit' } satisfies ApiErrorBody);
  return null;
}

/** 목록 조회에서 깨진 커서는 400, 그 밖의 예외는 그대로 흘려 app.ts의 오류 핸들러(500 + 보고)로. */
export async function withCursorErrors<T>(res: Response, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      res.status(400).json({ error: 'invalid_cursor' } satisfies ApiErrorBody);
      return null;
    }
    throw err;
  }
}
