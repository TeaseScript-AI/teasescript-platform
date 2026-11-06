// Shape checks of op arguments, which the host runs before an op: plain records with exactly their keys, and arrays
// read by index. The engine still validates the host data inside them, as it always does.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` has every key of `required` and no key besides those and `optional`. */
export const exactly = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

/**
 * Whether `value` is a plain array of elements that pass `test`, read by index: a cloned array keeps its own
 * properties, such as an `every` or `map` of its own, so one with keys besides its indices is malformed, as is a hole.
 */
export function everyItem(value: unknown, test: (item: unknown) => boolean): boolean {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) return false;
  for (let index = 0; index < value.length; index += 1)
    if (!Object.hasOwn(value, index) || !test(value[index])) return false;
  return true;
}

export const isStringArray = (value: unknown): boolean =>
  everyItem(value, (item) => typeof item === "string");

/** A finite number of milliseconds that is not negative. */
export const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
