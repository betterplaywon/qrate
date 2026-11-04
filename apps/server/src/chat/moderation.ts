// 입력 모더레이션 — 웹용 신규 구현.
//
// Beyond Meet(RN)에서는 "영상 프레임 → NSFW 모델 → 신뢰도 3단계(정상/경고/강제종료)"였다.
// 여기서는 같은 3단계 대응 패턴을 "텍스트 입력 → 패턴 필터"에 적용한다.
// 모달리티는 다르지만 설계(단계적 대응, 차단 사유 기록)는 이어진다.
//
// 한계(면접에서 먼저 말할 것): 사전/정규식 필터는 1차 방어선일 뿐이다.
// 우회 표기(초성, 특수문자 삽입)와 문맥 판단은 못 하므로,
// W5 평가셋에서 실패 사례를 수집한 뒤 LLM 기반 2차 분류를 검토한다.

export type ModerationLevel = 'ok' | 'warn' | 'block';

export interface ModerationResult {
  level: ModerationLevel;
  /** 걸린 규칙의 id(block:profanity, warn:prompt_injection). 어드민 콘솔과 이벤트 로그에 남기고 422 본문으로도 나간다 — 패턴 자체는 내보내지 않는다. */
  reasons: string[];
}

interface Rule {
  id: string;
  pattern: RegExp;
}

// 차단: 명백한 욕설·공격. (실서비스 전 확장 필요 — 지금은 대표 패턴만)
// 한글은 단어 안에서 음절이 이어지므로 부분 문자열 검사는 업무 어휘를 잡는다 — 즉시발행·즉시발송·출시발표·시발점(시발), 병신년(병신).
// 그래서 어근 앞에 한글이 없고(앞 음절이 있으면 다른 단어의 일부), 뒤에는 흔한 접미(놈·새끼·들·아·이)까지만 허용한 뒤 한글이 끝나야 욕설로 본다.
// 정규식으로 끝낼 수 없는 영역이다(접미 변형·초성·특수문자 삽입). 보증 범위는 test/moderation.test.ts의 오탐·정탐 표다.
const BLOCK_RULES: readonly Rule[] = [
  { id: 'block:profanity', pattern: /(?<![가-힣])(?:씨발|시발|병신|개새끼)(?:놈|새끼|들|아|이){0,2}(?![가-힣])/ },
  { id: 'block:profanity', pattern: /\bfuck(?:ing|er)?\b/i },
];

// 경고: 프롬프트 인젝션 의심. 응답은 계속하되 플래그를 남기고 콘솔에서 확인한다.
const WARN_RULES: readonly Rule[] = [
  { id: 'warn:prompt_injection', pattern: /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/i },
  { id: 'warn:prompt_injection', pattern: /system\s*prompt/i },
  { id: 'warn:prompt_injection', pattern: /이전\s*(?:지시|명령|지침).{0,12}(?:무시|잊)/ },
  { id: 'warn:prompt_injection', pattern: /(?:너|네)의?\s*(?:설정|프롬프트|규칙)\s*(?:을|를)?\s*(?:알려|보여|출력)/ },
];

export function moderateInput(text: string): ModerationResult {
  const blocked = matchedRuleIds(BLOCK_RULES, text);
  if (blocked.length > 0) return { level: 'block', reasons: blocked };

  const warned = matchedRuleIds(WARN_RULES, text);
  if (warned.length > 0) return { level: 'warn', reasons: warned };

  return { level: 'ok', reasons: [] };
}

/** 걸린 규칙의 id. 같은 id의 패턴이 여럿 걸려도 한 번만. */
function matchedRuleIds(rules: readonly Rule[], text: string): string[] {
  return [...new Set(rules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.id))];
}
