// 모델이 결론 문장 바로 뒤에 그 문장의 끝부분을 한 번 더 쓰는 일이 있다. "아니요, 카카오톡 알림은 지원하지 않습니다. 카카오톡 알림은
// 지원하지 않습니다."처럼, 자료 문장을 인용하려고 그대로 다시 옮겨 적는 버릇이다(W5 v2 짧은 시험: 두 번 모두 28건 중 4건, 지시로는 줄지 않았다).
// 이 필터는 새 문장이 바로 앞 문장 안에 들어 있는 동안만 그 글을 붙잡아 둔다. 문장이 끝났을 때 앞 문장의 끝과 같으면 버리고,
// 중간에 달라지면 붙잡은 글을 바로 내보낸다 — 반복이 아닌 글은 몇 글자만 늦어진다.

/** 이보다 짧은 문장은 반복으로 버리지 않는다 — "네." 같은 짧은 말은 되풀이돼도 결함이 아니다. */
const MIN_REPEAT_LENGTH = 15;

/** 문장이 끝나는 자리: 마침표·물음표·느낌표 뒤, 또는 줄바꿈. */
function sentenceEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\n') return i;
    if ('.!?'.includes(ch)) return i + 1;
  }
  return -1;
}

export class RepeatSentenceFilter {
  /** 바로 앞에 끝난 문장(앞뒤 공백 없이). */
  private previous = '';
  /** 아직 끝나지 않은 지금 문장 중 붙잡아 둔 글. 지금 문장이 앞 문장과 달라지면 비운다. */
  private held = '';
  /** 지금 문장이 아직 앞 문장 안에 들어 있는가(반복일 수 있는가). */
  private candidate = true;
  /** 지금 문장 전체(이미 내보낸 부분 포함). 끝나면 previous가 된다. */
  private current = '';

  /** 텍스트 조각을 받아 지금 내보내도 되는 부분을 돌려준다. */
  push(chunk: string): string {
    let out = '';
    let rest = chunk;
    while (rest !== '') {
      const end = sentenceEnd(rest, 0);
      const piece = end === -1 ? rest : rest.slice(0, end === 0 ? 1 : end);
      rest = rest.slice(piece.length);
      out += this.take(piece);
      if (end !== -1) out += this.close();
    }
    return out;
  }

  /**
   * 스트림이 끝났을 때 남은 글. 마침표 없이 끝난 마지막 문장은 앞 문장의 끝("…다.")과 글자가 달라 되풀이여도 내보낸다
   * (독립 검증에서 확인, 관찰한 되풀이는 모두 마침표로 끝났다).
   */
  end(): string {
    return this.close();
  }

  private take(piece: string): string {
    this.current += piece;
    if (!this.candidate) return piece;
    this.held += piece;
    if (this.previous !== '' && this.previous.includes(this.current.trim())) return '';
    this.candidate = false;
    const out = this.held;
    this.held = '';
    return out;
  }

  private close(): string {
    const sentence = this.current.trim();
    const repeated = this.candidate && sentence.length >= MIN_REPEAT_LENGTH && this.previous.endsWith(sentence);
    const out = repeated ? '' : this.held;
    // 버린 문장은 앞 문장으로 삼지 않는다 — 같은 문장이 세 번 이어져도 앞 문장과 비교한다.
    if (!repeated && sentence !== '') this.previous = sentence;
    this.current = '';
    this.held = '';
    this.candidate = true;
    return out;
  }
}
