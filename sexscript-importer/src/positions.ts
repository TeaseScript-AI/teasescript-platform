import type { HelperName } from "./helpers.ts";
import type { IrExpression, IrStatement } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/** The TeaseScript methods that give the position of a part or an element, or null where there is none (#840). */
const POSITIONS = new Set(["indexOf", "lastIndexOf"]);
const COMPARISONS = new Set(["==", "!=", "<", "<=", ">", ">="]);
/** The name of the helper that reads -1 for a missing position (helpers.ts `position`). */
export const POSITION_HELPER = "sexscriptLegacyPosition";

/**
 * Groovy indexOf() and lastIndexOf() gave -1 where nothing was found; TeaseScript's give null (#840). A comparison of
 * a position with a whole number becomes the null test it amounts to: `== -1` and `< 0` test for null, `!= -1`,
 * `>= 0`, and `> -1` for a position, and `== k` and `!= k` for k from 0 compare as they are. Any other use of a
 * position, another ordering too (`p > 0`), reads -1 for null (sexscriptLegacyPosition), the number Groovy gave.
 * `used` collects the helper where a statement needs it.
 */
export function withPositions(statements: IrStatement[], used: Set<HelperName>): IrStatement[] {
  const rewrite = (value: IrExpression): IrExpression => {
    const compared = comparison(value, rewrite);
    if (compared !== null) return compared;
    const next = mapChildren(value, rewrite);
    if (!isPosition(next)) return next;
    used.add("position");
    return { kind: "call", name: POSITION_HELPER, positional: [next], named: {} };
  };
  const block = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => mapOwnExpressions(withNestedBlocks(item, block), rewrite));
  return block(statements);
}

/** Whether an expression is a position read: `text.indexOf(part)`, `items.lastIndexOf(value)`. */
function isPosition(value: IrExpression): value is Extract<IrExpression, { kind: "methodCall" }> {
  return (
    value.kind === "methodCall" &&
    value.dict !== true &&
    POSITIONS.has(value.name) &&
    value.arguments.length === 1
  );
}

/** The whole number a constant is, `3` or `-1`; null for another value. */
function wholeNumber(value: IrExpression): number | null {
  if (value.kind === "literal")
    return typeof value.value === "number" && Number.isInteger(value.value) ? value.value : null;
  if (value.kind === "unary" && value.operator === "-") {
    const inner = wholeNumber(value.value);
    return inner === null ? null : -inner;
  }
  return null;
}

const FLIPPED: Record<string, string> = {
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
  "==": "==",
  "!=": "!=",
};

/**
 * A comparison of a position with a whole number, as the test Groovy's -1 made of it; null for another expression.
 * Groovy's result is that of `-1 op k` for a missing position, and of `p op k` for a found one, which is never
 * negative.
 */
function comparison(
  value: IrExpression,
  rewrite: (value: IrExpression) => IrExpression,
): IrExpression | null {
  if (value.kind !== "binary" || !COMPARISONS.has(value.operator)) return null;
  const leftNumber = wholeNumber(value.left);
  const rightNumber = wholeNumber(value.right);
  const [side, bound, operator] =
    rightNumber !== null && isPosition(value.left)
      ? [value.left, rightNumber, value.operator]
      : leftNumber !== null && isPosition(value.right)
        ? [value.right, leftNumber, FLIPPED[value.operator]!]
        : [null, 0, ""];
  if (side === null) return null;
  const position = mapChildren(side, rewrite);
  const test = (left: number, right: number): boolean => {
    switch (operator) {
      case "==":
        return left === right;
      case "!=":
        return left !== right;
      case "<":
        return left < right;
      case "<=":
        return left <= right;
      case ">":
        return left > right;
      default:
        return left >= right;
    }
  };
  const missing = test(-1, bound);
  // Whether a found position, from 0 up, always or never passes.
  const always =
    operator === "!=" ? bound < 0 : test(0, bound) && test(Number.MAX_SAFE_INTEGER, bound);
  const never =
    operator === "==" ? bound < 0 : !test(0, bound) && !test(Number.MAX_SAFE_INTEGER, bound);
  const isNull = (equal: boolean): IrExpression => ({
    kind: "binary",
    operator: equal ? "==" : "!=",
    left: position,
    right: { kind: "literal", value: null },
  });
  if (always) return missing ? { kind: "literal", value: true } : isNull(false);
  if (never) return missing ? isNull(true) : { kind: "literal", value: false };
  const compare: IrExpression = {
    kind: "binary",
    operator,
    left: position,
    right: { kind: "literal", value: bound },
  };
  // `== k` and `!= k` from 0 compare a missing position's null as Groovy compared its -1; another ordering reads the
  // -1 (the compiler narrows a variable, not a repeated call, so `p != null and p > 0` would not do).
  return operator === "==" || operator === "!=" ? compare : null;
}
