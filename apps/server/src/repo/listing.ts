import { InvalidCursorError, PREVIEW_CHARS } from './types.js';

// 목록 조회의 공용 조각 — 커서 코덱·정렬·페이지 나누기·미리보기. 두 구현이 같은 형식을 쓴다 — 메모리로 만든 커서를 Postgres에 넘길 일은 없지만,
// 계약 테스트가 "커서는 불투명하고 왕복한다"를 한 곳에서 확인하게.

export interface CursorKey {
  createdAt: Date;
  id: string;
}

function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify({ t: key.createdAt.toISOString(), id: key.id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): CursorKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (typeof parsed !== 'object' || parsed === null) throw new InvalidCursorError();
  const { t, id } = parsed as { t?: unknown; id?: unknown };
  if (typeof t !== 'string' || typeof id !== 'string' || id.length === 0) throw new InvalidCursorError();
  const createdAt = new Date(t);
  if (Number.isNaN(createdAt.getTime())) throw new InvalidCursorError();
  return { createdAt, id };
}

/** 최근순 정렬에서 key가 cursor "뒤"(더 오래된 쪽)인가. createdAt 내림차순, 같으면 id 내림차순(코드 단위). */
function isAfterCursor(key: CursorKey, cursor: CursorKey): boolean {
  const dt = key.createdAt.getTime() - cursor.createdAt.getTime();
  if (dt !== 0) return dt < 0;
  return key.id < cursor.id;
}

function compareNewestFirst(a: CursorKey, b: CursorKey): number {
  const dt = b.createdAt.getTime() - a.createdAt.getTime();
  if (dt !== 0) return dt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function parsePageRequest(limit: number, cursor: string | null): CursorKey | null {
  if (limit < 1) throw new RangeError('limit must be >= 1');
  return cursor ? decodeCursor(cursor) : null;
}

/** 메모리 구현용. Postgres 구현은 같은 일을 WHERE·ORDER BY로 한다(prisma/cursor.ts). */
export function newestFirstAfter<T extends CursorKey>(rows: readonly T[], after: CursorKey | null): T[] {
  return rows.filter((row) => !after || isAfterCursor(row, after)).sort(compareNewestFirst);
}

/**
 * rows는 커서 뒤의 행을 최근순으로 담는다. 한 줄 더 가져와 다음 페이지가 있는지 본다 —
 * 다음 페이지가 있으면 rows가 limit개보다 많아야 한다. Postgres 구현은 take: limit + 1로 가져오고, 메모리 구현은 커서 뒤 전부를 넘긴다.
 */
export function toPage<T extends CursorKey, I>(rows: readonly T[], limit: number, toItem: (row: T) => I): { items: I[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(toItem), nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

/** 목록 미리보기: 첫 질문의 앞부분. 줄바꿈은 공백으로. */
export function previewOf(firstQuestion: string | undefined): string {
  return (firstQuestion ?? '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
}
