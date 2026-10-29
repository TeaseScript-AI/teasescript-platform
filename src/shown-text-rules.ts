/**
 * The values that `${...}` and `join()` show as text, and the messages for one they cannot show, which the type checker
 * and the runtime both give. A value is named by its kind (`VALUE_KINDS`), which both know alike.
 */

import { VALUE_KINDS, type ValueKind } from "./value-kinds.js";

/** `${...}` of a dict, written as `label` where it is a name such as `prices`. */
export function interpolatedDictMessage(label: string | null): string {
  const dict = label ?? "dict";
  return `'\${...}' cannot show a dict. Select one value with '${dict}[key]', or show every value with '${dict}.values.join()'.`;
}

/** `${...}` of a value of `kind` that is neither shown nor a list or dict, with a fix for an object or a set. */
export function interpolationMessage(kind: ValueKind): string {
  const fix =
    kind === "object"
      ? "Show one of its properties instead."
      : kind === "set"
        ? "Show its elements with 'toList().join()' instead."
        : "It shows text, numbers, true, false, null, durations, angles, date and time values, script references, and regexes, and selects one element of a list.";
  return `'\${...}' cannot show ${VALUE_KINDS[kind].description}. ${fix}`;
}

/** `${...}` of an empty list, from which it cannot select an element to show. */
export const EMPTY_INTERPOLATED_LIST_MESSAGE =
  "'${...}' shows one random element of a list, but this list is empty. Check its length first.";

/** `${...}` of a list with an element it cannot show, since it shows one element. */
export const INTERPOLATED_LIST_MESSAGE =
  "An interpolated list may contain only text, numbers, true, false, null, durations, angles, date and time values, script references, and regexes, because one element is shown as text.";

/** What `join()` shows of a list's elements, and the fix for an element it cannot show. */
export const JOIN_RULE =
  "join() can only join text, numbers, true or false, null, durations, angles, date and time values, script references, and regexes";
export const JOIN_FIX = "Select an element or a property first.";

/** `join()` of a list with an element it cannot show, of `kind` where it is one kind. */
export function joinElementMessage(kind: ValueKind | undefined): string {
  return `${JOIN_RULE}${kind === undefined ? "" : `, not ${VALUE_KINDS[kind].description}`}. ${JOIN_FIX}`;
}
