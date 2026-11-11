import { randomUUID } from 'node:crypto';
import { billingPrice, costUsd } from './models.js';
import type { Billing, CallRecord, CallStart, Phase } from './records.js';

// 예산 장부와 관문. 장부는 실행 폴더의 calls.jsonl 전체(모든 단계)를 접은 값이고, 관문은 호출을 시작하기 전에 상한을 본다.
// 상한은 실행 폴더 단위 누계다 — 같은 폴더에서 단계를 이어 가면 앞 단계의 호출과 비용이 그대로 들어 있다.

export interface Caps {
  maxCalls: number;
  maxUsd: number;
}

export interface LedgerTotals {
  /** 시작한 실제 호출 수(실패·재시도 포함). */
  calls: number;
  /** 측정 비용 + 사용량을 모르는 호출의 상한. 관문은 이 값으로 판단한다. */
  spentUsd: number;
  /** 응답의 사용량으로 센 비용만. */
  measuredUsd: number;
  /** 사용량을 모르는 실제 호출 수(시간 초과·도중 실패·기록 전에 멈춤). spentUsd에는 상한으로 들어 있다. */
  unmeasuredCalls: number;
}

/** 측정한 호출 1건의 비용. 목업처럼 가격표에 없는 모델은 0. */
export function measuredCostUsd(start: CallStart, outcome: Billing): number {
  if (outcome.billing !== 'measured') return 0;
  const price = billingPrice(start.model, outcome.servedBy);
  return price ? costUsd(price, outcome.usage) : 0;
}

export function foldCalls(rows: readonly CallRecord[]): LedgerTotals {
  const ends = new Map<string, Billing>();
  for (const row of rows) if (row.type === 'end') ends.set(row.callId, row.outcome);
  const totals: LedgerTotals = { calls: 0, spentUsd: 0, measuredUsd: 0, unmeasuredCalls: 0 };
  for (const row of rows) {
    if (row.type !== 'start' || !row.billable) continue;
    totals.calls += 1;
    const outcome = ends.get(row.callId);
    if (outcome?.billing === 'measured') {
      const cost = measuredCostUsd(row, outcome);
      totals.spentUsd += cost;
      totals.measuredUsd += cost;
    } else if (outcome?.billing !== 'none') {
      totals.spentUsd += row.ceilingUsd;
      totals.unmeasuredCalls += 1;
    }
  }
  return totals;
}

export interface CallRequest {
  phase: Phase;
  key: string;
  attempt: number;
  model: string;
  billable: boolean;
  ceilingUsd: number;
}

export interface CallTicket {
  readonly start: CallStart;
}

export type GateDecision = { ok: true; ticket: CallTicket } | { ok: false; reason: string };

/**
 * 호출 관문. 시작 전에 "이미 시작한 호출 + 이번 1건 ≤ 호출 상한"과 "쓴 돈 + 진행 중인 호출들의 상한 + 이번 호출의 상한 ≤ 비용 상한"을 본다.
 * 한 번 막으면 계속 막는다 — 진행 중이던 호출이 상한보다 싸게 끝나도 새로 시작하지 않고, 왜 멈췄는지 한 줄로 남긴다.
 */
export class CallGate {
  private inFlightUsd = 0;
  private refusal: string | null = null;

  constructor(
    private readonly totals: LedgerTotals,
    /** null이면 실제 호출을 시작할 수 없다(목업·가짜만 도는 명령). */
    private readonly caps: Caps | null,
    private readonly record: (row: CallRecord) => void,
  ) {}

  get stopReason(): string | null {
    return this.refusal;
  }

  snapshot(): LedgerTotals & { inFlightUsd: number } {
    return { ...this.totals, inFlightUsd: this.inFlightUsd };
  }

  begin(req: CallRequest): GateDecision {
    if (this.refusal) return { ok: false, reason: this.refusal };
    if (req.billable) {
      const reason = this.check(req.ceilingUsd);
      if (reason) {
        this.refusal = reason;
        return { ok: false, reason };
      }
      this.totals.calls += 1;
      this.inFlightUsd += req.ceilingUsd;
    }
    const start: CallStart = { type: 'start', callId: randomUUID(), ...req, at: new Date().toISOString() };
    this.record(start);
    return { ok: true, ticket: { start } };
  }

  end(ticket: CallTicket, outcome: Billing): void {
    this.record({ type: 'end', callId: ticket.start.callId, outcome, at: new Date().toISOString() });
    if (!ticket.start.billable) return;
    this.inFlightUsd -= ticket.start.ceilingUsd;
    if (outcome.billing === 'measured') {
      const cost = measuredCostUsd(ticket.start, outcome);
      this.totals.spentUsd += cost;
      this.totals.measuredUsd += cost;
    } else if (outcome.billing === 'unknown') {
      this.totals.spentUsd += ticket.start.ceilingUsd;
      this.totals.unmeasuredCalls += 1;
    }
  }

  private check(ceilingUsd: number): string | null {
    if (!this.caps) return '실제 호출에는 --max-calls와 --max-usd가 필요하다';
    const { calls, spentUsd } = this.totals;
    if (calls + 1 > this.caps.maxCalls) return `호출 상한: 이 실행 폴더에서 이미 ${calls}건을 시작했고 상한은 ${this.caps.maxCalls}건이다`;
    const projected = spentUsd + this.inFlightUsd + ceilingUsd;
    if (projected > this.caps.maxUsd) {
      return `비용 상한: 쓴 돈 $${spentUsd.toFixed(4)} + 진행 중 상한 $${this.inFlightUsd.toFixed(4)} + 새 호출 상한 $${ceilingUsd.toFixed(4)} = $${projected.toFixed(4)} > $${this.caps.maxUsd}`;
    }
    return null;
  }
}
