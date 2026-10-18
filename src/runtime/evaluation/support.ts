import type { RuntimeErrorCode } from "../../diagnostic-codes.js";
import type { PlanSourceLocation, ExpressionPlan, InstructionPlan } from "../../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../../source.js";
import { RuntimeFault, internalFault } from "../errors.js";
import { copySpan } from "../operations/support.js";
import { rangeLength, rangeText, wholeRangeMessage } from "../../range-checks.js";
import type { SerializableRuntimeRange, SerializableRuntimeValue } from "../serializable-values.js";
import { readPreparedReference } from "../prepared-references.js";
import { quotedText } from "../value-text.js";
import { messageText } from "../text-length.js";
import { loweredOperand } from "../lowered-operands.js";
import type { RuntimeTemporarySnapshot } from "../state.js";
import type { Evaluator } from "../evaluator.js";

// What the evaluator and its evaluation modules share.

export type SourceSpan = RichSourceSpan | PlanSourceLocation;

export function fault(code: RuntimeErrorCode, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}

/**
 * What a call gives when it needs its `default:`, which runs only then (owner decision, 2026-10-16), or a call or `load`
 * of `evaluateWithoutDefault` that needs the default that the instructions after it run.
 */
export const USE_DEFAULT: unique symbol = Symbol("use the default");

/** `TSR045` unless `range` has whole-number bounds and a length that a number counts exactly. */
export function assertIntegerRange(
  range: SerializableRuntimeRange,
  subject: string,
  span: SourceSpan,
): void {
  const length = rangeLength(range);
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    !Number.isSafeInteger(length)
  ) {
    throw fault(
      "TSR045",
      !Number.isInteger(range.start) || !Number.isInteger(range.end)
        ? wholeRangeMessage(subject, `this range is ${rangeText(range)}`)
        : Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
          ? `${subject} needs a range it can count, but ${rangeText(range)} holds too many numbers. Use a smaller range.`
          : `${subject} needs a range of whole numbers, but the bounds of ${rangeText(range)} are too large. Use bounds closer to 0.`,
      span,
    );
  }
}

/** How the source spells a dict receiver, also one prepared before the rest of its statement, or `null`. */
export function receiverLabel(evaluator: Evaluator, plan: ExpressionPlan): string | null {
  if (plan.kind !== "preparedReference") return planLabel(plan, evaluator.plan);
  const descriptor = readPreparedReference(
    readTemporary(evaluator.snapshot.temporaries, plan.temporaryId, plan.span),
    plan.span,
  );
  const names: string[] = [];
  for (const step of descriptor.path) {
    if (step.kind !== "property") return null;
    names.push(step.name);
  }
  return descriptor.rootName === null ? null : [descriptor.rootName, ...names].join(".");
}

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

/**
 * The source spelling of a variable, property path, or text literal plan, also one that the lowering kept in a
 * temporary of `program`, or `null` for anything else.
 */
export function planLabel(plan: ExpressionPlan, program: InstructionPlan): string | null {
  const names: string[] = [];
  let current = loweredOperand(program, plan);
  for (;;) {
    if (current.kind === "group") current = current.expression;
    else if (current.kind === "property") {
      names.push(current.name);
      current = current.object;
    } else break;
  }
  if (current.kind === "literal" && typeof current.value === "string" && names.length === 0)
    return quotedText(messageText(current.value));
  if (current.kind !== "identifier") return null;
  names.push(current.name);
  return names.reverse().join(".");
}
