import { normalizeOpaqueColor } from "../color.js";
import { MAX_INTERACTION_OPTION_ENTRIES } from "../interaction-limits.js";
import type {
  InteractionChoiceOption,
  InteractionChoiceValue,
  PlanSourceLocation,
  PreparedInteractionChoiceValue,
} from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import type { TemporalContext } from "../temporal.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import { getSerializableProperty, type SerializableRuntimeValue } from "./serializable-values.js";
import { isDuration, isList, isObject, isSet, isTemporal } from "./value-predicates.js";
import { fieldText, isVisibleScalar, visibleText } from "./value-text.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/**
 * The buttons of a prepared `choose`, in order: one for each value or choice object, and one for each element of a
 * list option or member of a set option, in insertion order. `options` holds what each authored option evaluated to,
 * and `values` the value written before its `:` (or `null`); every button of a list or set option returns that written
 * value.
 */
export function expandChoiceOptions(
  options: readonly SerializableRuntimeValue[],
  values: readonly (PreparedInteractionChoiceValue | null)[],
  context: TemporalContext,
  span: SourceSpan,
): readonly InteractionChoiceOption[] {
  const buttons: InteractionChoiceOption[] = [];
  const add = (option: SerializableRuntimeValue, value: PreparedInteractionChoiceValue | null) => {
    if (buttons.length === MAX_INTERACTION_OPTION_ENTRIES)
      throw fault(
        "TSR052",
        `A choice can show at most ${MAX_INTERACTION_OPTION_ENTRIES} buttons.`,
        span,
      );
    buttons.push(choiceButton(option, value, context, span));
  };
  options.forEach((option, index) => {
    const value = values[index] ?? null;
    if (!isList(option) && !isSet(option)) {
      add(option, value);
      return;
    }
    for (const element of option.items) {
      if (isList(element) || isSet(element))
        throw fault(
          "TSR052",
          "A choice list element must be a value or a choice object { value?, text, background? }, not a list or set.",
          span,
        );
      add(element, value);
    }
  });
  if (buttons.length === 0)
    throw fault(
      "TSR052",
      "A choice needs at least one button, but its option lists are empty.",
      span,
    );
  return buttons;
}

function choiceButton(
  option: SerializableRuntimeValue,
  value: PreparedInteractionChoiceValue | null,
  context: TemporalContext,
  span: SourceSpan,
): InteractionChoiceOption {
  if (!isObject(option)) {
    if (!isVisibleScalar(option))
      throw fault(
        "TSR052",
        "A choice option must be a value, a choice object { value?, text, background? }, a list, or a set.",
        span,
      );
    return { text: visibleText(option, span, context), value: value ?? choiceValue(option) };
  }
  if (
    option.properties.some(
      (property) =>
        property.name !== "value" && property.name !== "text" && property.name !== "background",
    )
  )
    throw fault("TSR052", "Choice objects support value, text, and background only.", span);
  const textValue = getSerializableProperty(option, "text");
  if (textValue === undefined) throw fault("TSR052", "A choice object requires text.", span);
  const text = fieldText(textValue, span, context);
  const ownValue = getSerializableProperty(option, "value");
  if (ownValue !== undefined && value !== null)
    throw fault(
      "TSR052",
      "This choice option has two values, one before ':' and one in its value property. Keep one.",
      span,
    );
  if (ownValue !== undefined && !isVisibleScalar(ownValue))
    throw fault(
      "TSR052",
      "A choice value must be text, a number, true, false, null, a duration, or a date or time value.",
      span,
    );
  const background = getSerializableProperty(option, "background");
  return {
    text,
    value: value ?? choiceValue(ownValue === undefined ? textValue : ownValue),
    ...(background === undefined ? {} : { background: backgroundColor(background, span) }),
  };
}

/** A scalar that `isVisibleScalar` accepted, as a choice value. */
function choiceValue(value: SerializableRuntimeValue): InteractionChoiceValue {
  if (isDuration(value)) return { ...value };
  if (isTemporal(value)) return { ...value };
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  throw new Error("A choice value must be a visible scalar.");
}

function backgroundColor(value: SerializableRuntimeValue, span: SourceSpan): string {
  const normalized = normalizeOpaqueColor(value);
  if (normalized === null)
    throw fault("TSR052", "Expected an opaque CSS button background colour.", span);
  return normalized;
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
