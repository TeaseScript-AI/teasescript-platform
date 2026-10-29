import type { RuntimeErrorCode } from "../../diagnostic-codes.js";
import {
  buttonBackgroundMessage,
  CHOICE_ELEMENT_RULE,
  CHOICE_OPTION_RULE,
  CHOICE_TEXT_MESSAGE,
  CHOICE_VALUE_RULE,
  CHOICE_VALUES_MESSAGE,
  choicePropertyMessage,
  EMPTY_CHOICE_MESSAGE,
  isChoiceObjectProperty,
} from "../../choice-rules.js";
import { normalizeOpaqueColor } from "../../color.js";
import { MAX_INTERACTION_OPTION_ENTRIES } from "../../interaction-limits.js";
import type {
  InteractionChoiceOption,
  InteractionChoiceValue,
  PlanSourceLocation,
  PreparedInteractionChoiceValue,
} from "../../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../../source.js";
import type { TemporalContext } from "../../temporal.js";
import { RuntimeFault } from "../errors.js";
import { describeShownValue } from "../values/value-types.js";
import {
  getSerializableProperty,
  serializableEquals,
  type SerializableRuntimeValue,
} from "../values/serializable-values.js";
import { isList, isObject, isSet } from "../values/value-predicates.js";
import { unreturnableChoiceMessage } from "../../choice-values.js";
import { VALUE_KINDS, valueKindOf } from "../../value-kinds.js";
import { fieldText, isVisibleScalar, visibleText } from "../values/value-text.js";
import { copySpan } from "../../plan/source-location.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/**
 * The buttons of a prepared `askChoice`, in order: one for each value or choice object, and one for each element of a
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
        throw fault("TSR052", `${CHOICE_ELEMENT_RULE}, not a list or set.`, span);
      add(element, value);
    }
  });
  if (buttons.length === 0) throw fault("TSR052", EMPTY_CHOICE_MESSAGE, span);
  return buttons;
}

/**
 * The position of the button that a `prefill:` value preselects (V30 §19): the first whose value equals it. `null`
 * preselects none, and so does a value that no button has, for which the result is `undefined`.
 */
export function preselectedChoice(
  options: readonly InteractionChoiceOption[],
  prefill: SerializableRuntimeValue,
): number | null | undefined {
  if (prefill === null) return null;
  const index = options.findIndex((option) => serializableEquals(option.value, prefill));
  return index === -1 ? undefined : index;
}

function choiceButton(
  option: SerializableRuntimeValue,
  value: PreparedInteractionChoiceValue | null,
  context: TemporalContext,
  span: SourceSpan,
): InteractionChoiceOption {
  if (!isObject(option)) {
    if (!isVisibleScalar(option)) throw fault("TSR052", `${CHOICE_OPTION_RULE}.`, span);
    return { text: visibleText(option, span, context), value: value ?? choiceValue(option, span) };
  }
  const extra = option.properties.find((property) => !isChoiceObjectProperty(property.name));
  if (extra !== undefined) throw fault("TSR052", choicePropertyMessage(extra.name), span);
  const textValue = getSerializableProperty(option, "text");
  if (textValue === undefined) throw fault("TSR052", CHOICE_TEXT_MESSAGE, span);
  const text = fieldText(textValue, span, context);
  const ownValue = getSerializableProperty(option, "value");
  if (ownValue !== undefined && value !== null) throw fault("TSR052", CHOICE_VALUES_MESSAGE, span);
  if (ownValue !== undefined && !isVisibleScalar(ownValue))
    throw fault("TSR052", `${CHOICE_VALUE_RULE}.`, span);
  const background = getSerializableProperty(option, "background");
  return {
    text,
    value: value ?? choiceValue(ownValue === undefined ? textValue : ownValue, span),
    ...(background === undefined ? {} : { background: backgroundColor(background, span) }),
  };
}

/**
 * A scalar that `isVisibleScalar` accepted, as a choice value (`choice`); a value that is shown but not returned, such as
 * a script reference or a regex, fails with `TSR052`.
 */
function choiceValue(value: SerializableRuntimeValue, span: SourceSpan): InteractionChoiceValue {
  const kind = valueKindOf(value);
  const unreturnable = unreturnableChoiceMessage(kind);
  if (unreturnable !== undefined) throw fault("TSR052", unreturnable, span);
  if (!VALUE_KINDS[kind].choice) throw new Error("A choice value must be a visible scalar.");
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  // EVIDENCE: invariant: a value of a kind whose `choice` is set is a choice value; a record is copied.
  return (
    typeof value === "object" && value !== null ? { ...value } : value
  ) as InteractionChoiceValue;
}

function backgroundColor(value: SerializableRuntimeValue, span: SourceSpan): string {
  const normalized = normalizeOpaqueColor(value);
  if (normalized === null)
    throw fault("TSR052", buttonBackgroundMessage(describeShownValue(value)), span);
  return normalized;
}

function fault(code: RuntimeErrorCode, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
