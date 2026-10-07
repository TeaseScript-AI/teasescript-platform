import type { InstructionPlan } from "../../plan/model.js";
import { isValidSessionTime } from "../actions/delay.js";
import type { InterpreterEvent } from "../events.js";
import { loadMedia } from "../media.js";
import type { RuntimeSnapshot } from "../state.js";
import {
  activeMediaAction,
  emitDeveloperWarning,
  mediaSpan,
  releaseMediaWait,
  stopMediaAction,
  warnUnreachableCues,
} from "./media-lifecycle.js";
import type { PendingActionOperationResult } from "./model.js";
import {
  catchUp,
  catchUpPolicy,
  catchUpResult,
  randomDrawPending,
  type CatchUpOptions,
} from "./observe-time.js";
import type { RandomDrawPendingOutcome, RandomPolicy } from "../random-control.js";
import { timerHandlerDispatchable } from "./timer-lifecycle.js";
import { captureExecutableData, type CapturedExecutableData, pendingResult } from "./support.js";
import { closeDebugTrace, openDebugTrace, type TraceStore } from "../debug-trace.js";

/** The Player's load result for one media ID. */
export type MediaLoadReport =
  | { readonly kind: "loaded"; readonly durationMs: number }
  | { readonly kind: "failed"; readonly message?: string };

export type MediaReportOutcome =
  /** The report changed canonical state. */
  | { readonly kind: "accepted" }
  /** The media is not active, already loaded, or the report names an older segment or no new progress. */
  | { readonly kind: "ignored" }
  | { readonly kind: "unknownMedia"; readonly mediaId: number }
  /** Scene time has not caught up with the observed time, or a due block runs first; run the engine and retry. */
  | { readonly kind: "executionPending"; readonly mediaId: number }
  | { readonly kind: "invalidReport"; readonly message: string }
  | RandomDrawPendingOutcome;

/**
 * Records the Player's load result at the observed time, once execution has caught up with it. A loaded source makes duration-dependent state authoritative and releases an
 * async play; a failure reports a developer warning, stops the media without cues or `finish`, and releases any wait.
 */
export function reportMediaLoad(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  mediaId: unknown,
  report: unknown,
  options: CatchUpOptions = {},
): PendingActionOperationResult<MediaReportOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  const policy = catchUpPolicy(captured.plan, options);
  const trace = openDebugTrace(options.debugTrace, captured.plan, snapshot);
  const reported = reportCapturedMediaLoad(captured, mediaId, report, trace, policy);
  closeDebugTrace(trace, reported);
  return reported;
}

/** Reports a media load for engine-owned plan/state that already passed complete validation. */
export function reportValidatedMediaLoad(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  mediaId: unknown,
  report: unknown,
  options: CatchUpOptions & { readonly randomPolicy?: RandomPolicy | null } = {},
): PendingActionOperationResult<MediaReportOutcome> {
  const policy =
    options.randomPolicy === undefined ? catchUpPolicy(plan, options) : options.randomPolicy;
  const trace = openDebugTrace(options.debugTrace, plan, snapshot);
  const reported = reportCapturedMediaLoad({ plan, snapshot }, mediaId, report, trace, policy);
  closeDebugTrace(trace, reported);
  return reported;
}

function reportCapturedMediaLoad(
  captured: CapturedExecutableData,
  mediaId: unknown,
  report: unknown,
  trace: TraceStore | null,
  policy: RandomPolicy | null,
): PendingActionOperationResult<MediaReportOutcome> {
  const current = captured.snapshot;
  const paused = randomDrawPending(current);
  if (paused !== null) return pendingResult(current, [], paused);
  const parsed = parseLoadReport(report);
  if (!isMediaId(mediaId) || parsed === null) {
    return pendingResult(current, [], {
      kind: "invalidReport",
      message:
        "A media load report needs a media ID and { kind: 'loaded', durationMs } with a finite non-negative duration, or { kind: 'failed' }.",
    });
  }
  if (mediaId >= current.nextMediaId) {
    return pendingResult(current, [], { kind: "unknownMedia", mediaId });
  }
  const action = activeMediaAction(current, mediaId);
  if (current.status === "failed" || action === undefined || action.media.loaded) {
    return pendingResult(current, [], { kind: "ignored" });
  }
  // A load result is host input at the observed time: scene time must have caught up, and a due block runs first.
  if (
    current.currentSessionTimeMs < current.observedSessionTimeMs ||
    timerHandlerDispatchable(current)
  ) {
    return pendingResult(current, [], { kind: "executionPending", mediaId });
  }
  const events: InterpreterEvent[] = [];
  const span = mediaSpan(captured.plan, action.owningInstruction);
  if (parsed.kind === "failed") {
    emitDeveloperWarning(
      current,
      events,
      "TSW013",
      `Media "${action.media.source}" could not be played${parsed.message === undefined ? "" : `: ${parsed.message}`}.`,
      span,
    );
    stopMediaAction(captured.plan, current, action, events, span);
  } else {
    const emptyRange = loadMedia(action.media, parsed.durationMs, current.currentSessionTimeMs);
    if (emptyRange !== null) {
      emitDeveloperWarning(current, events, "TSW013", emptyRange, span);
      stopMediaAction(captured.plan, current, action, events, span);
    } else {
      warnUnreachableCues(current, action, span, events);
      releaseMediaWait(captured.plan, current, mediaId, "loaded", events, span);
    }
  }
  const control = catchUp(captured.plan, current, events, trace, policy);
  return catchUpResult(current, events, { kind: "accepted" } as const, control);
}

function isMediaId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function parseLoadReport(value: unknown): MediaLoadReport | null {
  if (!isRecord(value)) return null;
  const record = value;
  if (record.kind === "loaded" && isValidSessionTime(record.durationMs)) {
    return { kind: "loaded", durationMs: record.durationMs };
  }
  if (
    record.kind === "failed" &&
    (record.message === undefined || typeof record.message === "string")
  ) {
    return record.message === undefined
      ? { kind: "failed" }
      : { kind: "failed", message: record.message };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
