import type { InteractionChoiceValue } from "./plan/model.js";
import type { InteractionResultValue } from "./runtime/actions/model.js";
import {
  cloneCapturedSerializableValue,
  validateCapturedSerializableValue,
  type SerializableRuntimeValue,
} from "./runtime/serializable-values.js";

/** The kinds of record a choice value may be besides a scalar. */
const CHOICE_VALUE_KINDS: ReadonlySet<string> = new Set([
  "duration",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
]);

/**
 * Whether `value` is a canonical choice value: a scalar, a duration, or a date or time value. A number is finite and
 * never `-0`.
 */
export function isInteractionChoiceValue(value: unknown): value is InteractionChoiceValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (validateCapturedSerializableValue(value) !== null) return false;
  // EVIDENCE: validation: validateCapturedSerializableValue accepted the value as a runtime value.
  const record = value as Exclude<SerializableRuntimeValue, string | number | boolean | null>;
  return CHOICE_VALUE_KINDS.has(record.kind);
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
