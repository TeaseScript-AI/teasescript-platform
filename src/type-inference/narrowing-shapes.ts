import type {
  BinaryExpression,
  BooleanLiteral,
  Expression,
  TypeTestExpression,
  UnaryExpression,
} from "../ast.js";
import { unwrap } from "../expression-children.js";

/**
 * The shape of a condition, as the branch rules read it (O4 stage 2c): what the top of the condition is after the
 * parentheses around it, and nothing below. The visitor's branch outcomes and the collector's `test` constraints both
 * read this one classification, so that the rule of which conditions narrow is written once. Every shape but `other`
 * keeps the node it was read from, so that a report or a note at the condition keeps its site.
 */
export type ConditionShape =
  | { readonly kind: "literal"; readonly node: BooleanLiteral }
  | { readonly kind: "not"; readonly node: UnaryExpression; readonly operand: Expression }
  | {
      readonly kind: "and" | "or";
      readonly node: BinaryExpression;
      readonly left: Expression;
      readonly right: Expression;
    }
  | {
      readonly kind: "null";
      readonly node: BinaryExpression;
      /** The expression compared with the `null` literal: the left operand when the right unwraps to null, else the right. */
      readonly tested: Expression;
      readonly negated: boolean;
    }
  | {
      readonly kind: "type";
      readonly node: TypeTestExpression;
      readonly tested: Expression;
      readonly negated: boolean;
    }
  | { readonly kind: "other" };

const OTHER: ConditionShape = { kind: "other" };

/**
 * Classifies a condition by its top: a boolean literal, `not`, `and`/`or`, a comparison with the `null` literal on
 * either side (`==` or `!=`), a type test (`is`, `is not`), or anything else. The parentheses around the condition are
 * read through; those around an operand are left to the consumer, which unwraps what it narrows. Whether the tested
 * expression narrows anything (a plain variable does, a property or element does not) is the consumer's rule.
 */
export function conditionShape(expression: Expression): ConditionShape {
  const node = unwrap(expression);
  switch (node.kind) {
    case "booleanLiteral":
      return { kind: "literal", node };
    case "unaryExpression":
      return node.operator === "not" ? { kind: "not", node, operand: node.operand } : OTHER;
    case "binaryExpression": {
      if (node.operator === "and" || node.operator === "or")
        return { kind: node.operator, node, left: node.left, right: node.right };
      if (node.operator !== "==" && node.operator !== "!=") return OTHER;
      // The right operand is inspected first: `null == null` tests its left operand, which narrows nothing.
      const tested =
        unwrap(node.right).kind === "nullLiteral"
          ? node.left
          : unwrap(node.left).kind === "nullLiteral"
            ? node.right
            : null;
      if (tested === null) return OTHER;
      return { kind: "null", node, tested, negated: node.operator === "!=" };
    }
    case "typeTestExpression":
      return { kind: "type", node, tested: node.value, negated: node.negated };
    default:
      return OTHER;
  }
}
