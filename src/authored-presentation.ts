import { isMessagePresentationOption } from "./message-presentation.js";
import type { Expression } from "./ast.js";
import { normalizeColor } from "./color.js";
import { staticVisibleText } from "./static-evaluation.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { parseMessageMarkup } from "./message-markup.js";

export function presentationPropertyDiagnostics(
  name: string,
  expression: Expression,
): readonly Diagnostic[] {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  if ((name === "bubble" || name === "prose") && expression.kind === "objectLiteral") {
    return expression.properties.flatMap((property) =>
      isMessagePresentationOption(name, property.name.name)
        ? presentationPropertyDiagnostics(property.name.name, property.value)
        : [
            createDiagnostic(
              DiagnosticSeverity.Error,
              "TSC008",
              `Unknown ${name} presentation option '${property.name.name}'.`,
              property.name.span,
            ),
          ],
    );
  }
  const text = staticVisibleText(expression);
  if (text === undefined || expression.kind === "nullLiteral") return [];
  let message: string | null = null;
  if ((name === "color" || name === "background") && normalizeColor(text) === null)
    message = "Invalid authored colour.";
  if ((name === "position" || name === "align") && !["left", "center", "right"].includes(text))
    message = `Invalid ${name}; expected left, center or right.`;
  if ((name === "presentation" || name === "kind") && text !== "bubble" && text !== "prose")
    message = "Invalid presentation; expected bubble or prose.";
  return message === null
    ? []
    : [createDiagnostic(DiagnosticSeverity.Error, "TSC008", message, expression.span)];
}

export function messageColorDiagnostics(expression: Expression): readonly Diagnostic[] {
  const text = staticVisibleText(expression);
  if (text === undefined) return [];
  const content = parseMessageMarkup(text);
  for (const block of content.blocks) {
    const lines =
      block.kind === "heading"
        ? [block.line]
        : block.kind === "list"
          ? block.items.map((item) => item.line)
          : block.lines;
    if (
      lines.some((line) =>
        line.spans.some(
          (span) =>
            (span.kind === "color" || span.kind === "backgroundColor") && span.value === "inherit",
        ),
      )
    )
      return [
        createDiagnostic(
          DiagnosticSeverity.Error,
          "TSC008",
          "Invalid authored markup colour.",
          expression.span,
        ),
      ];
  }
  return [];
}
