import type { RuntimeErrorCode } from "../../diagnostic-codes.js";
import type { PlanSourceLocation } from "../../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../../source.js";
import { internalFault, RuntimeFault } from "../errors.js";
import { copySpan } from "../operations/support.js";
import type { SerializableRuntimeValue } from "../serializable-values.js";
import type { RuntimeSnapshot, RuntimeTemporarySnapshot } from "../state.js";
import { describeShownValue } from "../value-types.js";
// What the engine and its instruction families share.

export type SourceSpan = RichSourceSpan | PlanSourceLocation;

export function readTemporary(
  temporaries: readonly RuntimeTemporarySnapshot[],
  temporaryId: number,
  span: SourceSpan,
): SerializableRuntimeValue {
  const temporary = temporaries.find((item) => item.id === temporaryId);
  if (temporary === undefined) {
    throw fault(
      "TSR046",
      internalFault(
        `An internal value (temporary ${temporaryId}) is missing from the session's state.`,
      ),
      span,
    );
  }
  return temporary.value;
}

export function currentCallFrameId(snapshot: RuntimeSnapshot): number | null {
  return snapshot.callFrames.at(-1)?.id ?? null;
}

export function currentFrame(snapshot: RuntimeSnapshot) {
  return snapshot.frames.at(-1)!;
}

export function advance(snapshot: RuntimeSnapshot): void {
  snapshot.nextInstruction += 1;
}

/** How to make a value that is not a duration one: give a number a unit, or use a duration such as `example`. */
export function durationFix(value: SerializableRuntimeValue, example: string): string {
  return typeof value === "number"
    ? `Give the number a unit, such as '${describeShownValue(value)} s'.`
    : `Use a duration such as '${example}'.`;
}

export function fault(code: RuntimeErrorCode, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
