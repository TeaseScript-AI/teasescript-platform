import { type InstructionPlan, mainSourceSpan } from "../../plan/model.js";
import {
  MAX_RUNTIME_SESSION_TIME_MS,
  type RuntimeCallFrameSnapshot,
  type RuntimeSnapshot,
} from "../state.js";
import {
  interactionDeadlineMs,
  type RuntimeActionSettlementSnapshot,
  type RuntimeChatPacingGateActionSnapshot,
  type RuntimeDelayActionSnapshot,
  type RuntimeInteractionActionSnapshot,
  type RuntimeTimerActionSnapshot,
  type RuntimeMediaActionSnapshot,
} from "../actions/model.js";
import type { ActionCompletedEvent, InterpreterEvent } from "../events.js";
import { isValidSessionTime } from "../actions/delay.js";
import type { PendingActionOperationResult, TimeObservationOutcome } from "./model.js";
import { settleBackgroundPacingGate } from "./pacing-gate.js";
import { skipSilentRounds } from "../timers.js";
import {
  nextMediaEvent,
  pruneMediaPoints,
  recordMediaProgress,
  type MediaTimelineEvent,
} from "../media.js";
import { applyMediaEvent, mediaSpan } from "./media-lifecycle.js";
import {
  expireTimerAction,
  timerHandlerAwaitsStorageWrite,
  timerHandlerDispatchable,
  timerSpan,
} from "./timer-lifecycle.js";
import { terminalContinuationHandoffFor } from "./terminal-continuation.js";
import { timeOutButton } from "./complete-action.js";
import { captureExecutableData, copySpan, pendingResult, takeSequence } from "./support.js";

/** One Player sample of media playback: the active playback time of `segment` so far. */
export interface MediaProgressReport {
  readonly mediaId: number;
  readonly segment: number;
  readonly progressMs: number;
}

/**
 * Observes scene time and, optionally, the playback progress of running media at that time. A running media without a
 * report in an observation has made no known progress since its last sample. Reports for unknown, settled, or
 * unloaded media, another segment, an earlier or equal time, or decreasing progress are ignored.
 */
export function observeTime(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  suppliedNowMs: unknown,
  mediaReports: unknown = [],
): PendingActionOperationResult<TimeObservationOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  const current = captured.snapshot;
  if (!isValidSessionTime(suppliedNowMs))
    return pendingResult(current, [], {
      kind: "invalidObservation",
      message: `Time observation must be a finite number from 0 through ${MAX_RUNTIME_SESSION_TIME_MS}.`,
    });
  const reports = parseMediaReports(mediaReports);
  if (reports === null)
    return pendingResult(current, [], {
      kind: "invalidObservation",
      message:
        "Media progress reports must be a list of { mediaId, segment, progressMs } with a positive media ID, a non-negative segment, and a finite non-negative progress.",
    });
  current.observedSessionTimeMs = Math.max(current.observedSessionTimeMs, suppliedNowMs);
  if (current.status !== "failed") {
    for (const report of reports) {
      const action = current.backgroundActions.find(
        (candidate): candidate is RuntimeMediaActionSnapshot =>
          candidate.kind === "media" && candidate.media.mediaId === report.mediaId,
      );
      if (action !== undefined) {
        recordMediaProgress(action.media, report.segment, report.progressMs, suppliedNowMs);
      }
    }
  }
  const events: InterpreterEvent[] = [];
  processDueWork(captured.plan, current, events);
  return pendingResult(current, events, {
    kind: "observed",
    currentSessionTimeMs: current.currentSessionTimeMs,
  });
}

/**
 * Advances scene time toward the observed time one due deadline at a time, in `(deadline, action ID)` order. Whenever
 * the script or an expiry block can execute, catch-up pauses with scene time at the moment that work became due, and
 * the engine resumes catch-up once execution waits again. Every settlement records that scene time, so a late
 * observation gives exactly the result of observing every deadline on time.
 */
export function processDueWork(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  events: InterpreterEvent[],
): void {
  // A failed session is terminal: later observations record time but settle nothing.
  if (current.status === "failed") return;
  for (;;) {
    if (executionRunnable(current) || timerHandlerAwaitsStorageWrite(current)) return;
    const due = nextDueWork(current);
    if (due === null) {
      current.currentSessionTimeMs = current.observedSessionTimeMs;
      for (const action of current.backgroundActions) {
        if (action.kind === "media") pruneMediaPoints(action.media, current.currentSessionTimeMs);
      }
      return;
    }
    current.currentSessionTimeMs = Math.max(current.currentSessionTimeMs, due.deadlineMs);
    if (due.kind === "timer") {
      // Silent rounds may be skipped only up to the next other work, which could observe or change this timer.
      const boundary = nextOtherWork(current, due.actionId);
      skipSilentRounds(
        due.action.timer,
        boundary.deadlineMs,
        boundary.phase > 0 || due.actionId < boundary.actionId,
      );
      current.currentSessionTimeMs = Math.max(
        current.currentSessionTimeMs,
        due.action.timer.deadlineMs!,
      );
      expireTimerAction(
        current,
        due.action,
        due.action.timer.deadlineMs!,
        timerSpan(plan, due.action.owningInstruction),
        events,
      );
    } else if (due.kind === "media") {
      // One timeline event per iteration, so a queued cue block holds catch-up like a timer expiry.
      const span = mediaSpan(plan, due.action.owningInstruction);
      applyMediaEvent(plan, current, due.action, due.event, events, span);
    } else if (due.kind === "suspended") {
      settleSuspendedDelay(plan, current, due.frame, due.action, events);
    } else if (due.action.kind === "interaction") {
      timeOutButton(plan, current, due.action, events);
    } else if (
      due.action.kind === "chatPacingGate" &&
      current.backgroundActions.includes(due.action)
    ) {
      settleBackgroundPacingGate(plan, current, due.action, "completed", events);
    } else {
      settleForegroundTimedAction(plan, current, due.action, events);
    }
  }
}

/** The script or a queued expiry block can execute. */
export function executionRunnable(snapshot: RuntimeSnapshot): boolean {
  if (snapshot.status === "ready" || snapshot.status === "running") return true;
  return snapshot.status === "waiting" && timerHandlerDispatchable(snapshot);
}

type DueWork =
  | {
      readonly kind: "action";
      readonly action:
        | RuntimeDelayActionSnapshot
        | RuntimeChatPacingGateActionSnapshot
        | RuntimeInteractionActionSnapshot;
      readonly deadlineMs: number;
      readonly actionId: number;
    }
  | {
      readonly kind: "timer";
      readonly action: RuntimeTimerActionSnapshot;
      readonly deadlineMs: number;
      readonly actionId: number;
    }
  | {
      /** The next media timeline event that reported playback covers, due at its scene time. */
      readonly kind: "media";
      readonly action: RuntimeMediaActionSnapshot;
      readonly event: MediaTimelineEvent;
      readonly deadlineMs: number;
      readonly actionId: number;
    }
  | {
      readonly kind: "suspended";
      readonly frame: RuntimeCallFrameSnapshot;
      readonly action: RuntimeDelayActionSnapshot;
      readonly deadlineMs: number;
      readonly actionId: number;
    };

/** Media departures happen after other work at the same scene time; everything else is phase 0. */
function workPhase(work: DueWork): number {
  return work.kind === "media" && work.event.kind === "departure" ? 1 : 0;
}

function precedes(
  left: { readonly deadlineMs: number; readonly phase: number; readonly actionId: number },
  right: { readonly deadlineMs: number; readonly phase: number; readonly actionId: number },
): boolean {
  return (
    left.deadlineMs < right.deadlineMs ||
    (left.deadlineMs === right.deadlineMs &&
      (left.phase < right.phase || (left.phase === right.phase && left.actionId < right.actionId)))
  );
}

/**
 * The earliest timed work due by the observed time, by `(deadline, phase, action ID)`. A due foreground delay waits
 * while an expiry block that became due earlier is queued: the block interrupts that delay first, and the delay then
 * settles as suspended work. A button with a timeout likewise waits behind such a block; while suspended it stays
 * inert and times out once the block returns.
 */
function nextDueWork(snapshot: RuntimeSnapshot): DueWork | null {
  let earliest: DueWork | null = null;
  for (const candidate of timedWork(snapshot)) {
    if (candidate.deadlineMs > snapshot.observedSessionTimeMs) continue;
    if (
      earliest === null ||
      precedes(
        { ...candidate, phase: workPhase(candidate) },
        { ...earliest, phase: workPhase(earliest) },
      )
    ) {
      earliest = candidate;
    }
  }
  return earliest;
}

/**
 * The earliest other timed work by `(deadline, action ID)`, or the observed time, which every action precedes. Work at
 * the same deadline goes first when its action ID is lower.
 */
function nextOtherWork(
  snapshot: RuntimeSnapshot,
  actionId: number,
): { readonly deadlineMs: number; readonly phase: number; readonly actionId: number } {
  let boundary = { deadlineMs: snapshot.observedSessionTimeMs, phase: 0, actionId: Infinity };
  for (const candidate of timedWork(snapshot)) {
    const work = { ...candidate, phase: workPhase(candidate) };
    if (candidate.actionId !== actionId && precedes(work, boundary)) {
      boundary = { deadlineMs: work.deadlineMs, phase: work.phase, actionId: work.actionId };
    }
  }
  return boundary;
}

function timedWork(snapshot: RuntimeSnapshot): DueWork[] {
  const candidates: DueWork[] = [];
  const foreground = snapshot.foregroundAction;
  const handlerRunning = snapshot.callFrames.some((frame) => frame.timerInterruption !== null);
  const noQueuedBlockFirst = handlerRunning || snapshot.pendingTimerHandlers.length === 0;
  if (
    foreground?.kind === "chatPacingGate" ||
    (foreground?.kind === "delay" && noQueuedBlockFirst)
  ) {
    candidates.push({
      kind: "action",
      action: foreground,
      deadlineMs: foreground.deadlineMs,
      actionId: foreground.actionId,
    });
  }
  const buttonDeadlineMs =
    foreground?.kind === "interaction" ? interactionDeadlineMs(foreground) : null;
  if (foreground?.kind === "interaction" && buttonDeadlineMs !== null && noQueuedBlockFirst) {
    candidates.push({
      kind: "action",
      action: foreground,
      deadlineMs: buttonDeadlineMs,
      actionId: foreground.actionId,
    });
  }
  for (const action of snapshot.backgroundActions) {
    if (action.kind === "chatPacingGate") {
      candidates.push({
        kind: "action",
        action,
        deadlineMs: action.deadlineMs,
        actionId: action.actionId,
      });
    } else if (action.kind === "timer" && action.timer.deadlineMs !== null) {
      candidates.push({
        kind: "timer",
        action,
        deadlineMs: action.timer.deadlineMs,
        actionId: action.actionId,
      });
    } else if (action.kind === "media") {
      const event = nextMediaEvent(action.media);
      if (event?.dueAtMs !== null && event?.dueAtMs !== undefined) {
        candidates.push({
          kind: "media",
          action,
          event,
          deadlineMs: event.dueAtMs,
          actionId: action.actionId,
        });
      }
    }
  }
  for (const frame of snapshot.callFrames) {
    const suspended = frame.timerInterruption?.suspendedAction;
    if (suspended?.kind === "delay") {
      candidates.push({
        kind: "suspended",
        frame,
        action: suspended,
        deadlineMs: suspended.deadlineMs,
        actionId: suspended.actionId,
      });
    }
  }
  return candidates;
}

/**
 * A delay interrupted by an expiry block still settles in deadline order and publishes `actionCompleted`. Its
 * continuation stays suspended and runs once when the block returns normally.
 */
function settleSuspendedDelay(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  frame: RuntimeCallFrameSnapshot,
  action: RuntimeDelayActionSnapshot,
  events: InterpreterEvent[],
): void {
  const completionEventSequence = takeSequence(snapshot, 1);
  const settlement = createDelaySettlement(
    action,
    completionEventSequence,
    snapshot.currentSessionTimeMs,
  );
  frame.returnInstruction = action.continuationInstruction;
  frame.timerInterruption = { ...frame.timerInterruption!, suspendedAction: null };
  // Not retained as `lastSettlement`: the running block may own released prepared output whose provenance is the
  // retained pacing settlement, and completions for a suspended action were already rejected as `suspendedAction`.
  events.push(
    Object.freeze({
      kind: "actionCompleted",
      sequence: completionEventSequence,
      settlement,
      span: copySpan(plan.instructions[action.owningInstruction]?.span ?? mainSourceSpan(plan)),
    } satisfies ActionCompletedEvent),
  );
}

function settleForegroundTimedAction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  action: RuntimeDelayActionSnapshot | RuntimeChatPacingGateActionSnapshot,
  events: InterpreterEvent[],
): RuntimeActionSettlementSnapshot {
  const completionEventSequence = takeSequence(snapshot, 1);
  const settlement =
    action.kind === "delay"
      ? createDelaySettlement(action, completionEventSequence, snapshot.currentSessionTimeMs)
      : createPacingSettlement(action, completionEventSequence, snapshot.currentSessionTimeMs);
  snapshot.foregroundAction = null;
  snapshot.lastSettlement = settlement;
  snapshot.terminalContinuationHandoff =
    action.kind === "delay" ? terminalContinuationHandoffFor(plan, action) : null;
  snapshot.status = "running";
  if (action.kind === "chatPacingGate" && action.preparedOutput !== null) {
    snapshot.preparedSayOutput = action.preparedOutput;
    snapshot.nextInstruction = action.preparedOutput.owningInstruction;
  } else if (action.kind === "delay") {
    snapshot.nextInstruction = action.continuationInstruction;
  }
  // A gate promoted by a pacing barrier carries no prepared output; the barrier runs again and then advances.
  const span = plan.instructions[action.owningInstruction]?.span ?? mainSourceSpan(plan);
  const completionEvent: ActionCompletedEvent = Object.freeze({
    kind: "actionCompleted",
    sequence: completionEventSequence,
    settlement,
    span: copySpan(span),
  });
  events.push(completionEvent);
  return settlement;
}

function createDelaySettlement(
  action: RuntimeDelayActionSnapshot,
  completionEventSequence: number,
  completedAtMs: number,
): RuntimeActionSettlementSnapshot {
  return Object.freeze({
    actionId: action.actionId,
    actionKind: "delay",
    settlementKind: "completed",
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    requestEventSequence: action.requestEventSequence,
    completionEventSequence,
    deadlineMs: action.deadlineMs,
    completedAtMs,
  });
}

function createPacingSettlement(
  action: RuntimeChatPacingGateActionSnapshot,
  completionEventSequence: number,
  completedAtMs: number,
): RuntimeActionSettlementSnapshot {
  return Object.freeze({
    actionId: action.actionId,
    actionKind: "chatPacingGate",
    settlementKind: "completed",
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    requestEventSequence: action.requestEventSequence,
    completionEventSequence,
    deadlineMs: action.deadlineMs,
    completedAtMs,
    releasedPreparedOutputInstruction: action.preparedOutput?.owningInstruction ?? null,
  });
}

function parseMediaReports(value: unknown): MediaProgressReport[] | null {
  if (!Array.isArray(value)) return null;
  const reports: MediaProgressReport[] = [];
  const entries: readonly unknown[] = value;
  for (const entry of entries) {
    if (!isReportRecord(entry)) return null;
    const { mediaId, segment, progressMs } = entry;
    if (
      typeof mediaId !== "number" ||
      !Number.isSafeInteger(mediaId) ||
      mediaId < 1 ||
      typeof segment !== "number" ||
      !Number.isSafeInteger(segment) ||
      segment < 0 ||
      !isValidSessionTime(progressMs)
    )
      return null;
    reports.push({ mediaId, segment, progressMs });
  }
  return reports;
}

function isReportRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
