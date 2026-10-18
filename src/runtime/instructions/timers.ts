import { exactDurationMilliseconds } from "../temporal-operations.js";
import { resolveCaptures } from "../captures.js";
import type { DelayDisplay, DurationUnitPlan, Instruction } from "../../plan/model.js";
import { rangeStartProblem, rangeText } from "../../range-checks.js";
import { UNIT_AMOUNT_RULE, unitAmountFix } from "../../operand-rules.js";
import {
  isDelayLength,
  isRoundLength,
  negativeDelayMessage,
  sceneTimeMessage,
  unmeasurableLengthMessage,
  zeroRoundMessage,
} from "../../delay-rules.js";
import { isTimerDisplay, timerDisplayMessage } from "../../handle-rules.js";
import type { Evaluator } from "../evaluator.js";
import { internalFault } from "../errors.js";
import {
  assertCounterCanAdvance,
  assertEventSequenceCapacity,
  requiredFutureActionCompletionEvents,
  setCapturedTemporary,
  takeSequence,
} from "../operations/support.js";
import { contextRootId } from "../activations.js";
import type { ActionRequestedEvent, InterpreterEvent } from "../events.js";
import type { SerializableRuntimeValue } from "../serializable-values.js";
import { type RuntimeSnapshot, MAX_RUNTIME_SESSION_TIME_MS } from "../state.js";
import { ACTION_COMPLETION_EVENTS, type RuntimeTimerActionSnapshot } from "../actions/model.js";
import { isValidSessionTime } from "../actions/delay.js";
import { expireTimerAction } from "../operations/timer-lifecycle.js";
import { cloneTimer } from "../timers.js";
import { describeShownValue, shownChoice } from "../value-types.js";
import { isAnyDuration, isDuration, isList, isRange } from "../value-predicates.js";
import { DURATION_UNIT_MILLISECONDS } from "../../duration.js";
import { advance, durationFix, fault, type SourceSpan } from "./support.js";
import { copySpan } from "../../plan/source-location.js";

// Waits and timers, with their durations, deadlines, labels, and displays.

export function executeWait(
  instruction: Extract<Instruction, { kind: "wait" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  const evaluated = evaluator.evaluate(instruction.duration);
  const display =
    typeof instruction.display === "string"
      ? instruction.display
      : timerDisplay(evaluator.evaluate(instruction.display), instruction.display.span);
  const label =
    instruction.label === null
      ? null
      : timerLabel(evaluator.evaluate(instruction.label), instruction.label.span);
  const durationMs = timerDurationMs(
    evaluator,
    evaluated,
    instruction.unit,
    instruction.command,
    instruction.duration.span,
  );
  const deadlineMs = futureDeadline(
    snapshot,
    durationMs,
    instruction.command,
    instruction.duration.span,
  );
  if (durationMs === 0) {
    advance(snapshot);
    return;
  }
  if (
    !Number.isSafeInteger(snapshot.nextActionId) ||
    snapshot.nextActionId >= Number.MAX_SAFE_INTEGER
  ) {
    throw fault(
      "TSR051",
      internalFault("The session has used up its action numbers."),
      instruction.span,
    );
  }
  // The wait's request and its completion.
  assertEventSequenceCapacity(snapshot, 1 + ACTION_COMPLETION_EVENTS.delay, instruction.span);
  const sequence = takeSequence(snapshot);
  const action = Object.freeze({
    kind: "delay" as const,
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    continuationInstruction: snapshot.nextInstruction + 1,
    ownerCallFrameId: snapshot.callFrames.at(-1)?.id ?? null,
    scopeDepth: snapshot.frames.length,
    loopDepth: snapshot.loopFrames.length,
    createdAtMs: snapshot.currentSessionTimeMs,
    deadlineMs,
    expectedCompletion: "time" as const,
    display,
    label,
    requestEventSequence: sequence,
  });
  snapshot.nextActionId += 1;
  snapshot.foregroundAction = action;
  snapshot.status = "waiting";
  events.push(
    Object.freeze({
      kind: "actionRequested",
      sequence,
      action: { ...action },
      span: copySpan(instruction.span),
    } satisfies ActionRequestedEvent),
  );
}

/**
 * Converts an evaluated `wait`/`timer` duration to milliseconds: a duration value, or a number of the `unit` after it
 * or a range of whole such units, drawn once from the session RNG. A number without a unit is no time. Invalid ranges
 * fail before the draw.
 */
function timerDurationMs(
  evaluator: Evaluator,
  value: SerializableRuntimeValue,
  unit: DurationUnitPlan | null,
  command: "wait" | "timer",
  span: SourceSpan,
): number {
  const range = isRange(value) && unit !== null ? value : null;
  const below =
    range === null
      ? null
      : rangeStartProblem(command, false, range.start, unit!, `this range is ${rangeText(range)}`);
  if (below !== null) throw fault("TSR050", below, span);
  const drawn =
    range === null
      ? value
      : evaluator.randomIntegerInRange(range, span, `A ${command}`, "duration");
  const amount =
    isAnyDuration(drawn) && unit === null
      ? exactDurationMilliseconds(drawn, command === "timer" ? "A timer" : "'wait'", span)
      : drawn;
  if (isRange(drawn))
    throw fault(
      "TSR050",
      `A ${command} takes a duration, but this is the range ${rangeText(drawn)}. Give the range a unit, such as '(${rangeText(drawn)}) s'.`,
      span,
    );
  // The unit after the duration is kept apart for a range, but the amount before it is a number as before any unit.
  if (unit !== null && typeof drawn !== "number")
    throw fault(
      "TSR027",
      `${UNIT_AMOUNT_RULE}, but this is ${describeShownValue(drawn)}.${unitAmountFix(unit, isAnyDuration(drawn))}`,
      span,
    );
  if (
    typeof amount !== "number" ||
    (unit === null && !isDuration(drawn)) ||
    !Number.isFinite(amount) ||
    !isDelayLength(amount)
  ) {
    throw fault(
      "TSR050",
      typeof amount === "number" && !isDelayLength(amount) && (unit !== null || isDuration(drawn))
        ? negativeDelayMessage(command, describeShownValue(drawn))
        : `A ${command} takes a duration, but this is ${describeShownValue(drawn)}. ${durationFix(drawn, "30 s")}`,
      span,
    );
  }
  const durationMs = isDuration(drawn) ? amount : amount * DURATION_UNIT_MILLISECONDS[unit!];
  if (!Number.isFinite(durationMs)) {
    throw fault("TSR050", sceneTimeMessage(command), span);
  }
  return durationMs;
}

/** Absolute deadline for a positive duration; `0` stays immediate. */
function futureDeadline(
  snapshot: RuntimeSnapshot,
  durationMs: number,
  command: "wait" | "timer",
  span: SourceSpan,
  repeat = false,
): number {
  // At the last scene time, no positive duration has a later deadline. A timer of 0 s keeps its handle, but a
  // repeating timer cannot have one.
  if (durationMs > 0 && snapshot.currentSessionTimeMs === MAX_RUNTIME_SESSION_TIME_MS) {
    throw fault(
      "TSR050",
      `Scene time has reached its limit, so this ${command} cannot run. ${command === "wait" || repeat ? "Remove it." : "Remove it, or set its duration to 0 s."}`,
      span,
    );
  }
  const deadlineMs = snapshot.currentSessionTimeMs + durationMs;
  if (!isValidSessionTime(deadlineMs)) {
    throw fault("TSR050", sceneTimeMessage(command), span);
  }
  if (durationMs > 0 && deadlineMs <= snapshot.currentSessionTimeMs) {
    throw fault(
      "TSR050",
      unmeasurableLengthMessage(
        `This ${command}`,
        durationMs,
        snapshot.currentSessionTimeMs,
        "duration",
      ),
      span,
    );
  }
  return deadlineMs;
}

function timerLabel(value: SerializableRuntimeValue, span: SourceSpan): string {
  if (isList(value))
    throw fault(
      "TSR050",
      'A list cannot be a timer label. Select one element with "${list}" or list.random.',
      span,
    );
  if (typeof value !== "string")
    throw fault(
      "TSR050",
      `A timer label must be text (string), but this is ${describeShownValue(value)}. Convert it with toString(...) first.`,
      span,
    );
  return value;
}

/**
 * Starts an asynchronous timer as background timed work and, when used as a value, stores its handle. Operands are
 * evaluated in plan order before a range is drawn. A zero first round expires at once and queues its expiry block.
 */
export function startTimer(
  instruction: Extract<Instruction, { kind: "startTimer" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  const duration = evaluator.evaluate(instruction.duration);
  const display =
    typeof instruction.display === "string"
      ? instruction.display
      : timerDisplay(evaluator.evaluate(instruction.display), instruction.display.span);
  const label =
    instruction.label === null
      ? null
      : timerLabel(evaluator.evaluate(instruction.label), instruction.label.span);
  const unit = instruction.unit;
  const range = instruction.repeat && isRange(duration) && unit !== null ? duration : null;
  // A range that allows a zero-length round is rejected before its first round is drawn.
  const zeroRange =
    range === null
      ? null
      : rangeStartProblem("timer", true, range.start, unit!, `this range is ${rangeText(range)}`);
  if (zeroRange !== null) throw fault("TSR050", zeroRange, instruction.duration.span);
  const roundDurationMs = timerDurationMs(
    evaluator,
    duration,
    instruction.unit,
    "timer",
    instruction.duration.span,
  );
  if (instruction.repeat && !isRoundLength(roundDurationMs))
    throw fault(
      "TSR050",
      zeroRoundMessage(describeShownValue(duration)),
      instruction.duration.span,
    );
  const deadlineMs = futureDeadline(
    snapshot,
    roundDurationMs,
    "timer",
    instruction.duration.span,
    instruction.repeat,
  );
  if (
    !Number.isSafeInteger(snapshot.nextActionId) ||
    snapshot.nextActionId >= Number.MAX_SAFE_INTEGER
  ) {
    throw fault(
      "TSR051",
      internalFault("The session has used up its action numbers."),
      instruction.span,
    );
  }
  assertCounterCanAdvance(snapshot.nextTimerId, "nextTimerId");
  // The request, its eventual settlement, and the other active actions' completions must stay representable.
  assertEventSequenceCapacity(
    snapshot,
    1 + ACTION_COMPLETION_EVENTS.timer + requiredFutureActionCompletionEvents(snapshot),
    instruction.span,
  );
  const timerId = snapshot.nextTimerId;
  const captures = resolveCaptures(snapshot, instruction.captures, instruction.span);
  const sequence = takeSequence(snapshot);
  const action: RuntimeTimerActionSnapshot = {
    kind: "timer",
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    createdAtMs: snapshot.currentSessionTimeMs,
    requestEventSequence: sequence,
    timer: {
      timerId,
      state: "running",
      display,
      label,
      repeat: instruction.repeat,
      persist: instruction.persist,
      handlerFunctionId: instruction.handlerFunctionId,
      rootScopeId: contextRootId(snapshot),
      captures,
      range:
        range === null || unit === null
          ? null
          : { start: range.start, end: range.end, inclusive: range.inclusive, unit },
      repeatDurationMs: instruction.repeat && range === null ? roundDurationMs : null,
      roundDurationMs,
      deadlineMs,
      remainingMs: null,
      elapsedMs: 0,
      runningSinceMs: snapshot.currentSessionTimeMs,
      anchoredRounds: instruction.repeat && range === null ? 0 : null,
      overrunReported: false,
    },
  };
  snapshot.nextActionId += 1;
  snapshot.nextTimerId += 1;
  snapshot.backgroundActions.push(action);
  if (instruction.destinationTemporary !== null) {
    const handle = { kind: "timerHandle" as const, timerId };
    setCapturedTemporary(snapshot.temporaries, instruction.destinationTemporary, handle);
    evaluator.trace?.writeTemporary(
      evaluator.callFrameId(),
      instruction.destinationTemporary,
      handle,
    );
  }
  events.push(
    Object.freeze({
      kind: "actionRequested",
      sequence,
      action: { ...action, timer: cloneTimer(action.timer) },
      span: copySpan(instruction.span),
    } satisfies ActionRequestedEvent),
  );
  if (roundDurationMs === 0) {
    expireTimerAction(
      snapshot,
      action,
      snapshot.currentSessionTimeMs,
      copySpan(instruction.span),
      events,
      evaluator.trace,
      evaluator.control,
    );
  }
  advance(snapshot);
}

function timerDisplay(value: SerializableRuntimeValue, span: SourceSpan): DelayDisplay {
  if (isTimerDisplay(value)) return value;
  throw fault("TSR050", timerDisplayMessage(shownChoice(value)), span);
}
