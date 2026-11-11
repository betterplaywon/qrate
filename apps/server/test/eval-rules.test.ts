import { describe, expect, it } from 'vitest';
import { gradeRules, includesNeedle, isMostlyEnglish, rulesPass, type GradableAnswer } from '../eval/rules.js';
import { makeCase } from './helpers/eval-fixtures.js';

// 기계 채점 규칙: 시험지 $comment가 정한 대로 동작하는가.

function answer(over: Partial<GradableAnswer> = {}): GradableAnswer {
  return { status: 'ok', text: '답입니다', handoff: null, citations: [], ...over };
}

const HANDOFF = { reason: 'not_in_knowledge' as const, summary: '요약' };

describe('필수 표현 맞추기 — includesNeedle', () => {
  it('숫자로 시작하는 표현은 앞에 숫자가 붙으면 맞지 않는다', () => {
    expect(includesNeedle('스타터는 연 199,000원입니다', '99,000원')).toBe(false);
    expect(includesNeedle('스타터는 연 99,000원입니다', '99,000원')).toBe(true);
    expect(includesNeedle('17일 안에 요청하세요', '7일')).toBe(false);
    expect(includesNeedle('결제 후 7일 이내', '7일')).toBe(true);
    expect(includesNeedle('12 months of service', '2 months')).toBe(false);
  });

  it('앞에서 막혀도 뒤에 맞는 자리가 있으면 맞다', () => {
    expect(includesNeedle('17일이 아니라 7일입니다', '7일')).toBe(true);
  });

  it('쉼표·띄어쓰기·대소문자를 무시한다', () => {
    expect(includesNeedle('월 9900 원', '9,900원')).toBe(true);
    expect(includesNeedle('You get 2 Months free', '2 months')).toBe(true);
    expect(includesNeedle('한시간 동안', '한 시간')).toBe(true);
  });

  it('숫자로 시작하지 않는 표현은 그냥 포함 여부다', () => {
    expect(includesNeedle('고객센터는 평일에만', '평일')).toBe(true);
    expect(includesNeedle('주말에도 운영', '평일')).toBe(false);
  });
});

describe('규칙 채점 — gradeRules', () => {
  it('필수 표현은 묶음마다 대안 하나면 되고, 모든 묶음이 있어야 한다', () => {
    const c = makeCase('x', { expect: { handoff: false, mustInclude: [['99,000원'], ['30일']] } });
    expect(gradeRules(c, answer({ text: '연 99,000원이고 30일 안에 환불됩니다' })).mustInclude).toEqual({ verdict: 'pass' });
    const partial = gradeRules(c, answer({ text: '연 99,000원입니다' })).mustInclude;
    expect(partial.verdict).toBe('fail');
    expect(partial.verdict === 'fail' && partial.detail).toContain('30일');

    const alt = makeCase('y', { expect: { mustInclude: [['1시간', '한 시간', '60분']] } });
    expect(gradeRules(alt, answer({ text: '링크는 60분 동안 유효합니다' })).mustInclude.verdict).toBe('pass');
  });

  it('인용은 기대한 FAQ를 모두 인용해야 한다(더 인용해도 된다)', () => {
    const c = makeCase('x', { expect: { cites: ['faq:a', 'faq:b'] } });
    const one = gradeRules(c, answer({ citations: [{ sourceId: 'faq:a' }] })).cites;
    expect(one.verdict === 'fail' && one.detail).toContain('faq:b');
    expect(gradeRules(c, answer({ citations: [{ sourceId: 'faq:b' }, { sourceId: 'faq:a' }, { sourceId: 'faq:c' }] })).cites.verdict).toBe('pass');
    expect(gradeRules(makeCase('y'), answer()).cites.verdict).toBe('na');
  });

  it('넘김: true는 넘겨야, false는 넘기면 안 되고, null은 채점하지 않는다', () => {
    const must = makeCase('t', { expect: { handoff: true } });
    expect(gradeRules(must, answer()).handoff.verdict).toBe('fail');
    expect(gradeRules(must, answer({ handoff: HANDOFF })).handoff.verdict).toBe('pass');
    const never = makeCase('f', { expect: { handoff: false } });
    expect(gradeRules(never, answer({ handoff: HANDOFF })).handoff.verdict).toBe('fail');
    expect(gradeRules(never, answer()).handoff.verdict).toBe('pass');
    const ungraded = makeCase('n', { expect: { handoff: null } });
    expect(gradeRules(ungraded, answer({ handoff: HANDOFF })).handoff.verdict).toBe('na');
    expect(gradeRules(ungraded, answer()).handoff.verdict).toBe('na');
  });

  it('넘기면서 안내 문장이 비면 실패다 — 넘겨야 하는 사례면 넘기지 않았어도 빈 답은 실패', () => {
    const ungraded = makeCase('n');
    expect(gradeRules(ungraded, answer({ text: '  ', handoff: HANDOFF })).guidance.verdict).toBe('fail');
    expect(gradeRules(ungraded, answer({ text: '자료에 없어요. 상담원에게 문의해 주세요.', handoff: HANDOFF })).guidance.verdict).toBe('pass');
    expect(gradeRules(makeCase('t', { expect: { handoff: true } }), answer({ text: '' })).guidance.verdict).toBe('fail');
    expect(gradeRules(makeCase('f', { expect: { handoff: false } }), answer({ text: '' })).guidance.verdict).toBe('na');
  });

  it('영어 사례는 영어로 답해야 한다(상호·원 같은 한글 몇 자는 괜찮다)', () => {
    const c = makeCase('e', { expect: { language: 'en' } });
    expect(gradeRules(c, answer({ text: 'Yes. With annual billing you pay for 10 months; Starter is 99,000원 per year at 마루인보이스.' })).language.verdict).toBe('pass');
    expect(gradeRules(c, answer({ text: '연간 결제를 하면 2개월분이 할인됩니다. Starter 플랜 기준입니다.' })).language.verdict).toBe('fail');
    expect(isMostlyEnglish('')).toBe(false);
  });

  it('한국어 사례는 한국어로 답해야 한다 — API·CSV 같은 낱말은 괜찮고, 영어 문장이 섞이면 실패', () => {
    const k = makeCase('k');
    expect(gradeRules(k, answer()).language.verdict).toBe('pass');
    expect(gradeRules(k, answer({ text: '아니요, 공개 API와 웹훅은 제공하지 않습니다. 데이터는 CSV나 PDF 묶음(zip)으로 내보낼 수 있습니다.' })).language.verdict).toBe('pass');
    // v2 짧은 시험 Haiku h02: 영어 메모가 답 앞에 붙었다
    const mixed =
      "This is an account change request, which needs a human agent to process. The materials don't describe how to change the login email, so I'll hand it off. 로그인 이메일 변경은 상담원이 이어서 안내해 드리겠습니다.";
    expect(gradeRules(k, answer({ text: mixed })).language.verdict).toBe('fail');
    expect(gradeRules(k, answer({ text: '' })).language.verdict).toBe('na');
  });

  it('잘림·거절·차단은 정상 종료가 아니라서 다른 규칙과 상관없이 통과하지 못한다', () => {
    const c = makeCase('x');
    for (const status of ['truncated', 'refusal', 'blocked'] as const) {
      const result = gradeRules(c, answer({ status }));
      expect(result.completed.verdict).toBe('fail');
      expect(rulesPass(result)).toBe(false);
    }
    expect(rulesPass(gradeRules(c, answer()))).toBe(true);
  });

  it('방문자에게 내부 표현("자료")을 쓰면 실패한다 — 띄어쓰기가 다르거나 말을 바꿔도', () => {
    const c = makeCase('x');
    // W5 v1 Sonnet 답과 v2 짧은 시험 Haiku 답에서 실제로 나온 문장들
    for (const text of [
      '원천징수 3.3% 자동 계산 여부는 안내 자료에 없는 내용입니다.',
      'API나 웹훅 제공 여부는 안내자료에서 확인되지 않습니다.',
      '자료에는 기업용 요금이나 별도 견적에 관한 내용이 없습니다.',
      '이 부분은 제가 자료로 확인할 수 없는 개별 발송 건의 원인이라, 상담원이 이어서 안내해 드리겠습니다.',
    ]) {
      expect(gradeRules(c, answer({ text })).plainWords.verdict).toBe('fail');
    }
    expect(gradeRules(c, answer({ text: '그 부분은 상담원이 이어서 안내해 드릴게요.' })).plainWords.verdict).toBe('pass');
    expect(gradeRules(c, answer({ text: '' })).plainWords.verdict).toBe('na');
  });

  it('본문에 도구 호출 태그가 남아 있으면 실패한다', () => {
    const leaked = '정확한 가능 여부는 상담원이 확인해 드립니다.\n\n<invoke name="request_handoff">\n<parameter name="reason">needs_human</parameter>';
    expect(gradeRules(makeCase('x'), answer({ text: leaked })).toolMarkup.verdict).toBe('fail');
    expect(gradeRules(makeCase('x'), answer({ text: '금액이 < 10만 원이면 됩니다.' })).toolMarkup.verdict).toBe('pass');
  });

  it('같은 문장이 두 번 나오면 실패한다 — 앞에 말이 붙은 문장 안에 들어 있어도', () => {
    // W5 v1 k05 1회차
    const repeated =
      '아니요, 은행 계좌와 자동으로 연동해 입금을 확인하는 기능은 제공하지 않습니다. 은행 계좌와 자동으로 연동해 입금을 확인하는 기능은 제공하지 않습니다.\n\n대신 직접 표시하는 방식으로 관리할 수 있습니다.';
    const result = gradeRules(makeCase('x'), answer({ text: repeated }));
    expect(result.repetition).toEqual({ verdict: 'fail', detail: expect.stringContaining('같은 문장 반복') });
    expect(gradeRules(makeCase('x'), answer({ text: '네. 네. 월 9,900원입니다.' })).repetition.verdict).toBe('pass');
  });
});
