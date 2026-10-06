/** The field vocabulary of `askForm` (V30 §20), shared by the compiler's checks and the runtime's. */

import type { FormFieldKind } from "./plan/model.js";

const FORM_FIELD_KINDS: readonly FormFieldKind[] = [
  "boolean",
  "cycle",
  "integer",
  "number",
  "text",
  "date",
  "time",
  "datetime",
];

/** The properties of a field descriptor. */
export const FORM_FIELD_PROPERTIES: readonly string[] = [
  "type",
  "value",
  "text",
  "options",
  "optional",
  "min",
  "max",
  "hint",
  "background",
  "description",
];

export const FORM_FIELD_PROPERTIES_TEXT =
  "A field has type, value, text, options, optional, min, max, hint, background, and description.";

export function isFormFieldKind(value: unknown): value is FormFieldKind {
  return FORM_FIELD_KINDS.some((kind) => kind === value);
}

/** The message for a `type:` that is no field kind, which suggests the nearest kind when one is close. */
export function unknownFormTypeMessage(type: string): string {
  const suggestion = FORM_FIELD_KINDS.find((kind) => editDistance(kind, type.toLowerCase()) <= 2);
  return suggestion === undefined
    ? `unknown type '${type}' (use ${FORM_FIELD_KINDS.map((kind) => `'${kind}'`).join(", ")}).`
    : `unknown type '${type}' (use '${suggestion}').`;
}

/** The edit distance of two short texts, or 3 for any longer distance. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2 || b.length > 16) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
}
