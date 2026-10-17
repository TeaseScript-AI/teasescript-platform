/**
 * The rules of what a `repeat` counts and what a `for` loop goes through, each with one message: compile error `TSV011`
 * or `TSV012` where the compiler knows the problem, and otherwise runtime error `TSR043` or `TSR044`. A message names
 * the value as `subject`, such as `this` or `'n'`, and takes it as the runtime shows it (`shown`), or its type where
 * the compiler knows only that.
 */

/** Whether `repeat` can count `value` times. */
export function isRepeatCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** `fix` starts with a space. */
export function repeatCountMessage(subject: string, shown: string, fix: string): string {
  return `A repeat count must be a whole number (integer) of at least 0, but ${subject} is ${shown}.${fix}`;
}

/** The fix for a number that `repeat` cannot count. */
export function repeatCountFix(value: number): string {
  return !Number.isInteger(value)
    ? " Round it with floor(...), round(...), or ceil(...) first."
    : value < 0
      ? " Check that it is at least 0 first."
      : " Use a smaller count.";
}

/** What a `for` loop with one variable goes through. */
export const FOR_SOURCE_RULE = "A 'for' loop goes through a list, set, dict, or range";

/** What a `for` loop with a key and a value variable goes through. */
export function pairLoopRule(variable: string, valueVariable: string): string {
  return `'for ${variable}, ${valueVariable}' goes through the keys and values of a dict`;
}
