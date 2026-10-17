/**
 * Rules of operator operands that the type checker and the runtime both check, each with one text. A message is the
 * rule, then "but this is" and what the operand is (the value at runtime, or its type at compile time), then the fix.
 */

/**
 * `and` and `or` take true or false (runtime error `TSR026`). `null` is for a lowered operand whose operator the plan
 * does not show, which only a plan that the compiler did not make has.
 */
export function logicalOperandRule(operator: "and" | "or" | null): string {
  return operator === null
    ? "'and' and 'or' need true or false (boolean) values"
    : `'${operator}' needs true or false (boolean) values`;
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
