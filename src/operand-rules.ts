/**
 * Rules of operator operands that the type checker and the runtime both check, each with one text. A message is the
 * rule, then "but this is" and what the operand is (the value at runtime, or its type at compile time), then the fix.
 */

import { isTemporalKind } from "./temporal-builtins.js";
import { ORDERED_FAMILIES, VALUE_KINDS } from "./value-kinds.js";

/**
 * `and` and `or` take true or false (runtime error `TSR026`). `null` is for a lowered operand whose operator the plan
 * does not show, which only a plan that the compiler did not make has.
 */
export function logicalOperandRule(operator: "and" | "or" | null): string {
  return operator === null
    ? "'and' and 'or' need true or false (boolean) values"
    : `'${operator}' needs true or false (boolean) values`;
}

/** A list's index is a whole number (compile errors `TSV043`, runtime error `TSR024`). */
export const LIST_INDEX_RULE = "A list index must be a whole number (integer)";

/**
 * A list index `value` below 0, which no element has (`TSV045`), with the index and the list as written where they are
 * names, such as `i` and `items`.
 */
export function negativeListIndexMessage(
  value: number,
  index: string | null,
  list: string | null,
): string {
  const subject = index === null || index === String(value) ? "the index" : `'${index}'`;
  return `A list index cannot be negative, but ${subject} is ${value}. The first element is at index 0, and the last at ${list === null ? "length - 1" : `'${list}.length - 1'`}.`;
}

/**
 * The amount before a duration or an angle unit is a number (runtime error `TSR027`): in a `wait` or a timer, which also
 * take a range there, as in any other place.
 */
export const UNIT_AMOUNT_RULE = "A unit follows a number";

/** The fix for an amount before `unit` that is not a number, from a space: a value of that unit already has it. */
export function unitAmountFix(unit: string, hasUnit: boolean): string {
  return hasUnit ? ` Remove the '${unit}' after it.` : ` Use a number before the '${unit}'.`;
}

/**
 * The fix for an operand that is not a number, which the source spells `label` where it can: a null check, a
 * conversion of numeric text, or another value.
 */
export function notNumberFix(
  label: string | null,
  value: "null" | "numeric text" | "other",
): string {
  return value === "null"
    ? `Check that ${label === null ? "the value" : `'${label}'`} is not null before using it.`
    : value === "numeric text"
      ? "Convert the text with toNumber(...) first."
      : "Use a number instead.";
}

/**
 * `<`, `<=`, `>`, and `>=` order two values of one ordered family (runtime error `TSR009`), named here but for the date
 * and time values, which order within one kind and have a message of their own.
 */
export function orderRule(operator: string): string {
  const pairs = ORDERED_FAMILIES.filter((kind) => !isTemporalKind(kind)).map(
    (kind) => `two ${VALUE_KINDS[kind].plural}`,
  );
  return `'${operator}' compares ${pairs.slice(0, -1).join(", ")}, or ${pairs.at(-1)!}`;
}
