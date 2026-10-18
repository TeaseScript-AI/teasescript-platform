import { captureExternalData } from "../../external-data-capture.js";
import { type InstructionPlan, mainSourceSpan } from "../../plan/model.js";
import { interruptRunning } from "../activations.js";
import { MAX_RUNTIME_SESSION_TIME_MS, type RuntimeSnapshot } from "../state.js";
import {
  interactionDeadlineMs,
  type RuntimeActionSettlementSnapshot,
  type RuntimeChatPacingGateActionSnapshot,
  type RuntimeDelayActionSnapshot,
  type RuntimeInteractionActionSnapshot,
  type RuntimeTimerActionSnapshot,
  type RuntimeMediaActionSnapshot,
  type RuntimePendingActionSnapshot,
} from "../actions/model.js";
import type { ActionCompletedEvent, InterpreterEvent } from "../events.js";
import { isValidSessionTime } from "../actions/delay.js";
import { isPlainRecord } from "../plain-data.js";
import type { PendingActionOperationResult, TimeObservationOutcome } from "./model.js";
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
  timerHandlerHoldsCatchUp,
  timerHandlerDispatchable,
  timerSpan,
} from "./timer-lifecycle.js";
import { timeOutButton } from "./complete-action.js";
import { withDebugTrace, type RuntimeDebugContext, type TraceStore } from "../debug-trace.js";
import { captureExecutableData, pendingResult, takeSettlementSequence } from "./support.js";
import type { RuntimeSessionView } from "../session.js";
import { randomControlFor } from "../random-control.js";
import {
  compileRandomPolicy,
  type RandomControl,
  RandomSuspension,
  type RandomControlOptions,
  type RandomPolicy,
} from "../random-control.js";
import { copySpan } from "../../plan/source-location.js";
import { randomDrawPending } from "./model.js";

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
  return withDebugTrace(options.debugTrace, captured.plan, snapshot, (trace) =>
    observeCapturedTime(
      captured.plan,
      captured.snapshot,
      suppliedNowMs,
      mediaReports,
      trace,
      policy,
    ),
  );
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
  return withDebugTrace(options.debugTrace, plan, snapshot, (trace) =>
    observeCapturedTime(plan, snapshot, suppliedNowMs, mediaReports, trace, policy),
  );
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
        "Media progress reports must be a plain-data list of { mediaId, segment, progressMs } with a positive media ID, a non-negative segment, and a finite non-negative progress.",
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
    if (executionRunnable(current) || timerHandlerHoldsCatchUp(current)) return;
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
          true,
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
    } else if (due.action.kind === "interaction") {
      trace?.at(due.action.owningInstruction, current.currentSessionTimeMs);
      timeOutButton(plan, current, due.action, events, trace);
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
 * The earliest timed work due by the observed time, by `(deadline, phase, action ID)`. A due foreground delay, reading
 * time, or button timeout waits while an expiry block that became due earlier is queued: the block interrupts it first,
 * and it stands still until the block returns.
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

/**
 * Work that comes due by scene time alone, at `deadlineMs`, for the pending action `actionId` of kind `kind`: a `wait`
 * or blocking timer (`delay`), a reading time (`chatPacingGate`), the timeout of a presented button (`interaction`), the
 * end of a timer round (`timer`), or the next timeline event of media whose reported progress reached it (`media`).
 */
export interface RuntimeTimedWork {
  readonly kind: "delay" | "chatPacingGate" | "interaction" | "timer" | "media";
  readonly actionId: number;
  readonly deadlineMs: number;
  /**
   * A round of a repeating timer without an expiry block. It runs nothing, so an observation past it gives the result
   * of observing it on time.
   */
  readonly silent: boolean;
  /** A timer round that draws the next round's length from a range; catch-up settles each such round on its own. */
  readonly drawsNextRound: boolean;
}

/**
 * The timed work of a session, which `observeTime` settles once scene time reaches its deadline: where a host observes
 * time next. A foreground wait, reading time, or button timeout stands still while a queued block goes first, and a
 * failed session settles nothing further.
 */
export function runtimeTimedWork(
  view: Pick<
    RuntimeSessionView,
    "status" | "foregroundAction" | "backgroundActions" | "queuedBlocks" | "suspendedAtMs"
  >,
): readonly RuntimeTimedWork[] {
  if (view.status === "failed") return Object.freeze([]);
  // `suspendedAtMs` is when the running block started, so it is set exactly while a block runs.
  const blockRunning = view.suspendedAtMs !== null;
  return Object.freeze(
    timedWorkOf(view, blockRunning || view.queuedBlocks === 0).map((work) => {
      const timer = work.kind === "timer" ? work.action.timer : null;
      return Object.freeze({
        kind: work.action.kind,
        actionId: work.actionId,
        deadlineMs: work.deadlineMs,
        silent: timer !== null && timer.repeat && timer.handlerFunctionId === null,
        drawsNextRound: timer !== null && timer.range !== null,
      });
    }),
  );
}

function timedWork(snapshot: RuntimeSnapshot): DueWork[] {
  const handlerRunning = interruptRunning(snapshot);
  return timedWorkOf(snapshot, handlerRunning || snapshot.pendingTimerHandlers.length === 0);
}

function timedWorkOf(
  state: Pick<RuntimeSessionView, "foregroundAction" | "backgroundActions">,
  noQueuedBlockFirst: boolean,
): DueWork[] {
  const candidates: DueWork[] = [];
  const foreground =
    state.foregroundAction === null ? null : dueWorkOf(state.foregroundAction, noQueuedBlockFirst);
  if (foreground !== null) candidates.push(foreground);
  for (const action of state.backgroundActions) {
    const work = dueWorkOf(action, noQueuedBlockFirst);
    if (work !== null) candidates.push(work);
  }
  return candidates;
}

/**
 * The timed work of an active action, or `null` when no deadline settles it. A wait or reading time is due at its
 * deadline, an interaction at a button's timeout or a form's time limit, a timer at the end of its round, and media at
 * its next timeline event that reported playback covers. A media wait ends with its media, a permanent button waits for
 * clicks, and the host answers its steps. A foreground action stands still while a queued block goes first. Every kind
 * has its case, so a new kind must decide.
 */
function dueWorkOf(
  action: RuntimePendingActionSnapshot,
  noQueuedBlockFirst: boolean,
): DueWork | null {
  switch (action.kind) {
    case "delay":
    case "chatPacingGate":
      if (!noQueuedBlockFirst) return null;
      return { kind: "action", action, deadlineMs: action.deadlineMs, actionId: action.actionId };
    case "interaction": {
      const deadlineMs = interactionDeadlineMs(action);
      if (deadlineMs === null || !noQueuedBlockFirst) return null;
      return { kind: "action", action, deadlineMs, actionId: action.actionId };
    }
    case "timer":
      if (action.timer.deadlineMs === null) return null;
      return {
        kind: "timer",
        action,
        deadlineMs: action.timer.deadlineMs,
        actionId: action.actionId,
      };
    case "media": {
      const event = nextMediaEvent(action.media);
      if (event?.dueAtMs === null || event?.dueAtMs === undefined) return null;
      return { kind: "media", action, event, deadlineMs: event.dueAtMs, actionId: action.actionId };
    }
    case "mediaPlayback":
    case "permanentButton":
    case "storageWrite":
    case "capture":
    case "fileStore":
    case "lock":
      return null;
    default: {
      const unhandled: never = action;
      throw new Error("An active action has no timing.", { cause: unhandled });
    }
  }
}

function settleForegroundTimedAction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  action: RuntimeDelayActionSnapshot | RuntimeChatPacingGateActionSnapshot,
  events: InterpreterEvent[],
): RuntimeActionSettlementSnapshot {
  const completionEventSequence = takeSettlementSequence(snapshot, action);
  const settlement =
    action.kind === "delay"
      ? createDelaySettlement(action, completionEventSequence, snapshot.currentSessionTimeMs)
      : createPacingSettlement(action, completionEventSequence, snapshot.currentSessionTimeMs);
  snapshot.foregroundAction = null;
  snapshot.lastSettlement = settlement;
  snapshot.status = "running";
  snapshot.nextInstruction = action.continuationInstruction;
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
  });
}

/** Parses the captured plain data of a host batch; one malformed entry refuses the whole batch. */
function parseMediaReports(value: unknown): MediaProgressReport[] | null {
  const captured = captureExternalData(value);
  if (!captured.ok || !Array.isArray(captured.value)) return null;
  const reports: MediaProgressReport[] = [];
  const entries: readonly unknown[] = captured.value;
  for (const entry of entries) {
    if (!isPlainRecord(entry)) return null;
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
