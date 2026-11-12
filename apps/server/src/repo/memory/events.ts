import { sortEventCounts, toEventRow, type EventRow } from '../event-log.js';
import type { AppEvent, EventCount, EventRepository, TimeWindow } from '../types.js';
import { inWindow } from './records.js';

/** 사건은 이 저장소만 읽고 쓴다 — MemoryStore에 둘 공유 상태가 아니다. */
export class MemoryEventRepository implements EventRepository {
  private readonly rows: EventRow[] = [];

  async record(event: AppEvent): Promise<void> {
    this.rows.push(toEventRow(event));
  }

  async ttftSamples(tenantId: string, window: TimeWindow): Promise<number[]> {
    return this.rows.flatMap((r) =>
      r.tenantId === tenantId && r.type === 'chat_request' && r.ttftMs !== null && inWindow(r.createdAt, window) ? [r.ttftMs] : [],
    );
  }

  async counts(tenantId: string, window: TimeWindow): Promise<EventCount[]> {
    const counts: EventCount[] = [];
    for (const r of this.rows) {
      if (r.tenantId !== tenantId || !inWindow(r.createdAt, window)) continue;
      const hit = counts.find((c) => c.type === r.type && c.variant === r.variant);
      if (hit) hit.count += 1;
      else counts.push({ type: r.type, variant: r.variant, count: 1 });
    }
    return sortEventCounts(counts);
  }

  async lastAt(tenantId: string, type: AppEvent['type']): Promise<Date | null> {
    let last: Date | null = null;
    for (const r of this.rows) {
      if (r.tenantId === tenantId && r.type === type && (!last || r.createdAt > last)) last = r.createdAt;
    }
    return last;
  }
}
