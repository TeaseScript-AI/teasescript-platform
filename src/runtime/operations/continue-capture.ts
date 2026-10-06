import { captureExternalData } from "../../external-data-capture.js";
import { interruptFrame } from "../activations.js";
import type { InstructionPlan } from "../../plan/model.js";
import {
  frozenTemporalContext,
  isValidEpochMilliseconds,
  temporalContextProblem,
  type TemporalContext,
} from "../../temporal.js";
import type { RuntimeSnapshot } from "../state.js";
import {
  temporalCaptureAt,
  temporalCaptureShownAt,
  type RuntimeTemporalCapture,
} from "../temporal-captures.js";
import type { PendingActionOperationResult } from "./model.js";
import {
  captureExecutableData,
  type CapturedExecutableData,
  isPlainRecord,
  pendingResult,
} from "./support.js";
import { closeDebugTrace, openDebugTrace, type RuntimeDebugContext } from "../debug-trace.js";

export type ContinueCaptureOutcome =
  | { readonly kind: "recorded"; readonly boundaryMs: number }
  | { readonly kind: "invalidCapture"; readonly message: string };

/**
 * Records what the host captured when the player continues a restored session (V30 §35): the wall clock and, when it
 * changed, the zone and presentation. The capture is a recorded input in force from the observed scene time on, so
 * saved catch-up before that time keeps the earlier capture and a replay of the same inputs is equivalent. Restore
 * itself records nothing.
 */
export function recordContinueCapture(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capture: unknown,
  options: { readonly debugTrace?: RuntimeDebugContext } = {},
): PendingActionOperationResult<ContinueCaptureOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  const trace = openDebugTrace(options.debugTrace, captured.plan, snapshot);
  const recorded = recordCapturedContinueCapture(captured, capture);
  closeDebugTrace(trace, recorded);
  return recorded;
}

function recordCapturedContinueCapture(
  captured: CapturedExecutableData,
  capture: unknown,
): PendingActionOperationResult<ContinueCaptureOutcome> {
  const current = captured.snapshot;
  const invalid = (message: string) =>
    pendingResult(current, [], { kind: "invalidCapture", message } as const);
  if (current.status === "failed") return invalid("A failed session accepts no Continue capture.");
  const input = captureExternalData(capture);
  if (
    !input.ok ||
    !isPlainRecord(input.value) ||
    Object.keys(input.value).some((key) => key !== "wallClockMs" && key !== "temporalContext")
  )
    return invalid("A Continue capture must be { wallClockMs, temporalContext? }.");
  const { wallClockMs, temporalContext } = input.value;
  if (typeof wallClockMs !== "number" || !isValidEpochMilliseconds(wallClockMs))
    return invalid("wallClockMs must be whole epoch milliseconds in the years 0000 to 9999.");
  if (temporalContext !== undefined) {
    const problem = temporalContextProblem(temporalContext);
    if (problem !== null) return invalid(`temporalContext is malformed: ${problem}`);
  }
  const boundaryMs = current.observedSessionTimeMs;
  let context = temporalCaptureAt(current.temporalCaptures, boundaryMs).context;
  if (temporalContext !== undefined) {
    // EVIDENCE: validation: temporalContextProblem accepted the captured context above.
    context = frozenTemporalContext(temporalContext as TemporalContext);
  }
  const sinceEventSequence = current.nextEventSequence;
  // A capture replaces the previous one only when nothing happened in between: same boundary, no new event.
  const captures = current.temporalCaptures.filter(
    (entry) => entry.boundaryMs < boundaryMs || entry.sinceEventSequence < sinceEventSequence,
  );
  captures.push({ boundaryMs, sinceEventSequence, epochMs: wallClockMs, context });
  // The list may be long while catch-up is held, so it is replaced element by element rather than spread into a call.
  const needed = neededCaptures(current, captures);
  current.temporalCaptures.length = 0;
  for (const capture of needed) current.temporalCaptures.push(capture);
  return pendingResult(current, [], { kind: "recorded", boundaryMs } as const);
}

/**
 * The captures a session can still use: the one in force now, every later one for saved catch-up, and the one each
 * open interaction was shown with, which validation needs to derive its buttons again.
 */
function neededCaptures(
  snapshot: RuntimeSnapshot,
  captures: readonly RuntimeTemporalCapture[],
): RuntimeTemporalCapture[] {
  const kept = new Set([temporalCaptureAt(captures, snapshot.currentSessionTimeMs)]);
  for (const action of [
    snapshot.foregroundAction,
    interruptFrame(snapshot)?.timerInterruption?.suspendedAction ?? null,
  ])
    if (action?.kind === "interaction") {
      const shown = temporalCaptureShownAt(
        captures,
        action.createdAtMs,
        action.requestEventSequence,
      );
      if (shown !== undefined) kept.add(shown);
    }
  return captures.filter(
    (capture) => kept.has(capture) || capture.boundaryMs > snapshot.currentSessionTimeMs,
  );
}
