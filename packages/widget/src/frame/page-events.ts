import type { WidgetEventBody, WidgetEventType } from '@qrate/contracts';

/**
 * 한 페이지 로드(대화창 문서 하나)의 위젯 사건. 지키는 것은 셋이다.
 *   1. widget_open·first_question은 각각 페이지 로드당 한 번.
 *   2. 둘 다 그 순간 화면에 붙어 있던 인사말의 변형을 싣는다. 인사말이 없었으면 변형 키를 뺀다.
 *   3. 인사말은 두 사건이 나가기 전에만 붙는다. 첫 질문이 먼저 나간 페이지 로드는 실험에서 빠진다 —
 *      노출 없이 첫 질문만 세거나, 변형 없는 열림 뒤에 변형 있는 첫 질문이 나가지 않게.
 * 보내기는 주입한다(대화창은 sendWidgetEvent, 테스트는 배열).
 */
export class PageLoadEvents {
  private shownVariant: string | null = null;
  private openSent = false;
  private questionSent = false;

  constructor(
    private readonly tenant: string,
    private readonly emit: (body: WidgetEventBody) => void,
  ) {}

  /** 인사말을 붙여도 되면 그 변형을 기억하고 true. 사건이 이미 나갔으면 false — 호출자는 그리지 않는다. */
  showGreeting(variant: string): boolean {
    if (this.openSent || this.questionSent) return false;
    this.shownVariant = variant;
    return true;
  }

  /** 첫 열림. 호출자는 인사말 요청이 끝난 뒤에 부른다. */
  open(): void {
    if (this.openSent) return;
    this.openSent = true;
    this.emit(this.body('widget_open'));
  }

  /** 재시도가 아닌 첫 질문. 서버 결과(차단·크레딧 부족·요율 제한)와 무관하게 보낸 순간 센다. */
  question(): void {
    if (this.questionSent) return;
    this.questionSent = true;
    this.emit(this.body('first_question'));
  }

  private body(type: WidgetEventType): WidgetEventBody {
    return this.shownVariant ? { tenant: this.tenant, type, variant: this.shownVariant } : { tenant: this.tenant, type };
  }
}
