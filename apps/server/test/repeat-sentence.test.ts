import { describe, expect, it } from 'vitest';
import { RepeatSentenceFilter } from '../src/engine/repeat-sentence.js';

/** 스트림처럼 size 글자씩 잘라 넣고 내보낸 글을 모은다. */
function stream(text: string, size: number): string {
  const filter = new RepeatSentenceFilter();
  let out = '';
  for (let at = 0; at < text.length; at += size) out += filter.push(text.slice(at, at + size));
  return out + filter.end();
}

const SIZES = [1, 3, 7, 1000];

// W5 v2 짧은 시험 2회차의 실제 답(Sonnet k05·n05, Haiku n05)
const REPEATED = [
  {
    text: "아니요, 은행 계좌와 자동으로 연동해 입금을 확인하는 기능은 제공하지 않습니다. 은행 계좌와 자동으로 연동해 입금을 확인하는 기능은 제공하지 않습니다.\n\n대신 청구서 상세 화면에서 '입금 완료'를 직접 표시하는 방식으로 입금을 확인할 수 있습니다. 입금일과 금액을 기록할 수 있고, 미입금 청구서는 목록에서 따로 모아 볼 수 있습니다.",
    shown:
      "아니요, 은행 계좌와 자동으로 연동해 입금을 확인하는 기능은 제공하지 않습니다.\n\n대신 청구서 상세 화면에서 '입금 완료'를 직접 표시하는 방식으로 입금을 확인할 수 있습니다. 입금일과 금액을 기록할 수 있고, 미입금 청구서는 목록에서 따로 모아 볼 수 있습니다.",
  },
  {
    text: '아니요, 카카오톡 알림은 지원하지 않습니다. 카카오톡 알림은 지원하지 않습니다.\n\n열람 알림은 이메일로 오고, 팀 플랜에서는 슬랙으로도 받을 수 있습니다.',
    shown: '아니요, 카카오톡 알림은 지원하지 않습니다.\n\n열람 알림은 이메일로 오고, 팀 플랜에서는 슬랙으로도 받을 수 있습니다.',
  },
  {
    text: '아니요, 카카오톡 알림은 지원하지 않습니다. 카카오톡 알림은 지원하지 않습니다. 열람 알림은 이메일로 오고, 팀 플랜에서는 슬랙으로도 받을 수 있습니다.',
    shown: '아니요, 카카오톡 알림은 지원하지 않습니다. 열람 알림은 이메일로 오고, 팀 플랜에서는 슬랙으로도 받을 수 있습니다.',
  },
];

// 되풀이가 아닌 답은 글자 하나 바뀌지 않아야 한다(같은 시험의 Sonnet n03·n02, 소수점·주소가 든 문장, 짧은 반복).
const UNCHANGED = [
  '아니요, 지원하지 않습니다. 공개 API와 웹훅은 제공하지 않습니다.\n\n데이터를 옮겨야 하는 경우에는 설정의 데이터 메뉴에서 문서 목록과 고객 정보를 CSV로, 발행한 문서 전체를 PDF 묶음(zip)으로 내보낼 수 있습니다.',
  '아니요, 마루인보이스에서는 환율 적용 자체를 지원하지 않습니다. 달러·엔 같은 외화로 청구서를 발행하거나 환율을 적용하는 기능은 지원하지 않습니다. 그래서 자동 적용은 물론, 환율을 직접 입력하는 방식으로도 달러 청구서를 만들 수 없습니다.\n\n해외 고객에게 보낼 문서의 양식 언어는 영어로 고를 수 있습니다.',
  '원천징수 3.3%를 빼고 청구하는 방법은 상담원이 이어서 안내해 드릴게요. 장애 공지는 status.maru-invoice.example에서 볼 수 있습니다.',
  '네. 네. 월 9,900원입니다.',
  '- **월간 결제**: 결제 후 7일 이내이고 그 기간에 발행한 문서가 없으면 전액 환불됩니다.\n- **연간 결제**: 결제 후 30일 이내에 요청하면 전액 환불됩니다.',
];

describe('RepeatSentenceFilter — 바로 앞 문장을 되풀이한 문장 버리기', () => {
  it.each(REPEATED.map((c, i) => [i, c] as const))('되풀이한 문장만 빠진다(실제 답 %i), 조각 크기와 무관하게', (_, c) => {
    for (const size of SIZES) expect(stream(c.text, size)).toBe(c.shown);
  });

  it.each(UNCHANGED.map((t, i) => [i, t] as const))('되풀이가 아니면 그대로 내보낸다(%i)', (_, text) => {
    for (const size of SIZES) expect(stream(text, size)).toBe(text);
  });

  it('같은 문장이 세 번 이어져도 처음 하나만 남는다', () => {
    expect(stream('아니요, 카카오톡 알림은 지원하지 않습니다. 카카오톡 알림은 지원하지 않습니다. 카카오톡 알림은 지원하지 않습니다.', 4)).toBe(
      '아니요, 카카오톡 알림은 지원하지 않습니다.',
    );
  });

  it('첫 문장은 붙잡지 않고, 앞 문장과 달라지는 순간 붙잡은 글을 내보낸다', () => {
    const filter = new RepeatSentenceFilter();
    expect(filter.push('아니요, 카카오톡 알림은 지원하지 않습니다.')).toBe('아니요, 카카오톡 알림은 지원하지 않습니다.');
    expect(filter.push(' 카카오톡')).toBe('');
    expect(filter.push('으로는 보내지 않아요')).toBe(' 카카오톡으로는 보내지 않아요');
    expect(filter.end()).toBe('');
  });
});
