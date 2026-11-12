// 메시지를 보내는 길(입력란·전송 버튼·안내의 "다시 보내기")을 막는 두 이유를 한곳에 모은다. 화면에 그릴 상태는 여기서만 계산한다.
//   - 답을 받는 중(busy): 다음 질문을 미리 쓸 수는 있지만 보낼 수는 없다.
//   - 서버가 Retry-After로 기다리라고 했다(locked): 그 시간 동안 쓰지도 보내지도 못한다. 요율 제한(429) 중에 보낸 요청은
//     곧바로 또 429라서 안내와 버튼만 쌓인다. 턴이 끝나 busy가 풀려도 잠금은 남고, 시간이 지나야 풀린다.
// FrameApp 밖에 두는 이유: 브라우저 없이 가짜 타이머로 단위 테스트한다(test/composer.test.ts).

export type ComposerState = 'ready' | 'busy' | 'locked';

export interface ComposerEffects {
  /** 상태가 바뀔 수 있을 때마다 부른다. 화면은 받은 상태를 그대로 그린다. */
  render(state: ComposerState): void;
  /** 잠금이 풀렸다. 앱이 입력창에 초점을 돌려준다. */
  unlocked(): void;
}

export class Composer {
  private busy = false;
  private lock: { until: number; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly effects: ComposerEffects) {}

  get state(): ComposerState {
    if (this.lock) return 'locked';
    return this.busy ? 'busy' : 'ready';
  }

  /** 대화 요청은 한 번에 하나다. 잠금과 무관하게 답을 받는 중인지만 본다. */
  isBusy(): boolean {
    return this.busy;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.effects.render(this.state);
  }

  /** ms 동안 잠근다. 이미 더 늦게까지 잠겨 있으면 그대로 둔다. 잠금은 늘기만 하고 줄지 않는다. */
  lockFor(ms: number): void {
    const until = Date.now() + ms;
    if (this.lock && this.lock.until >= until) return;
    if (this.lock) clearTimeout(this.lock.timer);
    const timer = setTimeout(() => {
      this.lock = null;
      this.effects.render(this.state);
      this.effects.unlocked();
    }, ms);
    this.lock = { until, timer };
    this.effects.render(this.state);
  }
}
