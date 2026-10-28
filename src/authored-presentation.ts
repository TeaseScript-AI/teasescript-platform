import { isMessagePresentationOption } from "./message-presentation.js";
import type { Expression, ObjectLiteral, Program, Statement } from "./ast.js";
import { isSeeThroughColor, normalizeColor } from "./color.js";
import { knownVisibleText, staticVisibleText, type KnownValue } from "./static-evaluation.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { parseMessageMarkup, rejectedColorTag } from "./message-markup.js";
import { messageText } from "./runtime/values/text-length.js";
import { quotedText } from "./runtime/values/value-text.js";

/** The speaker properties that are presentation options, which `presentationPropertyDiagnostics` checks. */
export const SPEAKER_PRESENTATION_PROPERTIES: ReadonlySet<string> = new Set([
  "presentation",
  "color",
  "bubble",
  "prose",
]);

/** The text a check reads from an expression whose value it knows, else `undefined`. */
type Shown = (expression: Expression) => string | undefined;

export function presentationPropertyDiagnostics(
  name: string,
  expression: Expression,
  shown: Shown = staticVisibleText,
): readonly Diagnostic[] {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  if ((name === "bubble" || name === "prose") && expression.kind === "objectLiteral") {
    return expression.properties.flatMap((property) =>
      isMessagePresentationOption(name, property.name.name)
        ? presentationPropertyDiagnostics(property.name.name, property.value, shown)
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
  const text = shown(expression);
  if (text === undefined || expression.kind === "nullLiteral") return [];
  let message: string | null = null;
  // The value is named, as the error may be on a variable whose value is written elsewhere.
  if ((name === "color" || name === "background") && normalizeColor(text) === null)
    message = isSeeThroughColor(text)
      ? `A message's ${name} must be opaque, not ${quotedText(messageText(text))}, which is see-through. Use an opaque colour, such as "#336699".`
      : `A message's ${name} must be a CSS colour, such as "#336699", not ${quotedText(messageText(text))}.`;
  if ((name === "position" || name === "align") && !["left", "center", "right"].includes(text))
    message = `A message's ${name} must be "left", "center", or "right".`;
  if ((name === "presentation" || name === "kind") && text !== "bubble" && text !== "prose")
    message = `A message's presentation must be "bubble" or "prose".`;
  return message === null
    ? []
    : [createDiagnostic(DiagnosticSeverity.Error, "TSC008", message, expression.span)];
}

export function messageColorDiagnostics(
  expression: Expression,
  shown: Shown = staticVisibleText,
): readonly Diagnostic[] {
  const text = shown(expression);
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
          markupColorMessage(text),
          expression.span,
        ),
      ];
  }
  return [];
}

/** The problem with a colour that the markup of `text` rejects, naming the tag as written. */
function markupColorMessage(text: string): string {
  const rejected = rejectedColorTag(text);
  if (rejected === null)
    return "A colour in the markup of the text is not an opaque CSS colour. Use an opaque colour, as in '[color=#336699]'.";
  const [written, example] = [`'${messageText(rejected.written)}'`, `'[${rejected.name}=#336699]'`];
  return isSeeThroughColor(rejected.color)
    ? `${written} names a see-through colour, but a colour in markup must be opaque. Use an opaque colour, as in ${example}.`
    : `${written} does not name a CSS colour. Use a CSS colour, as in ${example}.`;
}

/**
 * The problems above at every authored place of `program` whose value `known` gives, such as a colour held in a variable
 * or joined from texts (V30 §37): a speaker's presentation properties, the options of a message's or a question's mode,
 * and the text of a `say`, in source order.
 */
export function knownPresentationDiagnostics(
  program: Program,
  known: (expression: Expression) => KnownValue | undefined,
): readonly Diagnostic[] {
  // A known `null` leaves the option at its default, as a written one does.
  const shown = (expression: Expression) => {
    const value = known(expression);
    return value === null ? undefined : knownVisibleText(value);
  };
  const found: Diagnostic[] = [];
  const options = (presentation: ObjectLiteral | null | undefined) => {
    for (const property of presentation?.properties ?? [])
      found.push(...presentationPropertyDiagnostics(property.name.name, property.value, shown));
  };
  // Every node of the program, found with a list rather than by recursion, as source may nest deeply.
  const work: unknown[] = [program];
  while (work.length > 0) {
    const node = work.pop();
    if (typeof node !== "object" || node === null) continue;
    if (Array.isArray(node)) {
      for (const item of node) work.push(item);
      continue;
    }
    // Source spans hold no expressions.
    for (const [key, child] of Object.entries(node))
      if (key !== "span" && !key.endsWith("Span")) work.push(child);
    // EVIDENCE: invariant: the parser builds every statement and expression as an object with its `kind`.
    const command = node as Statement | Expression;
    switch (command.kind) {
      case "speakerDeclaration":
        for (const property of command.properties)
          if (SPEAKER_PRESENTATION_PROPERTIES.has(property.name.name))
            found.push(
              ...presentationPropertyDiagnostics(property.name.name, property.value, shown),
            );
        break;
      case "sayStatement":
      case "sayExpression":
        options(command.presentation);
        found.push(...messageColorDiagnostics(command.value, shown));
        break;
      case "interactionExpression":
      case "callExpression":
        options(command.presentation);
        break;
    }
  }
  return found.sort((left, right) => left.span.start.offset - right.span.start.offset);
}
