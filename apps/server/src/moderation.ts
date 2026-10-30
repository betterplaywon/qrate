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
  /** 어떤 규칙에 걸렸는지 — 어드민 콘솔과 이벤트 로그에 남긴다. */
  reasons: string[];
}

// 차단: 명백한 욕설·공격. (실서비스 전 확장 필요 — 지금은 대표 패턴만)
const BLOCK_PATTERNS: readonly RegExp[] = [
  /씨발|시발|병신|개새끼/,
  /\bfuck(?:ing|er)?\b/i,
];

// 경고: 프롬프트 인젝션 의심. 응답은 계속하되 플래그를 남기고 콘솔에서 확인한다.
const WARN_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/i,
  /system\s*prompt/i,
  /이전\s*(?:지시|명령|지침).{0,12}(?:무시|잊)/,
  /(?:너|네)의?\s*(?:설정|프롬프트|규칙)\s*(?:을|를)?\s*(?:알려|보여|출력)/,
];

export function moderateInput(text: string): ModerationResult {
  const blockReasons = BLOCK_PATTERNS.filter((p) => p.test(text)).map(
    (p) => `block:${p.source.slice(0, 24)}`,
  );
  if (blockReasons.length > 0) {
    return { level: 'block', reasons: blockReasons };
  }

  const warnReasons = WARN_PATTERNS.filter((p) => p.test(text)).map(
    (p) => `warn:${p.source.slice(0, 24)}`,
  );
  if (warnReasons.length > 0) {
    return { level: 'warn', reasons: warnReasons };
  }

  return { level: 'ok', reasons: [] };
}
