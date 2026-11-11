import type { HandoffReason } from '../src/engine/types.js';
import type { Case } from './cases.js';

// 기계 채점: 시험지의 기대(expect)와 답의 사실만 보는 순수 함수. 뜻을 읽어야 하는 판정(지어냄·알맞음)은 심판(judge.ts)이 맡는다.

/** ok = 정상 종료, truncated = max_tokens로 잘림, refusal = 정책 거절, blocked = 모더레이션 차단(모델을 부르지 않음). */
export type AnswerStatus = 'ok' | 'truncated' | 'refusal' | 'blocked';

/** 기계 채점에 필요한 답의 사실. 저장된 답(AnswerRecord)과 심판 점검용 가짜 답이 둘 다 이 모양이다. */
export interface GradableAnswer {
  status: AnswerStatus;
  text: string;
  handoff: { reason: HandoffReason; summary: string | null } | null;
  citations: readonly { sourceId: string }[];
}

export const RULE_NAMES = ['completed', 'handoff', 'guidance', 'cites', 'mustInclude', 'language'] as const;
export type RuleName = (typeof RULE_NAMES)[number];
export type RuleOutcome = { verdict: 'pass' } | { verdict: 'na' } | { verdict: 'fail'; detail: string };
export type RuleResult = Record<RuleName, RuleOutcome>;

const PASS: RuleOutcome = { verdict: 'pass' };
const NA: RuleOutcome = { verdict: 'na' };
const fail = (detail: string): RuleOutcome => ({ verdict: 'fail', detail });

/** 쉼표·공백·대소문자를 무시한다(시험지 $comment). */
function normalize(text: string): string {
  return text.replace(/[\s,]/g, '').toLowerCase();
}

/** 숫자로 시작하는 낱말은 바로 앞에 숫자가 붙어 있으면 맞지 않은 것으로 본다 — 99,000원이 199,000원에, 7일이 17일에 걸리지 않게. */
export function includesNeedle(text: string, needle: string): boolean {
  const hay = normalize(text);
  const pin = normalize(needle);
  if (pin === '') return false;
  const digitLed = /^\d/.test(pin);
  for (let at = hay.indexOf(pin); at !== -1; at = hay.indexOf(pin, at + 1)) {
    if (!digitLed || at === 0 || !/\d/.test(hay.charAt(at - 1))) return true;
  }
  return false;
}

/** 영어 답인가: 글자 중 한글 비율이 1/5 이하. 영어 답도 상호(마루인보이스)나 '원' 같은 한글을 몇 자 섞을 수 있어 0으로 두지 않는다. */
export function isMostlyEnglish(text: string): boolean {
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  const hangul = text.match(/[ㄱ-ㆎ가-힣]/g)?.length ?? 0;
  return latin > 0 && hangul * 5 <= latin + hangul;
}

export function gradeRules(c: Case, answer: GradableAnswer): RuleResult {
  const { expect } = c;
  const text = answer.text.trim();
  const handedOff = answer.handoff !== null;
  const cited = new Set(answer.citations.map((x) => x.sourceId));
  const missingCites = expect.cites.filter((id) => !cited.has(id));
  const missingGroups = expect.mustInclude.filter((group) => !group.some((needle) => includesNeedle(text, needle)));

  return {
    completed: answer.status === 'ok' ? PASS : fail(`종료 상태 ${answer.status}`),
    handoff:
      expect.handoff === null
        ? NA
        : expect.handoff === handedOff
          ? PASS
          : fail(expect.handoff ? '넘기지 않음' : `넘기면 안 되는데 넘김(${answer.handoff?.reason})`),
    // 넘길 때 안내 문장이 비면 방문자는 아무 설명 없이 연결 제안만 본다. 넘겨야 하는 질문이면 넘기지 않았어도 빈 답은 실패다.
    guidance: handedOff || expect.handoff === true ? (text ? PASS : fail('안내 문장이 비어 있음')) : NA,
    cites: expect.cites.length === 0 ? NA : missingCites.length === 0 ? PASS : fail(`인용 빠짐: ${missingCites.join(', ')}`),
    mustInclude:
      expect.mustInclude.length === 0
        ? NA
        : missingGroups.length === 0
          ? PASS
          : fail(`없음: ${missingGroups.map((group) => group.join(' | ')).join(' / ')}`),
    language: expect.language === 'en' ? (isMostlyEnglish(text) ? PASS : fail('영어 답이 아님')) : NA,
  };
}

export function failedRules(result: RuleResult): { rule: RuleName; detail: string }[] {
  return RULE_NAMES.flatMap((rule) => {
    const outcome = result[rule];
    return outcome.verdict === 'fail' ? [{ rule, detail: outcome.detail }] : [];
  });
}

/** 적용되는 규칙(na가 아닌 것)이 모두 통과. */
export function rulesPass(result: RuleResult): boolean {
  return failedRules(result).length === 0;
}
