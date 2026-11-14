// The syntax evidence of an ask, built from the source alone.

import type { Expression, InteractionExpression } from "../ast.js";
import { unwrap } from "../expression-children.js";
import type {
  PlaceId,
  SyntaxEvidence,
  ChoiceElementEvidence,
  ChoiceObjectEvidence,
  ChoiceOptionEvidence,
} from "./graph.js";

/**
 * What the source says about an ask beyond its operands' types. `placeOf` gives the value place of a node the walk
 * visited, and throws for any other: call this after the ask's operands are walked.
 */
export function interactionEvidence(
  expression: InteractionExpression,
  placeOf: (node: Expression) => PlaceId,
): SyntaxEvidence | undefined {
  if (expression.interactionKind !== "choice") return undefined;
  const property = (
    literal: Extract<Expression, { kind: "objectLiteral" }>,
    key: string,
  ): Expression | undefined =>
    literal.properties.find((candidate) => candidate.name.name === key)?.value;
  /** A written choice object's `value` and `text` places. */
  const choiceObject = (
    literal: Extract<Expression, { kind: "objectLiteral" }>,
  ): ChoiceObjectEvidence => {
    const value = property(literal, "value");
    const text = property(literal, "text");
    return {
      value: value === undefined ? null : placeOf(value),
      text: text === undefined ? null : placeOf(text),
    };
  };
  const element = (node: Expression): ChoiceElementEvidence => {
    const content = unwrap(node);
    return {
      place: placeOf(node),
      object: content.kind === "objectLiteral" ? choiceObject(content) : null,
    };
  };
  return {
    kind: "choice",
    options: expression.options.map((option): ChoiceOptionEvidence => {
      const content = unwrap(option.expression);
      return {
        label:
          option.value === null
            ? null
            : option.value.kind === "identifier"
              ? "string"
              : option.value.numericType === "integer"
                ? "integer"
                : "number",
        content:
          content.kind === "listLiteral" || content.kind === "setLiteral"
            ? {
                kind: content.kind === "listLiteral" ? "list" : "set",
                elements: content.elements.map(element),
              }
            : content.kind === "objectLiteral"
              ? { kind: "object", object: choiceObject(content) }
              : { kind: "other" },
      };
    }),
  };
}
