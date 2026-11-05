import type { CreditReason, HandoffReason, HandoffSource, HandoffStatus, TopUpStatus } from '@qrate/contracts';

// 화면에 보이는 말. 계약의 코드값 → 운영자가 읽는 한국어.

export const STATUS_LABEL: Record<HandoffStatus, string> = { open: '열림', in_progress: '처리 중', done: '완료' };
export const SOURCE_LABEL: Record<HandoffSource, string> = { model: '모델 신호', visitor: '방문자 요청' };
export const CREDIT_REASON_LABEL: Record<CreditReason, string> = { seed: '초기 지급', topup: '충전', turn: '답변', adjustment: '조정' };
export const TOP_UP_STATUS_LABEL: Record<TopUpStatus, string> = { pending: '결제 대기', failed: '결제 실패', paid: '결제 완료' };
export const REASON_LABEL: Record<HandoffReason, string> = {
  not_in_knowledge: '자료에 없는 질문',
  needs_human: '사람이 처리할 요청',
  out_of_scope: '서비스 밖 질문',
  other: '기타',
};

const dateFormat = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

const numberFormat = new Intl.NumberFormat('ko-KR');
const rateFormat = new Intl.NumberFormat('ko-KR', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatWon(amount: number): string {
  return `${numberFormat.format(amount)}원`;
}

/** 지표 값. null(표본·대화 없음)은 —. */
export function formatMs(ms: number | null): string {
  return ms === null ? '—' : `${numberFormat.format(ms)}ms`;
}

export function formatRate(rate: number | null): string {
  return rate === null ? '—' : rateFormat.format(rate);
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFormat.format(d);
}
