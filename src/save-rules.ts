/**
 * A value that exists only in the current session, a speaker, a camera view, a permanent button, or a timer, media, or
 * message handle (`hasIdentity`), cannot be saved, also inside a list, set, dict, or object (V30 §25). The type checker
 * and the runtime give one message.
 */

import { thisValue, VALUE_KINDS, type ValueKind } from "./value-kinds.js";

/**
 * A `save` of a value of kind `identity`, or of a value that holds one, of kind `holder`, or `null` for a value of no
 * one kind. A message handle names its text property as the fix.
 */
export function unsavableMessage(identity: ValueKind, holder?: ValueKind | null): string {
  const kind = VALUE_KINDS[identity].description;
  const fix =
    identity === "messageHandle"
      ? "Save a message's text with its text property, as in 'save line.text as \"status\"'."
      : "Save values such as text, numbers, or lists instead.";
  return holder === undefined
    ? `save cannot store ${kind}: it exists only in the current session. ${fix}`
    : `save cannot store ${thisValue(holder ?? undefined)}: it holds ${kind}, which exists only in the current session. ${fix}`;
}
