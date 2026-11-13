// The helpers the other askForm files share: a fault at a span, a refused update, plain record and exact key checks, a
// field's bounds, and a cycle field's value kind.

import { numberAnswerText } from "../../../interaction-answers.js";
import type {
  FormScalarField,
  InteractionChoiceValue,
  PlanSourceLocation,
} from "../../../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../../../source.js";
import { RuntimeFault } from "../../errors.js";
import { copySpan } from "../../../plan/source-location.js";

export type SourceSpan = RichSourceSpan | PlanSourceLocation;

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

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function fault(message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault("TSR052", message, copySpan(span));
}
