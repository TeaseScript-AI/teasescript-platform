import { interpreterEventProblem } from "../../src/runtime/event-validation.js";
import type { InterpreterEvent } from "../../src/runtime/events.js";

// Shape checks of op arguments, which the host runs before an op: records with exactly their keys, and arrays read by
// index, and the event logs a restore takes. The engine still validates the other host data inside them.

/**
 * Whether `value` is an object and no array. It admits any prototype, such as a `Date` or a `Map`; where an argument must
 * be a plain record, `isPlainRecord` checks that.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` is a plain record: an object whose prototype is `Object.prototype` or `null`. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Whether `value` has every key of `required` and no key besides those and `optional`. */
export const exactly = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

/**
 * Whether `value` is a plain array of elements that pass `test`, read by index: a cloned array keeps its own
 * properties, such as an `every` or `map` of its own, so one with keys besides its indices is malformed, as is a hole.
 */
export function everyItem(value: unknown, test: (item: unknown) => boolean): boolean {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) return false;
  for (let index = 0; index < value.length; index += 1)
    if (!Object.hasOwn(value, index) || !test(value[index])) return false;
  return true;
}

export const isStringArray = (value: unknown): boolean =>
  everyItem(value, (item) => typeof item === "string");

/** A finite number of milliseconds that is not negative. */
export const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Whether `value` is a log of interpreter events: each one an event (`interpreterEventProblem`), their sequence
 * increasing from 1. Every op that takes an event list checks it with this at its boundary (`rewindBack`,
 * `rewindForward`, `restoreKept`): the engine's restore takes the events as they are.
 */
export function isEventLog(value: unknown): value is readonly InterpreterEvent[] {
  if (!Array.isArray(value)) return false;
  let sequence = 0;
  for (const event of value) {
    if (interpreterEventProblem(event) !== null) return false;
    // EVIDENCE: validation: interpreterEventProblem accepted the event, with its sequence, above.
    const next = (event as InterpreterEvent).sequence;
    if (next <= sequence) return false;
    sequence = next;
  }
  return true;
}
