import type { InteractionChoiceValue } from "./plan/model.js";
import {
  isSetElement,
  validateCapturedSerializableValue,
  type SerializableRuntimeValue,
} from "./runtime/serializable-values.js";
import { isDuration } from "./runtime/value-predicates.js";

/** Whether `value` is a canonical choice value: a scalar, a duration, or a date or time value. A number is finite and never `-0`. */
export function isInteractionChoiceValue(value: unknown): value is InteractionChoiceValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (validateCapturedSerializableValue(value) !== null) return false;
  // EVIDENCE: validation: validateCapturedSerializableValue accepted the value as a runtime value.
  const runtimeValue = value as SerializableRuntimeValue;
  return isSetElement(runtimeValue) || isDuration(runtimeValue);
}

export function cloneInteractionChoiceValue(value: InteractionChoiceValue): InteractionChoiceValue {
  return typeof value === "object" && value !== null ? { ...value } : value;
}
