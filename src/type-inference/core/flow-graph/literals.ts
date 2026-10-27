import type { Expression } from "../../../ast.js";
import { compileChild, runCompileTask, type CompileTask } from "../../../compiler/continuation.js";
import { isEmptyLiteral, isNonEmptyLiteral, staticNumber } from "../../../static-evaluation.js";
import { conditionShape } from "../../narrowing-shapes.js";

// P7: what literals decide: a condition's value, a non-null operand, a count or index, and how often a body runs.

export const NON_NULL_LITERALS: ReadonlySet<Expression["kind"]> = new Set([
  "numberLiteral",
  "stringLiteral",
  "booleanLiteral",
  "regexLiteral",
  "listLiteral",
  "objectLiteral",
  "setLiteral",
  "dictLiteral",
  "durationLiteral",
]);

/**
 * P7: the value a condition always has by its literals, as the type check reads conditions (`conditionShape`): a
 * boolean literal, `not` of one, or `and` and `or` that their literal operands decide; `null` when a run decides it.
 */
export function literalTruth(
  expression: Expression,
  known: Map<Expression, boolean | null> = new Map(),
): boolean | null {
  return runCompileTask(literalTruthTask(expression, known));
}

/** The fold of {@link literalTruth}, each expression once: an `and` chain's operands are asked again by each prefix. */
function* literalTruthTask(
  expression: Expression,
  known: Map<Expression, boolean | null>,
): CompileTask<boolean | null> {
  const found = known.get(expression);
  if (found !== undefined) return found;
  const shape = conditionShape(expression);
  let value: boolean | null = null;
  switch (shape.kind) {
    case "literal":
      value = shape.node.value;
      break;
    case "not": {
      const operand = yield* compileChild(literalTruthTask(shape.operand, known));
      value = operand === null ? null : !operand;
      break;
    }
    case "and":
    case "or": {
      // `false` decides an `and` and `true` an `or`, whichever operand has it.
      const decides = shape.kind === "or";
      const left = yield* compileChild(literalTruthTask(shape.left, known));
      const right = yield* compileChild(literalTruthTask(shape.right, known));
      value =
        left === decides || right === decides
          ? decides
          : left === null || right === null
            ? null
            : !decides;
      break;
    }
    case "null":
    case "type":
    case "other":
      break;
  }
  known.set(expression, value);
  return value;
}

/** P7: a `repeat` count or a list index that its literals give, as the type check folds a count, or `null`. */
export function literalCount(expression: Expression): number | null {
  return staticNumber(expression) ?? null;
}

/** P7: how often a body runs by its literals: never, exactly once, at least once, or `null` when a run decides. */
export type LiteralRounds = "none" | "one" | "some" | null;

/** P7: the rounds of a `repeat` whose count its literals give. */
export function literalRounds(count: Expression): LiteralRounds {
  const value = literalCount(count);
  if (value === null) return null;
  return value <= 0 ? "none" : value === 1 ? "one" : value > 1 ? "some" : null;
}

/** P7: the rounds of a `for` over a literal collection or a range of constant numbers, as the type check reads it. */
export function literalCollectionRounds(iterable: Expression): LiteralRounds {
  return isEmptyLiteral(iterable) ? "none" : isNonEmptyLiteral(iterable) ? "some" : null;
}
