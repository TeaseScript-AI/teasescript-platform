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
import { processDueWork } from "./observe-time.js";
import { timerHandlerDispatchable } from "./timer-lifecycle.js";
import { captureExecutableData, pendingResult } from "./support.js";

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
  | { readonly kind: "invalidReport"; readonly message: string };

/**
 * Records the Player's load result at the observed time, once execution has caught up with it. A loaded source makes duration-dependent state authoritative and releases an
 * async play; a failure reports a developer warning, stops the media without cues or `finish`, and releases any wait.
 */
export function reportMediaLoad(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  mediaId: unknown,
  report: unknown,
): PendingActionOperationResult<MediaReportOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  const current = captured.snapshot;
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
  processDueWork(captured.plan, current, events);
  return pendingResult(current, events, { kind: "accepted" });
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
