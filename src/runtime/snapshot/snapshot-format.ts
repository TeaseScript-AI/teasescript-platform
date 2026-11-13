import { hasExactKeys } from "../../plan/validation-support.js";
import type { SourceSpan } from "../../source.js";
import { isPlainRecord } from "../values/plain-data.js";

// The snapshot format's revision and the span check host data shares with snapshot validation, without the snapshot
// model (`state.ts`), whose scope helpers are the engine's.

export const RUNTIME_SNAPSHOT_VERSION = 93;

/** Whether `value` is a source span: exactly a start and an end position, the end not before the start. */
export function validSpan(value: unknown): value is SourceSpan {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["start", "end"]) &&
    validPosition(value.start) &&
    validPosition(value.end) &&
    value.end.offset >= value.start.offset
  );
}

function validPosition(value: unknown): value is { offset: number; line: number; column: number } {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["offset", "line", "column"]) &&
    nonNegativeSafeInteger(value.offset) &&
    nonNegativeSafeInteger(value.line) &&
    nonNegativeSafeInteger(value.column)
  );
}

export function nonNegativeSafeInteger(value: unknown): value is number {
  // EVIDENCE: validation: Number.isSafeInteger establishes the numeric value before comparison.
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
