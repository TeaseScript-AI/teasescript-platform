import type { RuntimeErrorCode } from "../diagnostic-codes.js";
import { executeFileStore } from "./actions/file-store.js";
import { executeLock } from "./actions/lock.js";
import { executeCapture, executeHideCamera, executeShowCamera } from "./instructions/camera.js";
import {
  beginFunctionDefaults,
  bindDefaultParameter,
  bindSuppliedParameter,
  enterFunction,
  enterFunctionBody,
  prepareParameterDefault,
  returnFromFunction,
} from "./instructions/functions.js";
import {
  executeInteraction,
  executePrepareInteractionSpeaker,
} from "./instructions/interaction.js";
import { executeLoopControl, executeLoopStart } from "./instructions/loops.js";
import { executeStopAudio, showImage, startMedia } from "./instructions/media.js";
import {
  executeDeclareSpeaker,
  executePrepareSayContextualSpeaker,
  executePrepareSaySpeaker,
  executePrepareSayText,
  executeSayAtomically,
} from "./instructions/say.js";
import { showPermanentButton } from "./instructions/show-permanent-button.js";
import { writeStorage } from "./instructions/storage-write.js";
import { advance, currentCallFrameId, currentFrame, fault } from "./instructions/support.js";
import { executeWait, startTimer } from "./instructions/timers.js";
import { leaveScopes } from "./scopes/captures.js";
import {
  type Instruction,
  type InstructionPlan,
  instructionSourcePath,
  mainSourceSpan,
} from "../plan/model.js";
import {
  type Evaluator,
  acceptedDefault,
  RuntimeExecutionContext,
  type RuntimeCapabilities,
} from "./evaluator.js";
export type {
  RuntimeBuiltinFunction,
  RuntimeCapabilities,
  RuntimeCapabilityCall,
} from "./evaluator.js";
import { internalFault, RuntimeFault, type RuntimeErrorInfo } from "./errors.js";
import { collectionTooLarge, exceedsHostCollectionSize } from "./values/collection-size.js";
import { textTooLong } from "./values/text-length.js";
import {
  assertCounterCanAdvance,
  captureExecutableData,
  pendingResult,
  result,
  RuntimeDataError,
  setCapturedTemporary,
  takeSequence,
} from "./operations/support.js";
import type { PendingActionOperationResult, RuntimeOperationResult } from "./operations/model.js";
import { captureExternalData } from "../external-data-capture.js";
import { copyPlainData, isPlainRecord } from "./values/plain-data.js";
import {
  compileRandomPolicy,
  RandomControl,
  randomControlFor,
  RandomReplayDivergence,
  checkedOutcome,
  RandomSuspension,
  unitNeedsStateCopy,
  type RandomControlOptions,
  type RandomDrawResolutionOutcome,
  type RandomOutcome,
  type RandomPolicy,
  type RandomRootOperation,
  type RuntimePendingRandomDrawSnapshot,
} from "./random/random-control.js";
import {
  executeEnd,
  executeGoto,
  executeSetFallback,
  executeTransfer,
} from "./operations/transfers.js";
import { contextRootId } from "./scopes/activations.js";
import { loweredLogicalOperator } from "./evaluation/lowered-operands.js";
import { withDebugTrace, type RuntimeDebugContext, type TraceStore } from "./debug/debug-trace.js";
import {
  InstructionTraceCollector,
  type RuntimeInstructionObserver,
} from "./debug/instruction-trace.js";
import {
  detachPreparedReferencesForMutation,
  GLOBAL_SCOPE_ID,
} from "./scopes/prepared-references.js";
export type {
  ActionCompletionOutcome,
  PendingActionOperationResult,
  RuntimeOperationResult,
  TimeObservationOutcome,
} from "./operations/model.js";
export { RuntimeDataError } from "./operations/support.js";
import type { ExitEvent, InterpreterEvent, RuntimeFailureEvent } from "./events.js";
import { cloneCapturedSerializableValue } from "./values/serializable-values.js";
import type { RuntimeSnapshot } from "./snapshot/state.js";
import { snapshotValidationAnalysis } from "./snapshot/snapshot-validation-analysis.js";
import { startTimerHandler, timerHandlerDispatchable } from "./operations/timer-handlers.js";
import { stopAllTimersForSessionEnd } from "./operations/timer-lifecycle.js";
import { copySpan } from "../plan/source-location.js";
import { notBoolean, notLogicalOperand } from "./evaluation/operators.js";
import { USE_DEFAULT } from "./evaluation/support.js";
import { stopAllMediaForSessionEnd } from "./operations/media-lifecycle.js";
import { executionRunnable, processDueWork } from "./operations/observe-time.js";
import { assertValueType } from "./values/value-types.js";

export interface RuntimeRunOptions {
  readonly instructionBudget?: number;
  /** An opt-in debug trace that observes the operation (`docs/RUNTIME.md#debug-trace`). */
  readonly debugTrace?: RuntimeDebugContext;
  /** `true` returns what the call executed as `instructionTrace` (`docs/RUNTIME.md#instruction-trace`). */
  readonly instructionTrace?: boolean;
  /** Which draws the host decides or pauses at (`docs/RUNTIME.md#controlled-randomness`). */
  readonly randomControl?: RandomControlOptions;
}

/** Run options of engine-owned state, whose host already checked its random control and observer once. */
export interface ValidatedRunOptions extends RuntimeRunOptions {
  readonly randomPolicy?: RandomPolicy | null;
  readonly instructionObserver?: RuntimeInstructionObserver;
}

function instructionTraceFor(
  plan: InstructionPlan,
  options: Pick<RuntimeRunOptions, "instructionTrace">,
): InstructionTraceCollector | null {
  return options.instructionTrace === true
    ? new InstructionTraceCollector(plan.instructions.length)
    : null;
}

/** The host's checked random policy: a session's own, or the snapshot API's `randomControl` option. */
export function randomPolicyFor(
  plan: InstructionPlan,
  options: Pick<ValidatedRunOptions, "randomControl" | "randomPolicy">,
  capabilities: RuntimeCapabilities,
): RandomPolicy | null {
  if (options.randomPolicy !== undefined) return options.randomPolicy;
  return options.randomControl === undefined
    ? null
    : compileRandomPolicy(plan, options.randomControl, capabilities.random !== undefined);
}

export function executeInstruction(
  plan: InstructionPlan,
  inputSnapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: Pick<RuntimeRunOptions, "debugTrace" | "instructionTrace" | "randomControl"> = {},
): RuntimeOperationResult {
  const captured = captureExecutableData(plan, inputSnapshot);
  const policy = randomPolicyFor(captured.plan, options, capabilities);
  return withDebugTrace(options.debugTrace, captured.plan, inputSnapshot, (trace) =>
    driveRoot(
      captured.plan,
      captured.snapshot,
      capabilities,
      options,
      trace,
      policy,
      "executeInstruction",
      null,
    ),
  );
}

/** Executes one instruction of engine-owned plan/state that already passed complete validation. */
export function executeValidatedInstruction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: Pick<
    ValidatedRunOptions,
    "debugTrace" | "instructionTrace" | "randomControl" | "randomPolicy" | "instructionObserver"
  > = {},
): RuntimeOperationResult {
  const policy = randomPolicyFor(plan, options, capabilities);
  return withDebugTrace(options.debugTrace, plan, snapshot, (trace) =>
    driveRoot(
      plan,
      snapshot,
      capabilities,
      options,
      trace,
      policy,
      "executeInstruction",
      null,
      options.instructionObserver,
    ),
  );
}

/** How many instructions an operation executed so far, including one whose due work a draw then paused. */
interface Progress {
  executed: number;
  /** The scene time the budget counts at: catch-up that moves scene time starts the count again. */
  budgetTimeMs: number;
  /** The instructions executed at that scene time, including those before a draw paused the operation. */
  counted: number;
}

function startProgress(snapshot: RuntimeSnapshot, counted: number): Progress {
  return { executed: 0, budgetTimeMs: snapshot.currentSessionTimeMs, counted };
}

/** The instructions the budget counted at the state's scene time, which a paused draw keeps. */
function budgetUsed(snapshot: RuntimeSnapshot, progress: Progress): number {
  return snapshot.currentSessionTimeMs > progress.budgetTimeMs ? 0 : progress.counted;
}

/**
 * Executes one instruction boundary. Once execution waits or ends, scene time continues toward the already observed
 * time, which may make a later deadline's work runnable at that deadline.
 */
function executeCapturedInstruction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  context: RuntimeExecutionContext,
  progress: Progress,
  observeStart = true,
): void {
  const executed = executeInstructionBoundary(plan, snapshot, context, observeStart);
  progress.executed += executed;
  progress.counted += executed;
  if (
    snapshot.status !== "failed" &&
    // Work due exactly at the observed time also settles once execution waits or ends.
    snapshot.currentSessionTimeMs <= snapshot.observedSessionTimeMs &&
    !executionRunnable(snapshot)
  ) {
    processDueWork(plan, snapshot, context.events, context.trace, context.control);
  }
}

function executeInstructionBoundary(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  context: RuntimeExecutionContext,
  observeStart: boolean,
): number {
  if (snapshot.status === "halted" || snapshot.status === "failed") {
    return 0;
  }
  const observer = context.observer;
  // A queued expiry block interrupts at this boundary, even while the main path waits.
  if (timerHandlerDispatchable(snapshot)) {
    if (observer !== null && observeDispatch(context.trace, observer, snapshot)) {
      context.stopped = true;
      return 0;
    }
    startTimerHandler(plan, snapshot, context.trace);
    return 1;
  }
  if (snapshot.status === "waiting") return 0;
  const instructionIndex = snapshot.nextInstruction;
  const call = currentCallFrameId(snapshot) ?? 0;
  if (
    observeStart &&
    observer !== null &&
    observeBefore(context.trace, observer, snapshot, instructionIndex, call)
  ) {
    context.stopped = true;
    return 0;
  }
  // Every region of a validated plan ends in a transfer, so execution never runs past one.
  const instruction = plan.instructions[instructionIndex]!;

  // A draw that pauses undoes the instruction; a few instructions can only be undone from a copy of the state.
  const control = context.control;
  const unit =
    control !== null &&
    control.beginUnit(
      "instruction",
      snapshot,
      context.events,
      context.trace,
      unitNeedsStateCopy(plan, snapshot, instructionIndex)
        ? () => copyPlainData(snapshot, "fork")
        : null,
    );
  snapshot.status = "running";
  const evaluator = context.evaluator();
  context.trace?.at(instructionIndex, snapshot.currentSessionTimeMs, call);
  const instructionTrace = context.instructionTrace;
  instructionTrace?.visit(instructionIndex);
  let failed = false;
  try {
    executePlannedInstruction(plan, instruction, snapshot, evaluator, context.events);
    instructionTrace?.settle(instructionIndex, instruction, snapshot.nextInstruction);
    if (snapshot.interactionResultHandoff?.continuationInstruction === instructionIndex) {
      snapshot.interactionResultHandoff = null;
    }
  } catch (error) {
    if (unit && error instanceof RandomSuspension) {
      control.abortUnit(error, snapshot, context.events, context.trace);
      throw error;
    }
    // A text too long that no check foresaw still fails as one, on V8, which says so with this message, and so does a
    // list, set, or dict larger than V8 holds.
    const failure =
      error instanceof RangeError && error.message === "Invalid string length"
        ? textTooLong("this line", instruction.span, null)
        : exceedsHostCollectionSize(error)
          ? collectionTooLarge("this line", instruction.span)
          : error;
    if (!(failure instanceof RuntimeFault)) {
      if (unit) control.discardUnit(context.trace);
      throw error;
    }
    failed = true;
    failSnapshot(
      snapshot,
      failure.toInfo(),
      instructionSourcePath(plan, instructionIndex),
      context.events,
    );
  } finally {
    snapshot.contextualSpeaker = null;
  }
  if (unit) control.endUnit(context.trace);
  // A failed instruction did not complete; the operation ends with its failure.
  if (observer !== null && !failed)
    observeAfter(context.trace, observer, snapshot, instructionIndex, call);
  return 1;
}

/** Calls an observer's `before` between two instructions, where its host may release records of the trace. */
function observeBefore(
  trace: TraceStore | null,
  observer: RuntimeInstructionObserver,
  snapshot: RuntimeSnapshot,
  instruction: number,
  call: number,
): boolean {
  if (observer.before === undefined) return false;
  if (trace !== null) trace.between = snapshot;
  try {
    return observer.before(instruction, call) === true;
  } finally {
    if (trace !== null) trace.between = null;
  }
}

/** Calls an observer's `dispatch` between two instructions, with the block that starts next and the call it gets. */
function observeDispatch(
  trace: TraceStore | null,
  observer: RuntimeInstructionObserver,
  snapshot: RuntimeSnapshot,
): boolean {
  if (observer.dispatch === undefined) return false;
  if (trace !== null) trace.between = snapshot;
  try {
    return (
      observer.dispatch(
        snapshot.pendingTimerHandlers[0]!.handlerFunctionId,
        snapshot.nextCallFrameId,
      ) === true
    );
  } finally {
    if (trace !== null) trace.between = null;
  }
}

/** Calls an observer's `after` between two instructions, where its host may release records of the trace. */
function observeAfter(
  trace: TraceStore | null,
  observer: RuntimeInstructionObserver,
  snapshot: RuntimeSnapshot,
  instruction: number,
  call: number,
): void {
  if (observer.after === undefined) return;
  if (trace !== null) trace.between = snapshot;
  try {
    observer.after(instruction, snapshot.nextInstruction, call);
  } finally {
    if (trace !== null) trace.between = null;
  }
}

export function stepToEvent(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: RuntimeRunOptions = {},
): RuntimeOperationResult {
  const captured = captureExecutableData(plan, snapshot);
  const policy = randomPolicyFor(captured.plan, options, capabilities);
  return withDebugTrace(options.debugTrace, captured.plan, snapshot, (trace) =>
    driveRoot(
      captured.plan,
      captured.snapshot,
      capabilities,
      options,
      trace,
      policy,
      "stepToEvent",
      instructionBudget(options.instructionBudget),
    ),
  );
}

/** Steps engine-owned plan/state that already passed complete validation. */
export function stepValidatedStateToEvent(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: ValidatedRunOptions = {},
): RuntimeOperationResult {
  const policy = randomPolicyFor(plan, options, capabilities);
  return withDebugTrace(options.debugTrace, plan, snapshot, (trace) =>
    driveRoot(
      plan,
      snapshot,
      capabilities,
      options,
      trace,
      policy,
      "stepToEvent",
      instructionBudget(options.instructionBudget),
      options.instructionObserver,
    ),
  );
}

export function run(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: RuntimeRunOptions = {},
): RuntimeOperationResult {
  const captured = captureExecutableData(plan, snapshot);
  const policy = randomPolicyFor(captured.plan, options, capabilities);
  return withDebugTrace(options.debugTrace, captured.plan, snapshot, (trace) =>
    driveRoot(
      captured.plan,
      captured.snapshot,
      capabilities,
      options,
      trace,
      policy,
      "run",
      instructionBudget(options.instructionBudget),
    ),
  );
}

/** Runs engine-owned plan/state that already passed complete validation. */
export function runValidatedState(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: ValidatedRunOptions = {},
): RuntimeOperationResult {
  const policy = randomPolicyFor(plan, options, capabilities);
  return withDebugTrace(options.debugTrace, plan, snapshot, (trace) =>
    driveRoot(
      plan,
      snapshot,
      capabilities,
      options,
      trace,
      policy,
      "run",
      instructionBudget(options.instructionBudget),
      options.instructionObserver,
    ),
  );
}

/**
 * Runs, steps to an event, or executes one instruction. A paused draw keeps what finishing the operation needs; while
 * a draw is paused, nothing runs.
 */
function driveRoot(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities,
  options: Pick<RuntimeRunOptions, "instructionTrace">,
  trace: TraceStore | null,
  policy: RandomPolicy | null,
  root: "run" | "stepToEvent" | "executeInstruction",
  budget: number | null,
  observer: RuntimeInstructionObserver | undefined = undefined,
): RuntimeOperationResult {
  if (snapshot.randomControl?.pending != null) return result(snapshot, [], 0);
  const control = randomControlFor(plan, policy, trace);
  const context = new RuntimeExecutionContext(
    snapshot,
    capabilities,
    plan,
    trace,
    instructionTraceFor(plan, options),
    control,
    observer ?? null,
  );
  const progress = startProgress(snapshot, 0);
  try {
    if (root === "executeInstruction")
      executeCapturedInstruction(plan, snapshot, context, progress);
    else runInstructions(plan, snapshot, context, progress, budget!, root === "stepToEvent");
  } catch (error) {
    if (!(error instanceof RandomSuspension)) throw error;
    pauseAtDraw(
      snapshot,
      error,
      root,
      budget,
      budgetUsed(snapshot, progress),
      context.events.length > 0,
    );
  }
  return controlledResult(snapshot, context, progress.executed);
}

/**
 * Runs instructions within `budget` per scene time. Scene time only moves while nothing can execute, so a loop that
 * never waits stays at one scene time, while each deadline that a late observation catches up starts the count again,
 * as observing that deadline on time would.
 */
function runInstructions(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  context: RuntimeExecutionContext,
  progress: Progress,
  budget: number,
  untilEvent: boolean,
): void {
  while (
    !context.stopped &&
    executionRunnable(snapshot) &&
    !(untilEvent && context.events.length > 0)
  ) {
    if (snapshot.currentSessionTimeMs > progress.budgetTimeMs) {
      progress.budgetTimeMs = snapshot.currentSessionTimeMs;
      progress.counted = 0;
    }
    if (progress.counted >= budget) {
      failForBudget(plan, snapshot, context.events, budget);
      break;
    }
    executeCapturedInstruction(plan, snapshot, context, progress);
  }
}

/** Keeps a paused draw and what finishing its interrupted operation needs. */
export function pauseAtDraw(
  snapshot: RuntimeSnapshot,
  suspension: RandomSuspension,
  root: RandomRootOperation,
  budget: number | null,
  used: number,
  eventsBefore: boolean,
): void {
  const budgeted = root === "run" || root === "stepToEvent";
  snapshot.randomControl = {
    forcedChoices: snapshot.randomControl?.forcedChoices ?? 0,
    pending: {
      draw: suspension.draw,
      unit: suspension.unit,
      root,
      instructionBudget: budgeted ? budget : null,
      instructionsUsed: budgeted ? used : null,
      eventsBefore: root === "stepToEvent" && eventsBefore,
      forced: suspension.journal.forced,
      builtinResults: suspension.journal.builtinResults,
    },
  };
}

/** The result of an operation, with the chosen outcomes it accepted, which also count in the state. */
export function controlledResult(
  snapshot: RuntimeSnapshot,
  context: Pick<RuntimeExecutionContext, "events" | "instructionTrace" | "control">,
  instructionsExecuted: number,
): RuntimeOperationResult {
  const control = context.control;
  if (control !== null && control.receipts.length > 0)
    snapshot.randomControl = {
      forcedChoices: (snapshot.randomControl?.forcedChoices ?? 0) + control.receipts.length,
      pending: snapshot.randomControl?.pending ?? null,
    };
  const executed = result(snapshot, context.events, instructionsExecuted, context.instructionTrace);
  if (control === null || (control.receipts.length === 0 && control.refusal === null))
    return executed;
  return Object.freeze({
    ...executed,
    ...(control.receipts.length === 0
      ? {}
      : { randomChoices: Object.freeze([...control.receipts]) }),
    ...(control.refusal === null ? {} : { randomRefusal: control.refusal }),
  });
}

/**
 * Resolves the paused draw and finishes the operation it interrupted: the unit it belongs to executes again from its
 * start and takes the resolution at the draw, then the operation continues with its own budget. `natural` keeps the
 * natural result, which is no host input; an outcome is a chosen input with a receipt. A request that does not fit
 * the paused draw changes nothing.
 */
export function resumeRandomDraw(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  request: unknown,
  capabilities: RuntimeCapabilities = {},
  options: Pick<RuntimeRunOptions, "debugTrace" | "instructionTrace" | "randomControl"> = {},
): PendingActionOperationResult<RandomDrawResolutionOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  const policy = randomPolicyFor(captured.plan, options, capabilities);
  return withDebugTrace(options.debugTrace, captured.plan, snapshot, (trace) =>
    resumeCaptured(captured.plan, captured.snapshot, request, capabilities, options, trace, policy),
  );
}

/** Resolves the paused draw of engine-owned plan/state that already passed complete validation. */
export function resumeValidatedRandomDraw(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  request: unknown,
  capabilities: RuntimeCapabilities = {},
  options: Pick<
    ValidatedRunOptions,
    "debugTrace" | "instructionTrace" | "randomControl" | "randomPolicy" | "instructionObserver"
  > = {},
): PendingActionOperationResult<RandomDrawResolutionOutcome> {
  const policy = randomPolicyFor(plan, options, capabilities);
  return withDebugTrace(options.debugTrace, plan, snapshot, (trace) =>
    resumeCaptured(
      plan,
      snapshot,
      request,
      capabilities,
      options,
      trace,
      policy,
      options.instructionObserver,
    ),
  );
}

function resumeCaptured(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  request: unknown,
  capabilities: RuntimeCapabilities,
  options: Pick<RuntimeRunOptions, "instructionTrace">,
  trace: TraceStore | null,
  policy: RandomPolicy | null,
  observer: RuntimeInstructionObserver | undefined = undefined,
): PendingActionOperationResult<RandomDrawResolutionOutcome> {
  const pending = snapshot.randomControl?.pending ?? null;
  if (pending === null) return pendingResult(snapshot, [], { kind: "noPendingDraw" } as const);
  const resolution = randomDrawRequest(request, pending);
  if (typeof resolution === "string")
    return pendingResult(snapshot, [], { kind: "invalidOutcome", message: resolution } as const);
  if (resolution.drawId !== pending.draw.drawId)
    return pendingResult(snapshot, [], { kind: "staleDraw", drawId: pending.draw.drawId } as const);
  if (capabilities.random !== undefined)
    throw new TypeError(
      "A paused random draw resumes with the session generator, so capabilities.random must not be injected.",
    );
  // A state whose history chose nothing is the state natural draws give.
  const forcedChoices = snapshot.randomControl!.forcedChoices;
  snapshot.randomControl = forcedChoices === 0 ? null : { forcedChoices, pending: null };
  const control = new RandomControl(plan, policy, trace, {
    forced: new Map(pending.forced.map((entry) => [entry.drawId, entry.outcome])),
    builtinResults: pending.builtinResults,
    pending: pending.draw,
    resolution: resolution.outcome,
  });
  const context = new RuntimeExecutionContext(
    snapshot,
    capabilities,
    plan,
    trace,
    instructionTraceFor(plan, options),
    control,
    observer ?? null,
  );
  const progress = startProgress(snapshot, pending.instructionsUsed ?? 0);
  const budget = pending.instructionBudget;
  try {
    // The observer saw the paused instruction start before the draw paused it.
    if (pending.unit === "instruction")
      executeCapturedInstruction(plan, snapshot, context, progress, false);
    else processDueWork(plan, snapshot, context.events, trace, control);
    control.assertReplayDone();
    if (pending.root === "run" || (pending.root === "stepToEvent" && !pending.eventsBefore))
      runInstructions(plan, snapshot, context, progress, budget!, pending.root === "stepToEvent");
  } catch (error) {
    if (error instanceof RandomReplayDivergence)
      throw new RuntimeDataError("TSR101", error.message);
    if (!(error instanceof RandomSuspension)) throw error;
    pauseAtDraw(
      snapshot,
      error,
      pending.root,
      budget,
      budgetUsed(snapshot, progress),
      pending.eventsBefore || context.events.length > 0,
    );
  }
  return Object.freeze({
    ...controlledResult(snapshot, context, progress.executed),
    outcome: Object.freeze({ kind: "resolved", forced: resolution.outcome !== "natural" } as const),
  });
}

/** The request's draw ID and resolution, or why it is malformed or does not fit the paused draw. */
function randomDrawRequest(
  request: unknown,
  pending: RuntimePendingRandomDrawSnapshot,
): { readonly drawId: number; readonly outcome: "natural" | RandomOutcome } | string {
  const captured = captureExternalData(request);
  if (!captured.ok || !isPlainRecord(captured.value))
    return 'A random draw request is { drawId, outcome }, with outcome "natural" or a chosen outcome.';
  const { drawId, outcome } = captured.value;
  if (typeof drawId !== "number")
    return 'A random draw request is { drawId, outcome }, with outcome "natural" or a chosen outcome.';
  if (outcome === "natural") return { drawId, outcome };
  const checked = checkedOutcome(pending.draw.support, outcome);
  return typeof checked === "string" ? checked : { drawId, outcome: checked };
}

function executePlannedInstruction(
  plan: InstructionPlan,
  instruction: Instruction,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  switch (instruction.kind) {
    case "declareGlobal": {
      if (evaluator.binding(instruction.name) !== undefined) {
        throw fault(
          "TSR001",
          internalFault(`The plan sets up global '${instruction.name}' twice.`),
          instruction.span,
        );
      }
      const value = evaluator.evaluateStartValue(
        { kind: "global", name: instruction.name },
        instruction.value,
      );
      if (instruction.typeCheck !== undefined)
        assertValueType(value, instruction.typeCheck, instruction.value.span);
      snapshot.globals.push({
        name: instruction.name,
        value: cloneCapturedSerializableValue(value),
      });
      evaluator.trace?.writeBinding("declaration", GLOBAL_SCOPE_ID, instruction.name, value);
      advance(snapshot);
      return;
    }
    case "declareSpeaker":
      executeDeclareSpeaker(instruction, snapshot, evaluator, events);
      return;
    case "setDefaultSpeaker": {
      const speaker = evaluator.speakerByName(instruction.name, instruction.span);
      snapshot.defaultSpeaker = speaker.id;
      advance(snapshot);
      return;
    }
    case "copyAccount":
      evaluator.copyAccount(copySpan(instruction.span));
      advance(snapshot);
      return;
    case "enterScope":
      assertCounterCanAdvance(snapshot.nextScopeId, "nextScopeId");
      snapshot.frames.push({ id: snapshot.nextScopeId, file: null, entry: null, bindings: [] });
      snapshot.nextScopeId += 1;
      advance(snapshot);
      return;
    case "leaveScope":
      if (currentFrame(snapshot).file !== null) {
        throw fault(
          "TSR033",
          internalFault("The plan tries to leave its outermost scope."),
          instruction.span,
        );
      }
      leaveScopes(snapshot, snapshot.frames.length - 1);
      advance(snapshot);
      return;
    case "declareBinding": {
      // A goto back to an earlier label runs a top-level `let` again, which sets its existing variable anew.
      const rerun = rerunsTopLevelDeclaration(snapshot, instruction.name);
      if (!rerun && evaluator.binding(instruction.name) !== undefined) {
        throw fault(
          "TSR001",
          internalFault(
            `The plan declares variable '${instruction.name}' twice in the same scope.`,
          ),
          instruction.span,
        );
      }
      const value = evaluator.evaluate(instruction.value);
      if (instruction.typeCheck !== undefined)
        assertValueType(value, instruction.typeCheck, instruction.value.span);
      if (rerun) {
        const root = currentFrame(snapshot);
        const binding = root.bindings.find((item) => item.name === instruction.name)!;
        detachPreparedReferencesForMutation(snapshot, {
          rootFrameId: root.id,
          rootName: instruction.name,
          path: [],
        });
        binding.value = cloneCapturedSerializableValue(value);
      } else {
        currentFrame(snapshot).bindings.push({
          name: instruction.name,
          value: cloneCapturedSerializableValue(value),
        });
      }
      evaluator.trace?.writeBinding(
        "declaration",
        currentFrame(snapshot).id,
        instruction.name,
        value,
      );
      advance(snapshot);
      return;
    }
    case "prepareReference": {
      const { reference, value } = evaluator.prepareReference(
        instruction.expression,
        snapshotValidationAnalysis(plan).preparedReferenceTemporaries.get(
          instruction.destinationTemporary,
        ) === true,
      );
      setCapturedTemporary(snapshot.temporaries, instruction.destinationTemporary, reference);
      if (evaluator.trace !== null) {
        // Debug explains the value the reference selected while it was prepared, as it explains a temporary that holds
        // that value. Resolving the reference again could draw a random element a second time.
        if (
          instruction.expression.kind === "temporary" ||
          instruction.expression.kind === "identifier"
        )
          evaluator.trace.copyTemporary(
            evaluator.callFrameId(),
            instruction.destinationTemporary,
            value,
          );
        else
          evaluator.trace.writeTemporary(
            evaluator.callFrameId(),
            instruction.destinationTemporary,
            value,
          );
      }
      advance(snapshot);
      return;
    }
    case "validateAssignmentTarget":
      evaluator.validateAssignmentTarget(instruction.target);
      advance(snapshot);
      return;
    case "assign": {
      if (!evaluator.appendAssigned(instruction.target, instruction.value, instruction.typeCheck)) {
        const value = evaluator.evaluate(instruction.value);
        if (instruction.typeCheck !== undefined)
          assertValueType(value, instruction.typeCheck, instruction.value.span);
        evaluator.assign(instruction.target, value);
      }
      advance(snapshot);
      return;
    }
    case "validateCallReceiver":
      evaluator.validateCallReceiver(
        evaluator.evaluate(instruction.receiver),
        instruction.method,
        instruction.span,
      );
      advance(snapshot);
      return;
    case "evaluate":
      evaluator.evaluate(instruction.expression);
      advance(snapshot);
      return;
    case "jumpIfFalse": {
      const condition = evaluator.evaluate(instruction.condition);
      if (typeof condition !== "boolean") {
        throw notBoolean(
          "A condition must be true or false (boolean)",
          instruction.condition,
          condition,
          instruction.condition.span,
          plan,
        );
      }
      evaluator.trace?.branch(condition, instruction.target, instruction.span);
      snapshot.nextInstruction = condition ? snapshot.nextInstruction + 1 : instruction.target;
      return;
    }
    case "jump":
      snapshot.nextInstruction = instruction.target;
      return;
    case "loopStart":
      executeLoopStart(plan, instruction, snapshot, evaluator);
      return;
    case "loopControl":
      executeLoopControl(instruction, snapshot);
      return;
    case "storeTemporary": {
      if (instruction.defaultTemporary !== undefined) {
        // The call or load without its default: the instructions after it run the default only when it is needed.
        const probed = evaluator.evaluateWithoutDefault(instruction.value);
        const needed = probed === USE_DEFAULT;
        const value = needed ? null : probed;
        setCapturedTemporary(snapshot.temporaries, instruction.temporaryId, value);
        setCapturedTemporary(snapshot.temporaries, instruction.defaultTemporary, needed);
        if (evaluator.trace !== null) {
          const frame = evaluator.callFrameId();
          evaluator.trace.writeTemporary(frame, instruction.temporaryId, value);
          evaluator.trace.writeTemporary(frame, instruction.defaultTemporary, needed);
        }
        advance(snapshot);
        return;
      }
      let value = evaluator.evaluate(instruction.value);
      // Only the operands of a lowered 'and' or 'or' expect true or false.
      if (instruction.expectBoolean && typeof value !== "boolean")
        throw notLogicalOperand(
          loweredLogicalOperator(plan, instruction.temporaryId),
          instruction.value,
          value,
          plan,
        );
      if (instruction.defaultOf !== undefined)
        value = acceptedDefault(
          instruction.defaultOf,
          value,
          instruction.typeCheck,
          instruction.value.span,
        );
      else if (instruction.typeCheck !== undefined)
        assertValueType(value, instruction.typeCheck, instruction.value.span);
      setCapturedTemporary(snapshot.temporaries, instruction.temporaryId, value);
      if (evaluator.trace !== null) {
        const copied =
          instruction.value.kind === "temporary" || instruction.value.kind === "identifier";
        if (copied)
          evaluator.trace.copyTemporary(evaluator.callFrameId(), instruction.temporaryId, value);
        else
          evaluator.trace.writeTemporary(evaluator.callFrameId(), instruction.temporaryId, value);
      }
      advance(snapshot);
      return;
    }
    case "prepareSaySpeaker":
      executePrepareSaySpeaker(instruction, snapshot, evaluator, events);
      return;
    case "prepareSayText":
      executePrepareSayText(instruction, snapshot, evaluator);
      return;
    case "prepareSayContextualSpeaker":
      executePrepareSayContextualSpeaker(instruction, snapshot, evaluator);
      return;
    case "prepareInteractionSpeaker":
      executePrepareInteractionSpeaker(instruction, snapshot, evaluator);
      return;
    case "clearTemporary": {
      const index = snapshot.temporaries.findIndex(
        (temporary) => temporary.id === instruction.temporaryId,
      );
      if (index >= 0) snapshot.temporaries.splice(index, 1);
      advance(snapshot);
      return;
    }
    case "clearTemporaries": {
      const temporaryIds = new Set(instruction.temporaryIds);
      for (let index = snapshot.temporaries.length - 1; index >= 0; index -= 1) {
        if (temporaryIds.has(snapshot.temporaries[index]!.id)) {
          snapshot.temporaries.splice(index, 1);
        }
      }
      advance(snapshot);
      return;
    }
    case "callFunction":
      enterFunction(plan, instruction, snapshot, evaluator);
      return;
    case "bindSuppliedParameter":
      bindSuppliedParameter(plan, instruction, snapshot, evaluator.trace);
      return;
    case "beginFunctionDefaults":
      beginFunctionDefaults(plan, instruction.functionId, snapshot, instruction.span);
      return;
    case "prepareParameterDefault":
      prepareParameterDefault(plan, instruction, snapshot);
      return;
    case "bindDefaultParameter":
      bindDefaultParameter(plan, instruction, snapshot, evaluator);
      return;
    case "enterFunctionBody":
      enterFunctionBody(plan, instruction.functionId, snapshot, instruction.span);
      return;
    case "returnValue": {
      const value = evaluator.evaluate(instruction.value);
      if (instruction.typeCheck !== undefined)
        assertValueType(value, instruction.typeCheck, instruction.value.span);
      returnFromFunction(plan, snapshot, value, instruction.span, events, evaluator);
      return;
    }
    case "returnVoid":
      returnFromFunction(plan, snapshot, null, instruction.span, events, evaluator);
      return;
    case "say": {
      executeSayAtomically(instruction, snapshot, evaluator, events);
      return;
    }
    case "wait":
      executeWait(instruction, snapshot, evaluator, events);
      return;
    case "interaction":
      executeInteraction(instruction, snapshot, evaluator, events);
      return;
    case "capture":
      executeCapture(instruction, snapshot, evaluator, events);
      return;
    case "fileStore":
      executeFileStore(instruction, snapshot, evaluator, events);
      return;
    case "lock":
      executeLock(instruction, snapshot, evaluator, events);
      return;
    case "startTimer":
      startTimer(instruction, snapshot, evaluator, events);
      return;
    case "exit":
      stopAllTimersForSessionEnd(snapshot);
      stopAllMediaForSessionEnd(snapshot);
      if (snapshot.cameraView !== null) snapshot.cameraView.shown = false;
      snapshot.backgroundActions.length = 0;
      snapshot.defaultSpeaker = null;
      snapshot.contextualSpeaker = null;
      snapshot.frames.splice(1);
      snapshot.loopFrames.length = 0;
      snapshot.callFrames.length = 0;
      snapshot.retainedScopes.length = 0;
      snapshot.fallback = null;
      snapshot.temporaries.length = 0;
      snapshot.status = "halted";
      snapshot.nextInstruction += 1;
      events.push(
        Object.freeze({
          kind: "exit",
          sequence: takeSequence(snapshot),
          span: copySpan(instruction.span),
        } satisfies ExitEvent),
      );
      return;
    case "showImage":
      showImage(plan, instruction, snapshot, evaluator, events);
      return;
    case "showCamera":
      executeShowCamera(instruction, snapshot, evaluator);
      return;
    case "hideCamera":
      executeHideCamera(snapshot, evaluator);
      return;
    case "showPermanentButton":
      showPermanentButton(instruction, snapshot, evaluator, events);
      return;
    case "storageWrite":
      writeStorage(plan, instruction, snapshot, evaluator, events);
      return;
    case "playMedia":
      startMedia(plan, instruction, snapshot, evaluator, events);
      return;
    case "stopAudio":
      executeStopAudio(plan, instruction, snapshot, evaluator, events);
      return;
    case "goto":
      executeGoto(instruction, snapshot, contextRootId(snapshot), events);
      return;
    case "transfer":
      executeTransfer(plan, instruction, snapshot, evaluator, events);
      return;
    case "end":
      executeEnd(plan, instruction, snapshot, events, evaluator.trace, evaluator.control);
      return;
    case "setFallback":
      executeSetFallback(plan, instruction, snapshot, evaluator);
      return;
  }
  instruction satisfies never;
}

/** Whether top-level code declares a name that its activation's root already has, as after a goto back. */
function rerunsTopLevelDeclaration(snapshot: RuntimeSnapshot, name: string): boolean {
  const frame = currentFrame(snapshot);
  return frame.file !== null && frame.bindings.some((binding) => binding.name === name);
}

/** Fails the session; `path` is the project file whose source the failure's span is in. */
function failSnapshot(
  snapshot: RuntimeSnapshot,
  failure: RuntimeErrorInfo,
  path: string,
  events: InterpreterEvent[],
): void {
  const failureSequence = takeSequence(snapshot);
  snapshot.status = "failed";
  // A failed session is terminal; no foreground action stays pending.
  snapshot.foregroundAction = null;
  snapshot.failure = {
    code: failure.code,
    message: failure.message,
    path,
    span: copySpan(failure.span),
  };
  events.push(
    Object.freeze({
      kind: "runtimeFailure",
      sequence: failureSequence,
      code: failure.code,
      message: failure.message,
      path,
      span: copySpan(failure.span),
    } satisfies RuntimeFailureEvent),
  );
}

/**
 * Fails at the innermost loop of the running call, the likely cause; otherwise, as while waiting between timer blocks,
 * at the next instruction. The budget counts everything the operation executed at this scene time, including earlier
 * loops and timer blocks, so the message names the limit rather than the work of that loop.
 */
function failForBudget(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  events: InterpreterEvent[],
  budget: number,
): void {
  const loop = snapshot.loopFrames.at(-1);
  const loopStart =
    snapshot.status === "running" && loop?.callFrameId === currentCallFrameId(snapshot)
      ? plan.instructions.findIndex(
          (instruction) => instruction.kind === "loopStart" && instruction.loopId === loop.loopId,
        )
      : -1;
  const index = loopStart === -1 ? snapshot.nextInstruction : loopStart;
  const span = plan.instructions[index]?.span ?? mainSourceSpan(plan);
  // Thousands separators without the host locale keep the message deterministic.
  const steps = String(budget).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const message =
    loopStart === -1
      ? `The script reached its ${steps}-step limit. Add a wait, or check for code that repeats without end.`
      : `The script reached its ${steps}-step limit while running this loop. Add a wait, or check the loop's condition.`;
  failSnapshot(
    snapshot,
    { code: "TSR037" satisfies RuntimeErrorCode, message, span: copySpan(span) },
    instructionSourcePath(plan, index),
    events,
  );
}

export function instructionBudget(value: number | undefined): number {
  const budget = value ?? 1_000_000;
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new RangeError("Instruction budget must be a positive safe integer.");
  }
  return budget;
}
