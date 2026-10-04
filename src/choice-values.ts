import type { InteractionChoiceValue } from "./plan/model.js";

/** Whether `value` is a canonical choice value. A number is finite and never `-0`. */
export function isInteractionChoiceValue(value: unknown): value is InteractionChoiceValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).length === 2 &&
    "kind" in value &&
    value.kind === "duration" &&
    "milliseconds" in value &&
    typeof value.milliseconds === "number" &&
    Number.isFinite(value.milliseconds)
  );
}

export function cloneInteractionChoiceValue(value: InteractionChoiceValue): InteractionChoiceValue {
  return typeof value === "object" && value !== null
    ? { kind: "duration", milliseconds: value.milliseconds }
    : value;
}
