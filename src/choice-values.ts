import type { InteractionChoiceValue } from "./plan/model.js";
import type { InteractionResultValue } from "./runtime/actions/model.js";
import {
  cloneCapturedSerializableValue,
  validateCapturedSerializableValue,
  type SerializableRuntimeValue,
} from "./runtime/serializable-values.js";
import { VALUE_KINDS, valueKindOf, type ValueKind } from "./value-kinds.js";

/**
 * Whether `value` is a canonical choice value: a value of a kind whose `choice` is set (`VALUE_KINDS`). A number is
 * finite and never `-0`.
 */
export function isInteractionChoiceValue(value: unknown): value is InteractionChoiceValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (validateCapturedSerializableValue(value) !== null) return false;
  // EVIDENCE: validation: validateCapturedSerializableValue accepted the value as a runtime value.
  return VALUE_KINDS[valueKindOf(value as SerializableRuntimeValue)].choice;
}

/**
 * Why a button cannot return a value of `kind` that it shows, such as a script reference or a regex, from the compiler
 * and the runtime (`TSR052`), or `undefined` when it may return the value or does not show it.
 */
export function unreturnableChoiceMessage(kind: ValueKind): string | undefined {
  const { choice, shown, description } = VALUE_KINDS[kind];
  if (choice || !shown) return undefined;
  return `A button cannot return ${description}. Give the buttons text or number values, and pick ${description.replace(/^an? /u, "the ")} from the answer.`;
}

export function cloneInteractionChoiceValue(value: InteractionChoiceValue): InteractionChoiceValue {
  return typeof value === "object" && value !== null ? { ...value } : value;
}

/** A copy of an interaction result: a choice value, or a form's object, dict, or list of answers. */
export function cloneInteractionResult(value: InteractionResultValue): InteractionResultValue {
  if (typeof value !== "object" || value === null) return value;
  if (value.kind === "object" || value.kind === "dict" || value.kind === "list")
    // EVIDENCE: invariant: a copy of a form's answers keeps its object, dict, or list kind.
    return cloneCapturedSerializableValue(value) as InteractionResultValue;
  return { ...value };
}
