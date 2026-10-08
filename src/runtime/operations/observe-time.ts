import { type InstructionPlan, mainSourceSpan } from "../../plan/model.js";
import { interruptFrame, interruptRunning } from "../activations.js";
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
  repeatsSilently,
  skipSilentPasses,
  type MediaTimelineEvent,
} from "../media.js";
import { applyMediaEvent, mediaSpan } from "./media-lifecycle.js";
import {
  expireTimerAction,
  timerHandlerAwaitsStorageWrite,
  timerHandlerDispatchable,
  timerSpan,
} from "./timer-lifecycle.js";
import { timeOutButton } from "./complete-action.js";
import {
  closeDebugTrace,
  openDebugTrace,
  type RuntimeDebugContext,
  type TraceStore,
} from "../debug-trace.js";
import { captureExecutableData, copySpan, pendingResult, takeSequence } from "./support.js";
import { randomControlFor } from "../random-control.js";
import {
  compileRandomPolicy,
  type RandomControl,
  RandomSuspension,
  type RandomControlOptions,
  type RandomDrawPendingOutcome,
  type RandomPolicy,
} from "../random-control.js";

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
/** The options of an operation whose catch-up may draw a repeating timer's next round. */
export interface CatchUpOptions {
  readonly debugTrace?: RuntimeDebugContext;
  /** Which draws the host decides or pauses at (`docs/RUNTIME.md#controlled-randomness`). */
  readonly randomControl?: RandomControlOptions;
}

export function observeTime(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  suppliedNowMs: unknown,
  mediaReports: unknown = [],
  options: CatchUpOptions = {},
): PendingActionOperationResult<TimeObservationOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  const policy = catchUpPolicy(captured.plan, options);
  const trace = openDebugTrace(options.debugTrace, captured.plan, snapshot);
  const observed = observeCapturedTime(
    captured.plan,
    captured.snapshot,
    suppliedNowMs,
    mediaReports,
    trace,
    policy,
  );
  closeDebugTrace(trace, observed);
  return observed;
}

/** Observes time for engine-owned plan/state that already passed complete validation. */
export function observeValidatedTime(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  suppliedNowMs: unknown,
  mediaReports: unknown = [],
  options: CatchUpOptions & { readonly randomPolicy?: RandomPolicy | null } = {},
): PendingActionOperationResult<TimeObservationOutcome> {
  const policy =
    options.randomPolicy === undefined ? catchUpPolicy(plan, options) : options.randomPolicy;
  const trace = openDebugTrace(options.debugTrace, plan, snapshot);
  const observed = observeCapturedTime(plan, snapshot, suppliedNowMs, mediaReports, trace, policy);
  closeDebugTrace(trace, observed);
  return observed;
}

/** The checked random policy of a snapshot operation that only catches up; its timers draw from the session state. */
export function catchUpPolicy(
  plan: InstructionPlan,
  options: Pick<CatchUpOptions, "randomControl">,
): RandomPolicy | null {
  return options.randomControl === undefined
    ? null
    : compileRandomPolicy(plan, options.randomControl, false);
}

/**
 * Catches up due work at the root of an operation with the host's random policy. A draw that pauses keeps what
 * finishing the catch-up needs. Returns the operation's control, whose receipts its result carries.
 */
export function catchUp(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  events: InterpreterEvent[],
  trace: TraceStore | null,
  policy: RandomPolicy | null,
): RandomControl | null {
  const control = randomControlFor(plan, policy, trace);
  try {
    processDueWork(plan, current, events, trace, control);
  } catch (error) {
    if (!(error instanceof RandomSuspension)) throw error;
    current.randomControl = {
      forcedChoices: current.randomControl?.forcedChoices ?? 0,
      pending: {
        draw: error.draw,
        unit: "dueWork",
        root: "dueWork",
        instructionBudget: null,
        instructionsUsed: null,
        eventsBefore: false,
        forced: error.journal.forced,
        builtinResults: error.journal.builtinResults,
      },
    };
  }
  if (control !== null && control.receipts.length > 0)
    current.randomControl = {
      forcedChoices: (current.randomControl?.forcedChoices ?? 0) + control.receipts.length,
      pending: current.randomControl?.pending ?? null,
    };
  return control;
}

/** The result of an operation that caught up, with the chosen outcomes and refusal of its control. */
export function catchUpResult<T>(
  current: RuntimeSnapshot,
  events: readonly InterpreterEvent[],
  outcome: T,
  control: RandomControl | null,
): PendingActionOperationResult<T> {
  const settled = pendingResult(current, events, outcome);
  if (control === null || (control.receipts.length === 0 && control.refusal === null))
    return settled;
  return Object.freeze({
    ...settled,
    ...(control.receipts.length === 0
      ? {}
      : { randomChoices: Object.freeze([...control.receipts]) }),
    ...(control.refusal === null ? {} : { randomRefusal: control.refusal }),
  });
}

/** The refusal of a host operation while a draw is paused: it changes nothing until the host resolves the draw. */
export function randomDrawPending(current: RuntimeSnapshot): RandomDrawPendingOutcome | null {
  const pending = current.randomControl?.pending ?? null;
  return pending === null
    ? null
    : Object.freeze({ kind: "randomDrawPending", drawId: pending.draw.drawId } as const);
}

function observeCapturedTime(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  suppliedNowMs: unknown,
  mediaReports: unknown,
  trace: TraceStore | null,
  policy: RandomPolicy | null,
): PendingActionOperationResult<TimeObservationOutcome> {
  const paused = randomDrawPending(current);
  if (paused !== null) return pendingResult(current, [], paused);
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
  const control = catchUp(plan, current, events, trace, policy);
  return catchUpResult(
    current,
    events,
    { kind: "observed", currentSessionTimeMs: current.currentSessionTimeMs } as const,
    control,
  );
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
  trace: TraceStore | null = null,
  control: RandomControl | null = null,
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
    if (due.kind === "timer") {
      // A round's draw comes first in its expiry, so a pause undoes the round with the counters a unit restores.
      const unit =
        control !== null &&
        due.action.timer.range !== null &&
        control.beginUnit("dueWork", current, events, trace, null);
      try {
        current.currentSessionTimeMs = Math.max(current.currentSessionTimeMs, due.deadlineMs);
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
        trace?.at(due.action.owningInstruction, current.currentSessionTimeMs);
        expireTimerAction(
          current,
          due.action,
          due.action.timer.deadlineMs!,
          timerSpan(plan, due.action.owningInstruction),
          events,
          trace,
          control,
        );
      } catch (error) {
        if (unit && error instanceof RandomSuspension)
          control.abortUnit(error, current, events, trace);
        else if (unit) control.discardUnit(trace);
        throw error;
      }
      if (unit) control.endUnit(trace);
      continue;
    }
    current.currentSessionTimeMs = Math.max(current.currentSessionTimeMs, due.deadlineMs);
    if (due.kind === "media") {
      // One timeline event per iteration, so a queued cue block holds catch-up like a timer expiry.
      const media = due.action.media;
      let event = due.event;
      if (repeatsSilently(media)) {
        // Silent pass ends may be skipped only up to the next other work, which could observe or change this media.
        const boundary = nextOtherWork(current, due.actionId);
        skipSilentPasses(
          media,
          boundary.deadlineMs,
          boundary.phase > 0 || due.actionId < boundary.actionId,
        );
        event = nextMediaEvent(media)!;
        current.currentSessionTimeMs = Math.max(current.currentSessionTimeMs, event.dueAtMs!);
      }
      const span = mediaSpan(plan, due.action.owningInstruction);
      applyMediaEvent(plan, current, due.action, event, events, span);
    } else if (due.kind === "suspended") {
      settleSuspendedDelay(plan, current, due.frame, due.action, events);
    } else if (due.action.kind === "interaction") {
      trace?.at(due.action.owningInstruction, current.currentSessionTimeMs);
      timeOutButton(plan, current, due.action, events, trace);
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
  const handlerRunning = interruptRunning(snapshot);
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
  const frame = interruptFrame(snapshot);
  if (frame !== undefined) {
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
