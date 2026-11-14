// The syntax evidence of an ask and of a list function's or `randomWeighted`'s selectors (`SyntaxEvidence` in
// `graph.ts`), built from the source alone.

import type { CallExpression, Expression, InteractionExpression } from "../ast.js";
import { namedAskArguments, staticText, unwrap } from "../expression-children.js";
import { staticChoiceValue, staticVisibleText } from "../static-evaluation.js";
import type {
  PlaceId,
  SyntaxEvidence,
  ChoiceElementEvidence,
  ChoiceObjectEvidence,
  ChoiceOptionEvidence,
  FormDescriptorEvidence,
  WrittenLiteral,
} from "./graph.js";

/** The selectors of a list function or of `randomWeighted`, as text where they are written as text (see `SyntaxEvidence`). */
export function selectorsEvidence(expression: CallExpression): SyntaxEvidence {
  const written: { readonly name: string; readonly text: string | null }[] = [];
  for (const argument of expression.arguments)
    if (argument.kind === "namedArgument" && SELECTORS.has(argument.name.name))
      written.push({ name: argument.name.name, text: staticVisibleText(argument.value) ?? null });
  return { kind: "selectors", written };
}

const SELECTORS: ReadonlySet<string> = new Set(["by", "x", "y", "weight"]);

/**
 * What the source says about an ask beyond its operands' types (see `SyntaxEvidence`). `placeOf` gives the value place
 * of a node the walk visited, and throws for any other: call this after the ask's operands are walked.
 */
export function interactionEvidence(
  expression: InteractionExpression,
  placeOf: (node: Expression) => PlaceId,
): SyntaxEvidence | undefined {
  const argument = (name: string): Expression | undefined =>
    namedAskArguments(expression).find((candidate) => candidate.name === name)?.value;
  const literal = (node: Expression): WrittenLiteral => {
    const known = staticChoiceValue(node);
    return known === undefined ? null : { value: known.value };
  };
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
  /** The written literal a button returns: the element's, or a written object's `value`, else its `text`. */
  const buttonLiteral = (node: Expression): WrittenLiteral => {
    const content = unwrap(node);
    if (content.kind !== "objectLiteral") return literal(content);
    const returned = property(content, "value") ?? property(content, "text");
    return returned === undefined ? null : literal(returned);
  };
  const element = (node: Expression): ChoiceElementEvidence => {
    const content = unwrap(node);
    return {
      place: placeOf(node),
      literal: buttonLiteral(node),
      object: content.kind === "objectLiteral" ? choiceObject(content) : null,
    };
  };
  const elements = (node: Expression): readonly ChoiceElementEvidence[] | null => {
    const content = unwrap(node);
    return content.kind === "listLiteral" || content.kind === "setLiteral"
      ? content.elements.map(element)
      : null;
  };
  switch (expression.interactionKind) {
    case "form": {
      const fields = argument("fields");
      const container = fields === undefined ? undefined : unwrap(fields);
      const written =
        container?.kind === "objectLiteral"
          ? {
              shape: "object" as const,
              entries: container.properties.map((entry) => ({
                name: entry.name.name,
                value: entry.value,
              })),
            }
          : container?.kind === "dictLiteral"
            ? {
                shape: "dict" as const,
                entries: container.entries.map((entry) => ({
                  name: staticText(entry.key) ?? "?",
                  value: entry.value,
                })),
              }
            : undefined;
      const descriptor = (node: Expression): FormDescriptorEvidence => {
        const content = unwrap(node);
        if (content.kind === "nullLiteral") return { kind: "null" };
        if (content.kind === "listLiteral")
          return { kind: "list", elements: content.elements.map(element) };
        if (content.kind !== "objectLiteral") return { kind: "other" };
        const type = property(content, "type");
        const optional = property(content, "optional");
        const optionalLiteral = optional === undefined ? undefined : unwrap(optional);
        const place = (key: string): PlaceId | null => {
          const found = property(content, key);
          return found === undefined ? null : placeOf(found);
        };
        const options = property(content, "options");
        return {
          kind: "object",
          type: type === undefined ? null : (staticText(type) ?? "computed"),
          optional:
            optional === undefined
              ? null
              : optionalLiteral?.kind === "booleanLiteral"
                ? optionalLiteral.value
                : "computed",
          value: place("value"),
          min: place("min"),
          max: place("max"),
          options:
            options === undefined ? null : { place: placeOf(options), elements: elements(options) },
        };
      };
      const onTimeout = argument("onTimeout");
      return {
        kind: "form",
        fields:
          written === undefined
            ? "computed"
            : {
                shape: written.shape,
                entries: written.entries.map(({ name, value }) => ({
                  name,
                  place: placeOf(value),
                  written: descriptor(value),
                })),
              },
        cancel: argument("cancel") !== undefined,
        timeout: argument("timeout") !== undefined,
        onTimeout: onTimeout === undefined ? null : (staticText(onTimeout) ?? "computed"),
      };
    }
    case "choice":
      return {
        kind: "choice",
        options: expression.options.map((option): ChoiceOptionEvidence => {
          const content = unwrap(option.expression);
          return {
            label:
              option.value === null
                ? null
                : option.value.kind === "identifier"
                  ? { kind: "string", value: option.value.name }
                  : {
                      kind: option.value.numericType === "integer" ? "integer" : "number",
                      value: option.value.value,
                    },
            place: placeOf(option.expression),
            literal: buttonLiteral(option.expression),
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
    case "booleans":
      return { kind: "booleans", cancel: argument("cancel") !== undefined };
    default:
      return undefined;
  }
}
