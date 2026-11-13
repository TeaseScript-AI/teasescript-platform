// The helpers the other askForm files share: a refused update, a field's bounds, and a cycle field's value kind.

import { numberAnswerText } from "../../../interaction-answers.js";
import type { FormScalarField, InteractionChoiceValue } from "../../../plan/model.js";

/** The type a cycle option's value has, which all options of one cycle share. */
export function cycleValueKind(value: InteractionChoiceValue): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  return value.kind;
}

export function withinBounds(field: FormScalarField, value: number): boolean {
  return (field.min === null || value >= field.min) && (field.max === null || value <= field.max);
}

export function boundsText(field: FormScalarField): string {
  if (field.min !== null && field.max !== null)
    return `from ${numberAnswerText(field.min)} to ${numberAnswerText(field.max)}`;
  return field.min !== null
    ? `at least ${numberAnswerText(field.min)}`
    : `at most ${numberAnswerText(field.max!)}`;
}

export function refused(message: string): { readonly ok: false; readonly message: string } {
  return { ok: false, message };
}
