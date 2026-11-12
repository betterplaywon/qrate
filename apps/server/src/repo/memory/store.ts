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
  readonly paymentEvents = new Map<string, PaymentEventRecord>();
  private idCounter = 0;

  nextCreditId(): string {
    return this.nextId('c');
  }

  nextTopUpId(): string {
    return this.nextId('t');
  }

  nextHandoffId(): string {
    return this.nextId('m');
  }

  /**
   * 같은 밀리초에 두 건이 생겨도 뒤의 것이 더 큰 문자열이 되게(시각 base36 + 카운터).
   * 목록 정렬의 tie-break가 id 내림차순이라, Postgres의 cuid(시각 + 카운터)처럼 저장 순서를 그대로 보존해야 두 구현의 결과가 같다.
   */
  private nextId(prefix: 'c' | 't' | 'm'): string {
    return `${prefix}${Date.now().toString(36).padStart(9, '0')}${(this.idCounter++).toString(36).padStart(6, '0')}`;
  }
}
