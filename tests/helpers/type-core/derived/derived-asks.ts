import type { Expression, InteractionExpression } from "../../../../src/ast.js";
import { askParts } from "../../../../src/expression-children.js";
import { isBlankTextAnswer } from "../../../../src/interaction-answers.js";
import { RuntimeFault } from "../../../../src/runtime/errors.js";
import type { SerializableRuntimeValue } from "../../../../src/runtime/values/serializable-values.js";
import { expandChoiceOptions } from "../../../../src/runtime/actions/choice-options.js";
import { fieldText } from "../../../../src/runtime/values/value-text.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../../../src/temporal.js";

/*
 * The derived oracle's asks (#2488's step 1d): an ask's run by the rules, up to the request it opens. Its parts are
 * evaluated in their order (`askParts`; V30 §20: the question, `hint:` and `prefill:` as written, before the question is
 * said), the question is said, and the request is checked as it opens: a text it shows (the question, a hint, a button's
 * text) must show as a field's text, else TSR021 (a basic ask's question at the question, as it is said; any other at
 * the ask); a prefill must be an answer its field takes, or `null` or blank text for none (V30 §20), else TSR052 at the
 * ask; an `askChoice`'s buttons are as the runtime makes them (V30 §19), else TSR052 at the ask. Then the run waits
 * for the answer, which the oracle does not give. Like `evaluate`, it reads the source, never the plan; a shown text's
 * rule and a choice's buttons are the runtime's own functions (`fieldText`, `expandChoiceOptions`).
 */

/**
 * What an ask's run does up to its request: the question it has said, if any, and then a failure with its code and
 * site, or a wait.
 */
export type AskEnd = {
  readonly said: string | null;
  readonly failure?: { readonly code: string; readonly start: number; readonly end: number };
};

/** A value as `evaluate` reads it; a read that fails ends the run itself. */
type Read = (expression: Expression) => SerializableRuntimeValue;

/** The field text of a value, or the code it fails with (`fieldText`, the runtime's one rule for a shown text). */
function textOf(
  value: SerializableRuntimeValue,
  ask: InteractionExpression,
): { readonly text: string } | { readonly code: string } {
  try {
    return { text: fieldText(value, ask.span, DEFAULT_TEMPORAL_CONTEXT) };
  } catch (error) {
    if (error instanceof RuntimeFault) return { code: error.code };
    throw error;
  }
}

/** Whether a prefill is one the field takes as an answer, or none (`null`, blank text). */
function prefillFits(
  kind: InteractionExpression["interactionKind"],
  value: SerializableRuntimeValue,
): boolean {
  if (value === null || (typeof value === "string" && isBlankTextAnswer(value))) return true;
  switch (kind) {
    case "text":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
    case "time":
    case "datetime":
      return typeof value === "object" && value.kind === kind;
    default:
      return true;
  }
}

/** An ask's run up to its request (see the module's comment). */
export function askEnd(ask: InteractionExpression, read: Read): AskEnd {
  const named = new Map(ask.formArguments.map((argument) => [argument.name.name, argument.value]));
  const question = ask.question ?? named.get("message") ?? null;
  // (a basic ask prepares its question as it is evaluated, before its other operands; any other reads it from its
  // request, after all of them)
  const basic = ask.interactionKind !== "boolean";
  const values = new Map<Expression, SerializableRuntimeValue>();
  let said: string | null = null;
  // (a failure after the question is said keeps it said)
  const at = (code: string, span = ask.span): AskEnd => ({
    said,
    failure: { code, start: span.start.offset, end: span.end.offset },
  });
  const sayQuestion = (): AskEnd | null => {
    if (question === null) return null;
    const text = textOf(values.get(question)!, ask);
    if ("code" in text) return at(text.code, basic ? question.span : ask.span);
    said = text.text;
    return null;
  };
  for (const part of askParts(ask)) {
    values.set(part, read(part));
    if (basic && part === question) {
      const failed = sayQuestion();
      if (failed !== null) return failed;
    }
  }
  if (!basic) {
    const failed = sayQuestion();
    if (failed !== null) return failed;
  }
  for (const shown of [ask.hint, named.get("yesText"), named.get("noText")])
    if (shown !== null && shown !== undefined) {
      const text = textOf(values.get(shown)!, ask);
      if ("code" in text) return at(text.code);
    }
  const prefill = ask.prefill ?? named.get("prefill") ?? null;
  if (ask.interactionKind === "choice") {
    // (its buttons as the runtime makes them, `expandChoiceOptions`: a label written before `:` is each one's value)
    try {
      expandChoiceOptions(
        ask.options.map((option) => values.get(option.expression)!),
        ask.options.map((option) =>
          option.value === null
            ? null
            : option.value.kind === "identifier"
              ? option.value.name
              : option.value.value,
        ),
        DEFAULT_TEMPORAL_CONTEXT,
        ask.span,
      );
    } catch (error) {
      if (error instanceof RuntimeFault) return at(error.code);
      throw error;
    }
    return { said };
  }
  if (prefill !== null && !prefillFits(ask.interactionKind, values.get(prefill)!))
    return at("TSR052");
  return { said };
}
