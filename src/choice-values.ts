import type { InteractionChoiceValue } from "./plan/model.js";
import {
  validateCapturedSerializableValue,
  type SerializableRuntimeValue,
} from "./runtime/values/serializable-values.js";
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
  if (choice || shown === null) return undefined;
  return `A button cannot return ${description}. Give the buttons text or number values, and pick ${description.replace(/^an? /u, "the ")} from the answer.`;
}

export function cloneInteractionChoiceValue(value: InteractionChoiceValue): InteractionChoiceValue {
  return typeof value === "object" && value !== null ? { ...value } : value;
}
