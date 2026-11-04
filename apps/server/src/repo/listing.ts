import { InvalidCursorError, PREVIEW_CHARS } from './types.js';

// 목록 조회의 공용 조각 — 커서 코덱·정렬·미리보기. 두 구현이 같은 형식을 쓴다 — 메모리로 만든 커서를 Postgres에 넘길 일은 없지만,
// 계약 테스트가 "커서는 불투명하고 왕복한다"를 한 곳에서 확인하게.

export interface CursorKey {
  createdAt: Date;
  id: string;
}

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify({ t: key.createdAt.toISOString(), id: key.id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorKey {
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
export function isAfterCursor(key: CursorKey, cursor: CursorKey): boolean {
  const dt = key.createdAt.getTime() - cursor.createdAt.getTime();
  if (dt !== 0) return dt < 0;
  return key.id < cursor.id;
}

export function compareNewestFirst(a: CursorKey, b: CursorKey): number {
  const dt = b.createdAt.getTime() - a.createdAt.getTime();
  if (dt !== 0) return dt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** 목록 미리보기: 첫 질문의 앞부분. 줄바꿈은 공백으로. */
export function previewOf(firstQuestion: string | undefined): string {
  return (firstQuestion ?? '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
}
