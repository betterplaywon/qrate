/**
 * v가 values 중 하나인지. 값 목록은 `as const` 배열 하나로 두고 타입은 거기서 뽑는다(`(typeof LIST)[number]`).
 * 타입과 배열을 따로 적으면 타입에만 값을 더해도 컴파일되고, 수신 쪽은 새 값을 모르는 값으로 읽는다.
 */
export function isOneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  const known: readonly string[] = values;
  return typeof v === 'string' && known.includes(v);
}
