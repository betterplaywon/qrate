import { VARIANT_ID_PATTERN } from '@qrate/contracts';

// 인사말 실험의 유일한 정의와 배정. 변형 목록·문구·비율은 여기 한 곳에만 있고, 대화창(GET /api/greeting)·사건 검증(/api/events)·
// 콘솔 지표(라벨·문구·행 목록)가 모두 이 값에서 나온다. Express를 모르고, 무작위는 인자로 받는다.

declare const variantIdBrand: unique symbol;
/** 실험 정의만 만드는 변형 id. 사건 로그의 variant 열에 쓸 수 있는 값은 이 타입뿐이다(요청 본문의 문자열을 그대로 쓰지 못하게). */
export type GreetingVariantId = string & { readonly [variantIdBrand]: true };

declare const experimentBrand: unique symbol;

export interface GreetingVariant {
  /** `${실험 id}.${key}`. 실험 id를 품고 있어 실험을 바꾸면 보존된 값과 옛 사건 행이 저절로 지금 정의에서 빠진다. */
  readonly id: GreetingVariantId;
  readonly key: string;
  readonly label: string;
  readonly text: string;
  /** 새 방문자에게 배정할 상대 비율(0 이상 정수). 0이면 새 배정만 멈추고, 이미 이 변형을 가진 방문자는 그대로 본다. */
  readonly weight: number;
}

/** defineGreetingExperiment만 만든다 — 검사를 거치지 않은 실험은 createApp에 넣을 수 없다. */
export interface GreetingExperiment {
  readonly [experimentBrand]: true;
  readonly id: string;
  readonly variants: readonly GreetingVariant[];
}

export interface GreetingExperimentInput {
  id: string;
  variants: readonly Omit<GreetingVariant, 'id'>[];
}

/** 정의를 검사해 실험으로 만든다. 틀리면 던진다 — 모듈을 읽을 때, 곧 서버가 시작할 때 실패한다. */
export function defineGreetingExperiment(input: GreetingExperimentInput): GreetingExperiment {
  const fail = (problem: string): never => {
    throw new Error(`인사말 실험 "${input.id}": ${problem}`);
  };
  if (input.variants.length === 0) fail('변형이 없다');
  // "."을 실험 id·키에 허용하지 않아야 변형 id가 (실험, 키)를 하나로 가리킨다 — 다른 실험의 변형 id와 겹치지 않는다.
  if (input.id.includes('.')) fail('실험 id에 "."을 쓸 수 없다');
  const keys = new Set<string>();
  const variants = input.variants.map((v): GreetingVariant => {
    const id = `${input.id}.${v.key}`;
    if (!v.key || v.key.includes('.')) fail(`키 "${v.key}"는 비어 있지 않고 "."이 없어야 한다`);
    if (!VARIANT_ID_PATTERN.test(id)) fail(`변형 id "${id}"가 런처가 받는 형식(VARIANT_ID_PATTERN)이 아니다`);
    if (keys.has(v.key)) fail(`키 "${v.key}"가 겹친다`);
    keys.add(v.key);
    if (!Number.isInteger(v.weight) || v.weight < 0) fail(`변형 "${v.key}"의 가중치 ${v.weight}는 0 이상 정수가 아니다`);
    if (!v.label.trim() || !v.text.trim()) fail(`변형 "${v.key}"의 label·text가 비어 있다`);
    return { ...v, id: id as GreetingVariantId };
  });
  if (variants.every((v) => v.weight === 0)) fail('가중치가 모두 0이라 새 방문자에게 줄 변형이 없다');
  return { id: input.id, variants } as unknown as GreetingExperiment;
}

/**
 * 지금 실험. 끄려면 null. 비율을 바꾸면 새 방문자만 따르므로 실험 중에는 비율보다 id를 바꾼 새 실험이 낫다(보존된 값이 모두 무효가 되어
 * 다시 배정된다). 문구는 자리 표시다. 모든 테넌트에 같은 문구라 테넌트 이름·자료 주제를 넣지 않는다.
 */
export const GREETING_EXPERIMENT: GreetingExperiment | null = defineGreetingExperiment({
  id: 'greet-2026-11',
  variants: [
    { key: 'a', label: 'A · 기본', weight: 1, text: '안녕하세요. 궁금한 점을 편하게 물어보세요.' },
    {
      key: 'b',
      label: 'B · 자료 안내',
      weight: 1,
      text: '안녕하세요. 궁금한 걸 한 문장으로 적어 주시면 등록된 자료에서 찾아 출처와 함께 답해 드릴게요.',
    },
  ],
});

/** raw가 이 실험의 변형 id면 그 변형(가중치와 무관), 아니면 null. 사건 검증과 배정이 같은 판정을 쓴다. */
export function findVariant(experiment: GreetingExperiment, raw: string | null): GreetingVariant | null {
  return experiment.variants.find((v) => v.id === raw) ?? null;
}

/**
 * 배정. requested가 이 실험의 변형이면 그대로(가중치 0인 변형도 — 보존), 아니면 가중치 > 0인 변형 중 하나를 random([0, 1))으로 고른다.
 * 같은 requested로 몇 번을 불러도 같은 답이다.
 */
export function assignGreeting(experiment: GreetingExperiment, requested: string | null, random: () => number): GreetingVariant {
  const kept = findVariant(experiment, requested);
  if (kept) return kept;
  const candidates = experiment.variants.filter((v) => v.weight > 0);
  let target = random() * candidates.reduce((sum, v) => sum + v.weight, 0);
  for (const v of candidates) {
    if (target < v.weight) return v;
    target -= v.weight;
  }
  // 닿지 않는 줄이다. 정의 검사가 가중치 > 0인 변형을 하나 이상 보장하고 가중치가 정수라 random() < 1이면 루프 안에서 돌려준다. 타입만 그것을 모른다.
  return candidates[candidates.length - 1] as GreetingVariant;
}
