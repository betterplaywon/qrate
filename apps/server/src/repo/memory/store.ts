import type { Conversation, CreditEntry, SettleOutcome, TopUp } from '../types.js';

// 메모리 구현의 상태. 대화·핸드오프·크레딧·충전 저장소가 같은 객체를 본다(DB에서는 같은 테이블들).
// 프로세스가 재시작되면 비워진다(dev의 tsx watch가 파일 변경마다 재시작한다).

interface PaymentEventRecord {
  topUpId: string;
  outcome: SettleOutcome;
}

export class MemoryStore {
  readonly conversations = new Map<string, Conversation>();
  /** 테넌트별 원장. 잔액은 합계다. */
  readonly credits = new Map<string, CreditEntry[]>();
  readonly topUps = new Map<string, TopUp>();
  /** 받은 제공자 이벤트. 키는 `<provider>:<eventId>`. */
  readonly paymentEvents = new Map<string, PaymentEventRecord>();
  private creditCounter = 0;
  private topUpCounter = 0;

  /** 원장 id — 같은 밀리초에도 뒤의 것이 더 큰 문자열(목록 tie-break가 id 내림차순). 핸드오프 id와 같은 이유. */
  nextCreditId(): string {
    return `c${Date.now().toString(36).padStart(9, '0')}${(this.creditCounter++).toString(36).padStart(6, '0')}`;
  }

  /** 충전 주문 id. 원장 id와 같은 이유로 시각 + 카운터. */
  nextTopUpId(): string {
    return `t${Date.now().toString(36).padStart(9, '0')}${(this.topUpCounter++).toString(36).padStart(6, '0')}`;
  }
}
