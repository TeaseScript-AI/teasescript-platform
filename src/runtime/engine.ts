import { exactDurationMilliseconds } from "./temporal-operations.js";
import { leaveScopes, resolveCaptures } from "./captures.js";
import { resolveMessagePresentation } from "./message-presentation.js";
import type { MessagePresentation } from "../message-presentation.js";
import type { TemporalContext } from "../temporal.js";
import {
  type DelayDisplay,
  type DurationUnitPlan,
  type Instruction,
  type InstructionPlan,
  type InteractionAccessibleName,
  type InteractionTemporalKind,
  type InteractionUiPayload,
  type PlanSourceLocation,
  type PlanTag,
  type PreparedInteractionUiPayload,
  instructionSourcePath,
  mainSourceSpan,
} from "../plan/model.js";
import { addTag, readTagText, type Tag } from "../tags.js";
import { cloneMessageMarkup, parseMessageMarkup, type MessageMarkup } from "../message-markup.js";
import { isBlankTextAnswer, numberAnswerText, temporalAnswerText } from "../interaction-answers.js";
import {
  boundedInteractionUtf8ByteLength,
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
} from "../interaction-limits.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import {
  type Evaluator,
  findBinding,
  RuntimeExecutionContext,
  type RuntimeCapabilities,
} from "./evaluator.js";
export type {
  RuntimeBuiltinFunction,
  RuntimeCapabilities,
  RuntimeCapabilityCall,
} from "./evaluator.js";
import { RuntimeFault, type RuntimeErrorInfo } from "./errors.js";
import {
  assertCounterCanAdvance,
  assertEventSequenceCapacity,
  captureExecutableData,
  copySpan,
  requiredFutureActionCompletionEvents,
  result,
  setCapturedTemporary,
  takeSequence,
} from "./operations/support.js";
import type { RuntimeOperationResult } from "./operations/model.js";
import {
  executeEnd,
  executeGoto,
  executeSetFallback,
  executeTransfer,
} from "./operations/transfers.js";
import { activeFunctionFrame, contextRootId, interruptRunning } from "./activations.js";
import {
  bindingKey,
  closeDebugTrace,
  loopKey,
  stateKey,
  openDebugTrace,
  type DebugDependencies,
  type RuntimeDebugContext,
  type TraceStore,
} from "./debug-trace.js";
import { detachPreparedReferencesForMutation, GLOBAL_SCOPE_ID } from "./prepared-references.js";
export type {
  ActionCompletionOutcome,
  PendingActionOperationResult,
  RuntimeOperationResult,
  TimeObservationOutcome,
} from "./operations/model.js";
export { RuntimeDataError } from "./operations/support.js";
import type {
  ActionRequestedEvent,
  ExitEvent,
  InterpreterEvent,
  OutputSpeaker,
  RuntimeFailureEvent,
  SayEvent,
} from "./events.js";
import {
  assertPersistable,
  storageKey,
  WRITE_KEY_MESSAGE,
  writeScriptStorage,
} from "./script-storage.js";
import {
  cloneCapturedSerializableValue,
  createCapturedSerializableList,
  createCapturedSerializableObject,
  getSerializableProperty,
  type SerializableRuntimeDict,
  type SerializableRuntimeList,
  type SerializableRuntimeRange,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
} from "./serializable-values.js";
import {
  cloneCapturedRuntimeSnapshot,
  type RuntimeBindingSnapshot,
  type RuntimeSnapshot,
  type RuntimeSpeakerSnapshot,
  type RuntimeLoopFrameSnapshot,
  type RuntimeCallFrameSnapshot,
  type RuntimeTemporarySnapshot,
  currentTemporalContext,
} from "./state.js";
import type {
  RuntimeCaptureActionSnapshot,
  RuntimeChatPacingGateActionSnapshot,
  RuntimeInteractionActionSnapshot,
  RuntimePreparedSayOutputSnapshot,
  RuntimeTimerActionSnapshot,
  RuntimeMediaActionSnapshot,
  RuntimePermanentButtonActionSnapshot,
  RuntimeMediaPlaybackActionSnapshot,
  RuntimeStorageWriteActionSnapshot,
} from "./actions/model.js";
import { isValidSessionTime } from "./actions/delay.js";
import {
  buttonTimeoutMilliseconds,
  cloneImageUi,
  imageRequestValue,
} from "./actions/interaction.js";
import {
  emptyImageFilterMessage,
  IMAGE_NO_SOURCE_MESSAGE,
  imageFilterTextProblem,
} from "../image-input.js";
import {
  calculatePacingDeadlineMs,
  calculateSmartPacingDurationMs,
  secondsToPacingMilliseconds,
} from "./actions/pacing.js";
import { settleBackgroundPacingGate } from "./operations/pacing-gate.js";
import { normalizeOpaqueColor } from "../color.js";
import {
  returnFromTimerHandler,
  startTimerHandler,
  timerHandlerDispatchable,
} from "./operations/timer-handlers.js";
import { expireTimerAction, stopAllTimersForSessionEnd } from "./operations/timer-lifecycle.js";
import {
  emitDeveloperWarning,
  stopAllMediaForSessionEnd,
  stopMediaAction,
  stopStageVideo,
} from "./operations/media-lifecycle.js";
import { cloneMedia, type RuntimeMediaRepeatSnapshot } from "./media.js";
import { executionRunnable, processDueWork } from "./operations/observe-time.js";
import { cloneTimer } from "./timers.js";
import { assertValueType } from "./value-types.js";
import {
  describeRuntimeValue,
  isDate,
  isDateTime,
  isDict,
  isDuration,
  isList,
  isObject,
  isRange,
  isSet,
  isMediaHandle,
  isCameraView,
  isSpeakerReference,
  isTime,
} from "./value-predicates.js";
import { fieldText } from "./value-text.js";
import { expandChoiceOptions } from "./choice-options.js";
import { cloneInteractionChoiceValue } from "../choice-values.js";
import { DURATION_UNIT_MILLISECONDS } from "../duration.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

export interface RuntimeRunOptions {
  readonly instructionBudget?: number;
  /** An opt-in debug trace that observes the operation (`docs/RUNTIME.md#debug-trace`). */
  readonly debugTrace?: RuntimeDebugContext;
}

export function executeInstruction(
  plan: InstructionPlan,
  inputSnapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: Pick<RuntimeRunOptions, "debugTrace"> = {},
): RuntimeOperationResult {
  const captured = captureExecutableData(plan, inputSnapshot);
  const trace = openDebugTrace(options.debugTrace, captured.plan, inputSnapshot);
  const context = new RuntimeExecutionContext(
    captured.snapshot,
    capabilities,
    captured.plan,
    trace,
  );
  const instructionsExecuted = executeCapturedInstruction(
    captured.plan,
    captured.snapshot,
    context,
  );
  const executed = result(captured.snapshot, context.events, instructionsExecuted);
  closeDebugTrace(trace, executed);
  return executed;
}

/**
 * Executes one instruction boundary. Once execution waits or ends, scene time continues toward the already observed
 * time, which may make a later deadline's work runnable at that deadline.
 */
function executeCapturedInstruction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  context: RuntimeExecutionContext,
): number {
  const executed = executeInstructionBoundary(plan, snapshot, context);
  if (
    snapshot.status !== "failed" &&
    // Work due exactly at the observed time also settles once execution waits or ends.
    snapshot.currentSessionTimeMs <= snapshot.observedSessionTimeMs &&
    !executionRunnable(snapshot)
  ) {
    processDueWork(plan, snapshot, context.events, context.trace);
  }
  return executed;
}

function executeInstructionBoundary(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  context: RuntimeExecutionContext,
): number {
  if (snapshot.status === "halted" || snapshot.status === "failed") {
    return 0;
  }
  // A queued expiry block interrupts at this boundary, even while the main path waits.
  if (timerHandlerDispatchable(snapshot)) {
    startTimerHandler(plan, snapshot, context.trace);
    return 1;
  }
  if (snapshot.status === "waiting") return 0;
  const instructionIndex = snapshot.nextInstruction;
  // Every region of a validated plan ends in a transfer, so execution never runs past one.
  const instruction = plan.instructions[instructionIndex]!;

  snapshot.status = "running";
  const evaluator = context.evaluator();
  context.trace?.at(instructionIndex, snapshot.currentSessionTimeMs);
  try {
    executePlannedInstruction(plan, instruction, snapshot, evaluator, context.events);
    if (snapshot.interactionResultHandoff?.continuationInstruction === instructionIndex) {
      snapshot.interactionResultHandoff = null;
    }
  } catch (error) {
    if (!(error instanceof RuntimeFault)) throw error;
    failSnapshot(
      snapshot,
      error.toInfo(),
      instructionSourcePath(plan, instructionIndex),
      context.events,
    );
  } finally {
    snapshot.contextualSpeaker = null;
  }
  return 1;
}

export function stepToEvent(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: RuntimeRunOptions = {},
): RuntimeOperationResult {
  const captured = captureExecutableData(plan, snapshot);
  const trace = openDebugTrace(options.debugTrace, captured.plan, snapshot);
  const stepped = stepCapturedToEvent(
    captured.plan,
    captured.snapshot,
    capabilities,
    options,
    trace,
  );
  closeDebugTrace(trace, stepped);
  return stepped;
}

/** Steps engine-owned plan/state that already passed complete validation. */
export function stepValidatedStateToEvent(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: RuntimeRunOptions = {},
): RuntimeOperationResult {
  const trace = openDebugTrace(options.debugTrace, plan, snapshot);
  const stepped = stepCapturedToEvent(plan, snapshot, capabilities, options, trace);
  closeDebugTrace(trace, stepped);
  return stepped;
}

function stepCapturedToEvent(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities,
  options: RuntimeRunOptions,
  trace: TraceStore | null,
): RuntimeOperationResult {
  const budget = instructionBudget(options.instructionBudget);
  const context = new RuntimeExecutionContext(snapshot, capabilities, plan, trace);
  let instructionsExecuted = 0;
  while (executionRunnable(snapshot) && context.events.length === 0) {
    if (instructionsExecuted >= budget) {
      failForBudget(plan, snapshot, context.events, budget);
      break;
    }
    instructionsExecuted += executeCapturedInstruction(plan, snapshot, context);
  }
  return result(snapshot, context.events, instructionsExecuted);
}

export function run(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: RuntimeRunOptions = {},
): RuntimeOperationResult {
  const captured = captureExecutableData(plan, snapshot);
  const trace = openDebugTrace(options.debugTrace, captured.plan, snapshot);
  const ran = runCaptured(captured.plan, captured.snapshot, capabilities, options, trace);
  closeDebugTrace(trace, ran);
  return ran;
}

/** Runs engine-owned plan/state that already passed complete validation. */
export function runValidatedState(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: RuntimeRunOptions = {},
): RuntimeOperationResult {
  const trace = openDebugTrace(options.debugTrace, plan, snapshot);
  const ran = runCaptured(plan, snapshot, capabilities, options, trace);
  closeDebugTrace(trace, ran);
  return ran;
}

function runCaptured(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities,
  options: RuntimeRunOptions,
  trace: TraceStore | null,
): RuntimeOperationResult {
  const budget = instructionBudget(options.instructionBudget);
  const context = new RuntimeExecutionContext(snapshot, capabilities, plan, trace);
  let instructionsExecuted = 0;
  while (executionRunnable(snapshot)) {
    if (instructionsExecuted >= budget) {
      failForBudget(plan, snapshot, context.events, budget);
      break;
    }
    instructionsExecuted += executeCapturedInstruction(plan, snapshot, context);
  }
  return result(snapshot, context.events, instructionsExecuted);
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
        throw fault("TSR001", `Global '${instruction.name}' is already set up.`, instruction.span);
      }
      const value = evaluator.evaluateStartValue(instruction.value);
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
    case "declareSpeaker": {
      executeSpeakerAtomically(snapshot, evaluator, events, (stagedSnapshot, stagedEvaluator) => {
        if (stagedEvaluator.binding(instruction.name) !== undefined) {
          throw fault(
            "TSR001",
            `Speaker '${instruction.name}' is already set up.`,
            instruction.span,
          );
        }
        assertCounterCanAdvance(stagedSnapshot.nextSpeakerId, "nextSpeakerId");
        const speaker: RuntimeSpeakerSnapshot = {
          id: stagedSnapshot.nextSpeakerId,
          identifier: instruction.name,
          properties: [],
        };
        stagedSnapshot.nextSpeakerId += 1;
        stagedSnapshot.speakers.push(speaker);
        stagedSnapshot.globals.push({
          name: instruction.name,
          value: { kind: "speakerReference", speakerId: speaker.id, identifier: instruction.name },
        });
        stagedSnapshot.contextualSpeaker = speaker.id;
        for (const property of instruction.properties) {
          if (speaker.properties.some((item) => item.name === property.name)) {
            throw fault("TSR007", `Duplicate speaker property '${property.name}'.`, property.span);
          }
          const propertyValue = cloneCapturedSerializableValue(
            stagedEvaluator.evaluateStartValue(property.value),
          );
          if (property.name === "defaultSaySkippable" && typeof propertyValue !== "boolean") {
            throw fault(
              "TSR050",
              "Speaker property 'defaultSaySkippable' must be a boolean.",
              property.span,
            );
          }
          speaker.properties.push({ name: property.name, value: propertyValue });
        }
        // The speaker's properties are its state; its global names that state.
        const trace = stagedEvaluator.trace;
        if (trace !== null)
          trace.alias(
            bindingKey(GLOBAL_SCOPE_ID, instruction.name),
            trace.write("declaration", stateKey("speaker", speaker.id), instruction.name, {
              kind: "speakerReference",
              speakerId: speaker.id,
              identifier: instruction.name,
            }),
          );
        advance(stagedSnapshot);
      });
      return;
    }
    case "setDefaultSpeaker": {
      const speaker = evaluator.speakerByName(instruction.name, instruction.span);
      snapshot.defaultSpeaker = speaker.id;
      advance(snapshot);
      return;
    }
    case "enterScope":
      assertCounterCanAdvance(snapshot.nextScopeId, "nextScopeId");
      snapshot.frames.push({ id: snapshot.nextScopeId, file: null, entry: null, bindings: [] });
      snapshot.nextScopeId += 1;
      advance(snapshot);
      return;
    case "leaveScope":
      if (currentFrame(snapshot).file !== null) {
        throw fault("TSR033", "Cannot leave the root lexical scope.", instruction.span);
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
          `Variable '${instruction.name}' is already visible in this scope.`,
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
      const reference = evaluator.prepareReference(instruction.expression);
      setCapturedTemporary(snapshot.temporaries, instruction.destinationTemporary, reference);
      evaluator.trace?.writeTemporary(
        evaluator.callFrameId(),
        instruction.destinationTemporary,
        reference,
      );
      advance(snapshot);
      return;
    }
    case "validateAssignmentTarget":
      evaluator.validateAssignmentTarget(instruction.target);
      advance(snapshot);
      return;
    case "assign": {
      const value = evaluator.evaluate(instruction.value);
      if (instruction.typeCheck !== undefined)
        assertValueType(value, instruction.typeCheck, instruction.value.span);
      evaluator.assign(instruction.target, value);
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
        throw fault("TSR026", "Expected a boolean value.", instruction.condition.span);
      }
      snapshot.nextInstruction = condition ? snapshot.nextInstruction + 1 : instruction.target;
      return;
    }
    case "jump":
      snapshot.nextInstruction = instruction.target;
      return;
    case "loopStart":
      executeLoopStart(instruction, snapshot, evaluator);
      return;
    case "loopControl":
      executeLoopControl(instruction, snapshot);
      return;
    case "storeTemporary": {
      const value = evaluator.evaluate(instruction.value);
      if (instruction.expectBoolean && typeof value !== "boolean") {
        throw fault("TSR026", "Expected a boolean value.", instruction.value.span);
      }
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
    case "prepareSaySpeaker": {
      const speaker =
        instruction.speaker === null
          ? snapshot.defaultSpeaker === null
            ? null
            : evaluator.speakerById(snapshot.defaultSpeaker, instruction.span)
          : evaluator.speakerByName(instruction.speaker, instruction.span);
      const output =
        speaker === null ? null : evaluator.outputSpeaker(speaker, instruction.span, events);
      setCapturedTemporary(
        snapshot.temporaries,
        instruction.destinationTemporary,
        output === null
          ? null
          : createCapturedSerializableObject([
              { name: "identifier", value: output.identifier },
              { name: "displayName", value: output.displayName },
              { name: "color", value: output.color },
              { name: "font", value: output.font },
              { name: "avatar", value: output.avatar },
              { name: "speakerId", value: speaker === null ? 0 : speaker.id },
            ]),
      );
      advance(snapshot);
      return;
    }
    case "prepareSayText": {
      const value = evaluator.evaluate(instruction.value);
      const text =
        instruction.field === true
          ? fieldText(value, instruction.value.span, currentTemporalContext(snapshot))
          : evaluator.sayText(value, instruction.value.span);
      setCapturedTemporary(snapshot.temporaries, instruction.destinationTemporary, text);
      evaluator.trace?.writeTemporary(
        evaluator.callFrameId(),
        instruction.destinationTemporary,
        text,
      );
      advance(snapshot);
      return;
    }
    case "prepareSayContextualSpeaker": {
      const prepared = preparedOutputSpeaker(
        snapshot.temporaries,
        instruction.speakerTemporary,
        instruction.span,
      );
      setCapturedTemporary(
        snapshot.temporaries,
        instruction.destinationTemporary,
        prepared.speakerId === null
          ? null
          : (() => {
              const speaker = evaluator.speakerById(prepared.speakerId, instruction.span);
              return {
                kind: "speakerReference",
                speakerId: speaker.id,
                identifier: speaker.identifier,
              };
            })(),
      );
      advance(snapshot);
      return;
    }
    case "prepareInteractionSpeaker": {
      const speaker =
        instruction.speaker !== null
          ? evaluator.speakerByName(instruction.speaker, instruction.span)
          : snapshot.contextualSpeaker !== null
            ? evaluator.speakerById(snapshot.contextualSpeaker, instruction.span)
            : snapshot.defaultSpeaker !== null
              ? evaluator.speakerById(snapshot.defaultSpeaker, instruction.span)
              : null;
      setCapturedTemporary(
        snapshot.temporaries,
        instruction.destinationTemporary,
        speaker === null
          ? null
          : { kind: "speakerReference", speakerId: speaker.id, identifier: speaker.identifier },
      );
      advance(snapshot);
      return;
    }
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
      returnFromFunction(plan, snapshot, value, instruction.span, events, evaluator.trace);
      return;
    }
    case "returnVoid":
      returnFromFunction(plan, snapshot, null, instruction.span, events, evaluator.trace);
      return;
    case "say": {
      executeSayAtomically(plan, instruction, snapshot, evaluator, events);
      return;
    }
    case "wait": {
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
        throw fault("TSR051", "Runtime action ID space is exhausted.", instruction.span);
      }
      assertEventSequenceCapacity(
        snapshot,
        requiredEventSequencesForNewDelay(snapshot),
        instruction.span,
      );
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
      return;
    }
    case "interaction": {
      if (
        instruction.destinationTemporary !== null &&
        snapshot.temporaries.some((temporary) => temporary.id === instruction.destinationTemporary)
      ) {
        throw fault(
          "TSR050",
          "Interaction result destination is already occupied.",
          instruction.span,
        );
      }
      if (
        !Number.isSafeInteger(snapshot.nextActionId) ||
        snapshot.nextActionId >= Number.MAX_SAFE_INTEGER
      ) {
        throw fault("TSR051", "Runtime action ID space is exhausted.", instruction.span);
      }
      const backgroundPacingGate = snapshot.backgroundActions.some(
        (action) => action.kind === "chatPacingGate",
      );
      const requiredEventSequences = backgroundPacingGate ? 4 : 3;
      assertEventSequenceCapacity(snapshot, requiredEventSequences, instruction.span);
      const prepared = "preparedUi" in instruction;
      const speaker = prepared
        ? preparedInteractionSpeaker(
            instruction.speakerTemporary,
            snapshot.temporaries,
            evaluator,
            instruction.span,
          )
        : instruction.speaker !== null
          ? evaluator.speakerByName(instruction.speaker, instruction.span)
          : snapshot.defaultSpeaker === null
            ? null
            : evaluator.speakerById(snapshot.defaultSpeaker, instruction.span);
      const materialized = prepared
        ? materializeInteractionUi(
            instruction.preparedUi,
            snapshot.temporaries,
            currentTemporalContext(snapshot),
            instruction.span,
          )
        : { ui: instruction.ui, stagedWrites: [] as const };
      const timeoutMs =
        prepared &&
        instruction.preparedUi.kind === "button" &&
        instruction.preparedUi.timeoutTemporary !== undefined
          ? buttonTimeoutMs(
              readTemporary(
                snapshot.temporaries,
                instruction.preparedUi.timeoutTemporary,
                instruction.span,
              ),
              snapshot,
              instruction.span,
            )
          : null;
      const backgroundGate = snapshot.backgroundActions.find(
        (action): action is RuntimeChatPacingGateActionSnapshot => action.kind === "chatPacingGate",
      );
      if (backgroundGate !== undefined) {
        settleBackgroundPacingGate(
          plan,
          snapshot,
          backgroundGate,
          "consumedByForegroundInteraction",
          events,
        );
      }
      const sequence = snapshot.nextEventSequence;
      const action: RuntimeInteractionActionSnapshot = Object.freeze({
        kind: "interaction",
        interactionKind: instruction.interactionKind,
        actionId: snapshot.nextActionId,
        owningInstruction: snapshot.nextInstruction,
        continuationInstruction: snapshot.nextInstruction + 1,
        ownerCallFrameId: snapshot.callFrames.at(-1)?.id ?? null,
        scopeDepth: snapshot.frames.length,
        loopDepth: snapshot.loopFrames.length,
        destinationTemporary: instruction.destinationTemporary,
        expectedResult: instruction.expectedResult,
        target: instruction.target,
        speakerId: speaker?.id ?? null,
        ui: cloneInteractionUi(materialized.ui),
        createdAtMs: snapshot.currentSessionTimeMs,
        timeoutMs,
        requestEventSequence: sequence,
      });
      commitInteractionMaterialization(snapshot, materialized.stagedWrites);
      const committedSequence = takeSequence(snapshot);
      if (committedSequence !== sequence) {
        throw new Error("Interaction event-sequence staging drifted unexpectedly.");
      }
      snapshot.nextActionId += 1;
      snapshot.foregroundAction = action;
      snapshot.status = "waiting";
      events.push(
        Object.freeze({
          kind: "actionRequested",
          sequence,
          action: cloneInteractionAction(action),
          span: copySpan(instruction.span),
        } satisfies ActionRequestedEvent),
      );
      return;
    }
    case "capture": {
      // The tags are checked before the capture is requested, so a pending capture only holds valid ones.
      const tags =
        instruction.tags === null
          ? null
          : captureTags(evaluator.evaluate(instruction.tags), instruction.tags.span);
      if (
        snapshot.temporaries.some((temporary) => temporary.id === instruction.destinationTemporary)
      ) {
        throw fault("TSR050", "Capture result destination is already occupied.", instruction.span);
      }
      if (
        !Number.isSafeInteger(snapshot.nextActionId) ||
        snapshot.nextActionId >= Number.MAX_SAFE_INTEGER
      ) {
        throw fault("TSR051", "Runtime action ID space is exhausted.", instruction.span);
      }
      // The request, a possible unavailable-camera warning, and the completion, besides what active actions reserve.
      assertEventSequenceCapacity(
        snapshot,
        3 + requiredFutureActionCompletionEvents(snapshot),
        instruction.span,
      );
      const sequence = takeSequence(snapshot);
      const action: RuntimeCaptureActionSnapshot = Object.freeze({
        kind: "capture",
        capture: instruction.capture,
        tags,
        actionId: snapshot.nextActionId,
        owningInstruction: snapshot.nextInstruction,
        continuationInstruction: snapshot.nextInstruction + 1,
        ownerCallFrameId: snapshot.callFrames.at(-1)?.id ?? null,
        scopeDepth: snapshot.frames.length,
        loopDepth: snapshot.loopFrames.length,
        destinationTemporary: instruction.destinationTemporary,
        createdAtMs: snapshot.currentSessionTimeMs,
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
      return;
    }
    case "startTimer":
      startTimer(instruction, snapshot, evaluator, events);
      return;
    case "exit":
      stopAllTimersForSessionEnd(snapshot);
      stopAllMediaForSessionEnd(snapshot);
      if (snapshot.cameraView !== null) snapshot.cameraView.shown = false;
      snapshot.backgroundActions.length = 0;
      snapshot.preparedSayOutput = null;
      if (
        snapshot.lastSettlement?.actionKind === "chatPacingGate" &&
        snapshot.lastSettlement.releasedPreparedOutputInstruction !== null
      ) {
        snapshot.lastSettlement = Object.freeze({
          ...snapshot.lastSettlement,
          releasedPreparedOutputInstruction: null,
        });
      }
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
    case "pacingBarrier":
      executePacingBarrier(instruction, snapshot, evaluator);
      return;
    case "showImage":
      showImage(plan, instruction, snapshot, evaluator, events);
      return;
    case "showCamera":
      // Shows the default camera's view, or moves it when it is shown already; the Player brings the camera, if any.
      snapshot.cameraView = { placement: instruction.placement, shown: true };
      evaluator.trace?.writeState("assignment", stateKey("camera"), "camera", {
        kind: "cameraView",
      });
      if (instruction.destinationTemporary !== null) {
        setCapturedTemporary(snapshot.temporaries, instruction.destinationTemporary, {
          kind: "cameraView",
        });
        evaluator.trace?.writeTemporary(evaluator.callFrameId(), instruction.destinationTemporary, {
          kind: "cameraView",
        });
      }
      advance(snapshot);
      return;
    case "hideCamera":
      if (snapshot.cameraView !== null) snapshot.cameraView.shown = false;
      evaluator.trace?.writeState("assignment", stateKey("camera"), "camera", {
        kind: "cameraView",
      });
      advance(snapshot);
      return;
    case "showPermanentButton":
      showPermanentButton(instruction, snapshot, evaluator, events);
      return;
    case "storageWrite":
      writeStorage(instruction, snapshot, evaluator, events);
      return;
    case "playMedia":
      startMedia(plan, instruction, snapshot, evaluator, events);
      return;
    case "goto":
      executeGoto(instruction, snapshot, contextRootId(snapshot), events);
      return;
    case "transfer":
      executeTransfer(plan, instruction, snapshot, evaluator, events);
      return;
    case "end":
      executeEnd(plan, instruction, snapshot, events, evaluator.trace);
      return;
    case "setFallback":
      executeSetFallback(plan, instruction, snapshot, evaluator);
      return;
  }
  instruction satisfies never;
}

function preparedInteractionSpeaker(
  temporaryId: number,
  temporaries: readonly RuntimeTemporarySnapshot[],
  evaluator: Evaluator,
  span: SourceSpan,
): RuntimeSpeakerSnapshot | null {
  const prepared = readTemporary(temporaries, temporaryId, span);
  if (prepared === null) return null;
  if (!isSpeakerReference(prepared)) {
    throw fault("TSR052", "Prepared interaction speaker is invalid.", span);
  }
  return evaluator.speakerById(prepared.speakerId, span);
}

interface MaterializedInteractionUi {
  readonly ui: InteractionUiPayload;
  readonly stagedWrites: readonly {
    readonly temporaryId: number;
    readonly value: SerializableRuntimeValue;
  }[];
}

function materializeInteractionUi(
  prepared: PreparedInteractionUiPayload,
  temporaries: RuntimeTemporarySnapshot[],
  temporalContext: TemporalContext,
  span: SourceSpan,
): MaterializedInteractionUi {
  const stagedWrites: Array<{
    readonly temporaryId: number;
    readonly value: SerializableRuntimeValue;
  }> = [];
  const read = (temporaryId: number): RuntimeTemporarySnapshot => {
    const temporary = temporaries.find((item) => item.id === temporaryId);
    if (temporary === undefined)
      throw fault("TSR046", `Temporary '${temporaryId}' is not available.`, span);
    return temporary;
  };
  const readText = (temporaryId: number): string => {
    const temporary = read(temporaryId);
    const text = fieldText(temporary.value, span, temporalContext);
    stagedWrites.push({ temporaryId: temporary.id, value: text });
    return text;
  };

  const backgroundColor = (value: SerializableRuntimeValue): string => {
    const normalized = normalizeOpaqueColor(value);
    if (normalized === null)
      throw fault("TSR052", "Expected an opaque CSS button background colour.", span);
    return normalized;
  };

  let ui: InteractionUiPayload;
  if (prepared.kind === "button") {
    ui = {
      kind: "button",
      buttonLabel: readText(prepared.buttonLabelTemporary),
      ...(prepared.backgroundTemporary === undefined
        ? {}
        : { background: backgroundColor(read(prepared.backgroundTemporary).value) }),
      accessibleName: prepared.accessibleName,
    };
  } else if (prepared.kind === "text" || prepared.kind === "number") {
    const hint = prepared.hintTemporary === null ? null : readText(prepared.hintTemporary);
    let prefill: string | undefined;
    const integer = prepared.kind === "number" && prepared.integer === true;
    if (prepared.prefillTemporary !== undefined) {
      const temporary = read(prepared.prefillTemporary);
      if (!isEmptyDefault(temporary.value))
        prefill = interactionPrefill(integer ? "integer" : prepared.kind, temporary.value, span);
      stagedWrites.push({ temporaryId: temporary.id, value: prefill ?? null });
    }
    ui = {
      kind: prepared.kind,
      hint,
      ...(prefill === undefined ? {} : { prefill }),
      ...(integer ? { integer: true as const } : {}),
      accessibleName: prepared.accessibleName,
    };
  } else if (prepared.kind === "temporal") {
    const hint = prepared.hintTemporary === null ? null : readText(prepared.hintTemporary);
    let prefill: string | undefined;
    if (prepared.prefillTemporary !== undefined) {
      const temporary = read(prepared.prefillTemporary);
      if (!isEmptyDefault(temporary.value))
        prefill = temporalPrefill(prepared.temporalKind, temporary.value, span);
      stagedWrites.push({ temporaryId: temporary.id, value: prefill ?? null });
    }
    ui = {
      kind: "temporal",
      temporalKind: prepared.temporalKind,
      hint,
      ...(prefill === undefined ? {} : { prefill }),
      accessibleName: prepared.accessibleName,
    };
  } else if (prepared.kind === "image") {
    const request = read(prepared.requestTemporary);
    const image = imageInteractionUi(request.value, prepared.accessibleName, temporalContext, span);
    // The request keeps what it shows, so a restore can check the open request against it.
    stagedWrites.push({ temporaryId: request.id, value: imageRequestValue(image) });
    ui = image;
  } else {
    const source = read(prepared.optionsTemporary);
    if (!isList(source.value) || source.value.items.length !== prepared.values.length) {
      throw fault(
        "TSR052",
        "Prepared choice options do not match the authored option count.",
        span,
      );
    }
    ui = {
      kind: "choice",
      options: expandChoiceOptions(source.value.items, prepared.values, temporalContext, span),
      accessibleName: prepared.accessibleName,
    };
  }

  assertInteractionUiLimits(ui, span);
  return Object.freeze({
    ui,
    stagedWrites: Object.freeze(
      stagedWrites.map((staged) =>
        Object.freeze({
          temporaryId: staged.temporaryId,
          value: cloneCapturedSerializableValue(staged.value),
        }),
      ),
    ),
  });
}

/**
 * A default that is `null` or blank text when the field opens prefills nothing (V30 §20), such as a `load` of a key a
 * first play has not saved yet. Its temporary then holds `null`, which checkpoint validation reads as no prefill.
 */
function isEmptyDefault(value: SerializableRuntimeValue): boolean {
  return value === null || (typeof value === "string" && isBlankTextAnswer(value));
}

/**
 * The request of `askImage`, from its written arguments in source order: the message as text, sources that default to
 * true and are not both off, and `types:` and `mime:` lists of valid texts.
 */
function imageInteractionUi(
  value: SerializableRuntimeValue,
  accessibleName: InteractionAccessibleName,
  temporalContext: TemporalContext,
  span: SourceSpan,
): Extract<InteractionUiPayload, { kind: "image" }> {
  if (!isObject(value)) throw fault("TSR052", "The prepared image request is malformed.", span);
  let question: string | null = null;
  let hint: string | null = null;
  let allowCamera = true;
  let allowFile = true;
  let types: readonly string[] | null = null;
  let mime: readonly string[] | null = null;
  for (const { name, value: argument } of value.properties) {
    if (name === "message") question = fieldText(argument, span, temporalContext);
    else if (name === "hint") hint = fieldText(argument, span, temporalContext);
    else if (name === "allowCamera" || name === "allowFile") {
      if (typeof argument !== "boolean")
        throw fault(
          "TSR052",
          `askImage(${name}:) takes true or false, not ${describeRuntimeValue(argument)}.`,
          span,
        );
      if (name === "allowCamera") allowCamera = argument;
      else allowFile = argument;
    } else if (name === "types" || name === "mime") {
      const texts = imageFilterTexts(name, argument, span);
      if (name === "types") types = texts;
      else mime = texts;
    } else throw fault("TSR052", "The prepared image request is malformed.", span);
  }
  if (!allowCamera && !allowFile) throw fault("TSR052", IMAGE_NO_SOURCE_MESSAGE, span);
  return { kind: "image", question, hint, allowCamera, allowFile, types, mime, accessibleName };
}

function imageFilterTexts(
  option: "types" | "mime",
  value: SerializableRuntimeValue,
  span: SourceSpan,
): readonly string[] {
  if (!isList(value))
    throw fault(
      "TSR052",
      option === "types"
        ? `askImage(types:) takes a list of file extensions, such as [".png"], not ${describeRuntimeValue(value)}.`
        : `askImage(mime:) takes a list of image MIME types, such as ["image/png"], not ${describeRuntimeValue(value)}.`,
      span,
    );
  if (value.items.length === 0) throw fault("TSR052", emptyImageFilterMessage(option), span);
  return value.items.map((item) => {
    if (typeof item !== "string")
      throw fault(
        "TSR052",
        `askImage(${option}:) takes texts such as ${option === "types" ? '".png"' : '"image/png"'}, but it holds ${describeRuntimeValue(item)}.`,
        span,
      );
    const problem = imageFilterTextProblem(option, item);
    if (problem !== null) throw fault("TSR052", problem, span);
    return item;
  });
}

/** The prefill text of a default answer, which must be an answer the field accepts. */
function interactionPrefill(
  kind: "text" | "number" | "integer",
  value: SerializableRuntimeValue,
  span: SourceSpan,
): string {
  if (kind === "integer") {
    // A non-whole default is an error, never rounded.
    if (typeof value !== "number" || !Number.isSafeInteger(value))
      throw fault(
        "TSR052",
        "The default answer of askInteger must be a whole number. Round it with floor(...), round(...), or ceil(...), or ask without 'default:'.",
        span,
      );
    return numberAnswerText(value);
  }
  if (kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw fault(
        "TSR052",
        "The default answer of askNumber must be a finite number. Ask without 'default:' when there is no number to offer.",
        span,
      );
    return numberAnswerText(value);
  }
  if (typeof value !== "string")
    throw fault(
      "TSR052",
      "The default answer of askText must be text. Write the value as text with interpolation: 'default: \"${...}\"'.",
      span,
    );
  return value;
}

/** The ISO prefill text of a date or time default answer, which must be of the kind the field asks for. */
function temporalPrefill(
  kind: InteractionTemporalKind,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): string {
  const answer =
    kind === "date"
      ? isDate(value) && value
      : kind === "time"
        ? isTime(value) && value
        : isDateTime(value) && value;
  if (answer !== false) return temporalAnswerText(answer);
  const [command, noun, conversion] =
    kind === "date"
      ? ["askDate", "a date", "toDate"]
      : kind === "time"
        ? ["askTime", "a time", "toTime"]
        : ["askDateTime", "a date and time", "toDateTime"];
  throw fault(
    "TSR052",
    `The default answer of ${command} must be ${noun}, not ${describeRuntimeValue(value)}.${typeof value === "string" ? ` Convert the text with ${conversion}(...).` : ""}`,
    span,
  );
}

function commitInteractionMaterialization(
  snapshot: RuntimeSnapshot,
  stagedWrites: readonly {
    readonly temporaryId: number;
    readonly value: SerializableRuntimeValue;
  }[],
): void {
  for (const staged of stagedWrites) {
    const temporary = snapshot.temporaries.find((item) => item.id === staged.temporaryId);
    if (temporary === undefined) {
      throw new Error(
        `Prepared interaction temporary '${staged.temporaryId}' disappeared before commit.`,
      );
    }
    temporary.value = cloneCapturedSerializableValue(staged.value);
  }
}

function assertInteractionUiLimits(ui: InteractionUiPayload, span: SourceSpan): void {
  const strings: string[] = [];
  if (ui.accessibleName.kind === "text") strings.push(ui.accessibleName.text);
  if (ui.kind === "button") strings.push(ui.buttonLabel);
  else if (ui.kind === "image") {
    if (ui.question !== null) strings.push(ui.question);
    if (ui.hint !== null) strings.push(ui.hint);
    // Item by item: a long computed filter must reach the limit below, not the native argument limit of a spread.
    for (const text of ui.types ?? []) strings.push(text);
    for (const text of ui.mime ?? []) strings.push(text);
  } else if (ui.kind !== "choice") {
    if (ui.hint !== null) strings.push(ui.hint);
    if (ui.prefill !== undefined) strings.push(ui.prefill);
  } else {
    for (const option of ui.options) {
      strings.push(option.text);
      if (typeof option.value === "string" && option.value !== option.text)
        strings.push(option.value);
    }
  }
  let aggregate = 0;
  for (const value of strings) {
    const bytes = boundedInteractionUtf8ByteLength(
      value,
      MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate,
    );
    if (bytes === null)
      throw fault(
        "TSR052",
        "Interaction text exceeds the remaining aggregate UTF-8 byte limit.",
        span,
      );
    aggregate += bytes;
  }
}

function enterFunction(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "callFunction" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
): void {
  const definition = functionDefinition(plan, instruction.functionId, instruction.span);
  const trace = evaluator.trace;
  // A trace keeps each argument's causes apart, in source order.
  const argumentCauses: DebugDependencies[] | null = trace === null ? null : [];
  const supplied = new Map(
    instruction.arguments.map((argument) => {
      const outer = trace?.push() ?? null;
      const value = cloneCapturedSerializableValue(evaluator.evaluate(argument.value));
      if (outer !== null) argumentCauses!.push(trace!.pop(outer));
      return [argument.parameterName, value];
    }),
  );
  // Parameters are bound only after every argument is evaluated, so the arguments are checked then too.
  for (const argument of instruction.arguments)
    if (argument.typeCheck !== undefined)
      assertValueType(
        supplied.get(argument.parameterName)!,
        argument.typeCheck,
        argument.value.span,
      );
  if (snapshot.callFrames.length >= snapshot.maxCallDepth) {
    throw fault(
      "TSR047",
      `Maximum TeaseScript call depth of ${snapshot.maxCallDepth} exceeded.`,
      instruction.span,
    );
  }
  assertCounterCanAdvance(snapshot.nextCallFrameId, "nextCallFrameId");
  assertCounterCanAdvance(snapshot.nextScopeId, "nextScopeId");
  const frame: RuntimeCallFrameSnapshot = {
    kind: "function",
    id: snapshot.nextCallFrameId,
    // A function sees the top-level names of the activation that calls it, which is always its own file's.
    rootScopeId: contextRootId(snapshot),
    // A function sees its own locals and those of its file, never those of its caller (V30 §14).
    captures: [],
    functionId: definition.id,
    functionName: definition.name,
    callSiteSpan: copySpan(instruction.span),
    returnInstruction: instruction.returnInstruction,
    destinationTemporary: instruction.destinationTemporary,
    timerInterruption: null,
    callerTemporaries: snapshot.temporaries.map(cloneTemporary),
    scopeBaseDepth: snapshot.frames.length,
    loopBaseDepth: snapshot.loopFrames.length,
    arguments: definition.parameters.map((parameter) => {
      const value = supplied.get(parameter.name);
      return value === undefined
        ? { parameterName: parameter.name, supplied: false as const }
        : { parameterName: parameter.name, supplied: true as const, value };
    }),
    parameterState: { phase: "supplied", parameterIndex: 0 },
  };
  snapshot.nextCallFrameId += 1;
  snapshot.callFrames.push(frame);
  if (trace !== null)
    instruction.arguments.forEach((argument, index) =>
      trace.argument(
        frame.id,
        definition.name,
        argument.parameterName,
        supplied.get(argument.parameterName)!,
        argumentCauses![index]!,
      ),
    );
  snapshot.temporaries.length = 0;
  snapshot.frames.push({ id: snapshot.nextScopeId, file: null, entry: null, bindings: [] });
  snapshot.nextScopeId += 1;
  snapshot.nextInstruction = definition.entryInstruction;
}

function bindSuppliedParameter(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "bindSuppliedParameter" }>,
  snapshot: RuntimeSnapshot,
  trace: TraceStore | null,
): void {
  const { frame, definition } = activeFunction(plan, snapshot, instruction.span);
  if (
    frame.functionId !== instruction.functionId ||
    frame.parameterState.phase !== "supplied" ||
    frame.parameterState.parameterIndex !== instruction.parameterIndex
  ) {
    throw fault("TSR048", "Supplied-parameter progress is inconsistent.", instruction.span);
  }
  const parameter = definition.parameters[instruction.parameterIndex];
  const argument = frame.arguments[instruction.parameterIndex];
  if (parameter === undefined || argument === undefined) {
    throw fault("TSR048", "Function parameter metadata is inconsistent.", instruction.span);
  }
  if (argument.supplied) {
    declareFunctionBinding(plan, snapshot, parameter.name, argument.value, instruction.span);
    trace?.suppliedParameter(
      frame.id,
      currentFrame(snapshot).id,
      definition.name,
      parameter.name,
      argument.value,
    );
  }
  frame.parameterState.parameterIndex += 1;
  advance(snapshot);
}

function beginFunctionDefaults(
  plan: InstructionPlan,
  functionId: number,
  snapshot: RuntimeSnapshot,
  span: SourceSpan,
): void {
  const { frame, definition } = activeFunction(plan, snapshot, span);
  if (
    frame.functionId !== functionId ||
    frame.parameterState.phase !== "supplied" ||
    frame.parameterState.parameterIndex !== definition.parameters.length
  ) {
    throw fault("TSR048", "Parameter binding did not reach the defaults phase.", span);
  }
  frame.parameterState = { phase: "defaults", parameterIndex: 0 };
  advance(snapshot);
}

function prepareParameterDefault(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "prepareParameterDefault" }>,
  snapshot: RuntimeSnapshot,
): void {
  const { frame, definition } = activeFunction(plan, snapshot, instruction.span);
  if (
    frame.functionId !== instruction.functionId ||
    frame.parameterState.phase !== "defaults" ||
    frame.parameterState.parameterIndex !== instruction.parameterIndex
  ) {
    throw fault("TSR048", "Default-parameter progress is inconsistent.", instruction.span);
  }
  const parameter = definition.parameters[instruction.parameterIndex];
  const argument = frame.arguments[instruction.parameterIndex];
  if (parameter === undefined || argument === undefined) {
    throw fault("TSR048", "Function parameter metadata is inconsistent.", instruction.span);
  }
  if (argument.supplied) {
    frame.parameterState.parameterIndex += 1;
    snapshot.nextInstruction = instruction.target;
    return;
  }
  if (!parameter.hasDefault) {
    throw fault(
      "TSR049",
      `Required parameter '${parameter.name}' was not supplied.`,
      instruction.span,
    );
  }
  advance(snapshot);
}

function bindDefaultParameter(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "bindDefaultParameter" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
): void {
  const { frame, definition } = activeFunction(plan, snapshot, instruction.span);
  if (
    frame.functionId !== instruction.functionId ||
    frame.parameterState.phase !== "defaults" ||
    frame.parameterState.parameterIndex !== instruction.parameterIndex
  ) {
    throw fault("TSR048", "Default-parameter binding is inconsistent.", instruction.span);
  }
  const parameter = definition.parameters[instruction.parameterIndex];
  if (parameter === undefined || !parameter.hasDefault) {
    throw fault("TSR048", "Default-parameter metadata is inconsistent.", instruction.span);
  }
  const value = evaluator.evaluate(instruction.value);
  if (instruction.typeCheck !== undefined)
    assertValueType(value, instruction.typeCheck, instruction.value.span);
  declareFunctionBinding(plan, snapshot, parameter.name, value, instruction.span);
  evaluator.trace?.writeBinding(
    "parameter",
    currentFrame(snapshot).id,
    parameter.name,
    value,
    Object.freeze({
      kind: "call",
      functionName: definition.name,
      parameter: parameter.name,
      defaulted: true,
    }),
  );
  frame.parameterState.parameterIndex += 1;
  advance(snapshot);
}

function enterFunctionBody(
  plan: InstructionPlan,
  functionId: number,
  snapshot: RuntimeSnapshot,
  span: SourceSpan,
): void {
  const { frame, definition } = activeFunction(plan, snapshot, span);
  if (
    frame.functionId !== functionId ||
    frame.parameterState.phase !== "defaults" ||
    frame.parameterState.parameterIndex !== definition.parameters.length
  ) {
    throw fault("TSR048", "Function body entry has incomplete parameters.", span);
  }
  frame.parameterState = { phase: "body", parameterIndex: definition.parameters.length };
  advance(snapshot);
}

function returnFromFunction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  value: SerializableRuntimeValue,
  span: SourceSpan,
  events: InterpreterEvent[],
  trace: TraceStore | null,
): void {
  const { frame } = activeFunction(plan, snapshot, span);
  if (frame.timerInterruption !== null) {
    returnFromTimerHandler(plan, snapshot, frame, events, trace);
    return;
  }
  const returned = cloneCapturedSerializableValue(value);
  leaveScopes(snapshot, frame.scopeBaseDepth);
  snapshot.loopFrames.splice(frame.loopBaseDepth);
  snapshot.callFrames.pop();
  snapshot.temporaries.splice(
    0,
    snapshot.temporaries.length,
    ...frame.callerTemporaries.map(cloneTemporary),
  );
  const destinationTemporary = frame.destinationTemporary!;
  if (snapshot.temporaries.some((temporary) => temporary.id === destinationTemporary)) {
    throw fault("TSR050", "Function result destination is already occupied.", span);
  }
  snapshot.temporaries.push({ id: destinationTemporary, value: returned });
  trace?.writeTemporary(
    currentCallFrameId(snapshot) ?? 0,
    destinationTemporary,
    returned,
    "return",
    Object.freeze({
      kind: "call",
      functionName: frame.functionName,
      parameter: null,
      defaulted: false,
    }),
  );
  snapshot.nextInstruction = frame.returnInstruction;
}

function activeFunction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  span: SourceSpan,
): {
  readonly frame: RuntimeCallFrameSnapshot;
  readonly definition: InstructionPlan["functions"][number];
} {
  const frame = activeFunctionFrame(snapshot);
  if (frame === undefined) {
    throw fault("TSR051", "Function-only instruction executed without a call frame.", span);
  }
  return { frame, definition: functionDefinition(plan, frame.functionId, span) };
}

function functionDefinition(
  plan: InstructionPlan,
  functionId: number,
  span: SourceSpan,
): InstructionPlan["functions"][number] {
  const definition = plan.functions[functionId - 1];
  if (definition === undefined || definition.id !== functionId) {
    throw fault("TSR052", `Unknown compiled function ID '${functionId}'.`, span);
  }
  return definition;
}

function declareFunctionBinding(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  name: string,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): void {
  if (findBinding(snapshot, plan, name) !== undefined) {
    throw fault("TSR001", `Parameter '${name}' duplicates a visible binding.`, span);
  }
  currentFrame(snapshot).bindings.push({ name, value: cloneCapturedSerializableValue(value) });
}

function executeLoopStart(
  instruction: Extract<Instruction, { kind: "loopStart" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
): void {
  // A loop belongs to the call that runs it: the same loop of a recursive caller is another loop.
  const owner = currentCallFrameId(snapshot);
  let frame = snapshot.loopFrames.at(-1);
  if (frame?.loopId !== instruction.loopId || frame.callFrameId !== owner) {
    if (
      snapshot.loopFrames.some(
        (item) => item.loopId === instruction.loopId && item.callFrameId === owner,
      )
    ) {
      throw fault(
        "TSR042",
        "Loop-frame nesting does not match the instruction plan.",
        instruction.span,
      );
    }
    const scopeDepth = snapshot.frames.length;
    if (instruction.loopKind === "repeat") {
      const value = evaluator.evaluate(instruction.expression);
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw fault(
          "TSR043",
          "repeat requires a non-negative integer count.",
          instruction.expression.span,
        );
      }
      frame = {
        kind: "repeat",
        loopId: instruction.loopId,
        scopeDepth,
        remaining: value,
        callFrameId: currentCallFrameId(snapshot),
      };
    } else if (instruction.loopKind === "while") {
      frame = {
        kind: "while",
        loopId: instruction.loopId,
        scopeDepth,
        callFrameId: currentCallFrameId(snapshot),
      };
    } else {
      const evaluated = evaluator.evaluate(instruction.expression);
      const pair = instruction.valueVariable !== undefined;
      if (pair && !isDict(evaluated)) {
        throw fault(
          "TSR044",
          "for key, value requires a dict source.",
          instruction.expression.span,
        );
      }
      // A loop over a dict goes through its keys, or with a value variable its entries, as they are when it starts.
      const source =
        isDict(evaluated) && !pair
          ? createCapturedSerializableList(evaluated.entries.map((entry) => entry.key))
          : evaluated;
      if (!isList(source) && !isSet(source) && !isRange(source) && !isDict(source)) {
        throw fault(
          "TSR044",
          "for requires a list, set, dict, or range source.",
          instruction.expression.span,
        );
      }
      if (isRange(source)) assertIntegerRange(source, instruction.expression.span);
      frame = {
        kind: "for",
        loopId: instruction.loopId,
        scopeDepth,
        variable: instruction.variable,
        ...(pair ? { valueVariable: instruction.valueVariable } : {}),
        // EVIDENCE: the guards above narrow source to the four iterable runtime collection variants.
        source: cloneCapturedSerializableValue(source) as Extract<
          RuntimeLoopFrameSnapshot,
          { kind: "for" }
        >["source"],
        position: 0,
        callFrameId: currentCallFrameId(snapshot),
      };
      evaluator.trace?.write(
        "loopSource",
        loopKey(owner ?? 0, instruction.loopId),
        instruction.variable,
        frame.source,
      );
    }
    snapshot.loopFrames.push(frame);
  }

  if (frame.kind !== instruction.loopKind) {
    throw fault("TSR042", "Loop-frame kind does not match the instruction plan.", instruction.span);
  }
  if (snapshot.frames.length !== frame.scopeDepth) {
    throw fault(
      "TSR042",
      "Loop scope state does not match the next instruction.",
      instruction.span,
    );
  }

  if (frame.kind === "repeat") {
    if (frame.remaining === 0) {
      snapshot.loopFrames.pop();
      snapshot.nextInstruction = instruction.target;
      return;
    }
    frame.remaining -= 1;
    pushIterationScope(snapshot, []);
    advance(snapshot);
    return;
  }
  if (frame.kind === "while") {
    const condition = evaluator.evaluate(instruction.expression);
    if (typeof condition !== "boolean") {
      throw fault("TSR026", "Expected a boolean value.", instruction.expression.span);
    }
    if (!condition) {
      snapshot.loopFrames.pop();
      snapshot.nextInstruction = instruction.target;
      return;
    }
    pushIterationScope(snapshot, []);
    advance(snapshot);
    return;
  }

  const length = iterationLength(frame.source);
  if (frame.position >= length) {
    snapshot.loopFrames.pop();
    snapshot.nextInstruction = instruction.target;
    return;
  }
  if (isDict(frame.source)) {
    // Each iteration binds the key and its own copy of the value, so changes to either never reach the snapshot.
    const entry = frame.source.entries[frame.position]!;
    frame.position += 1;
    pushIterationScope(snapshot, [
      { name: frame.variable, value: entry.key },
      { name: frame.valueVariable!, value: cloneCapturedSerializableValue(entry.value) },
    ]);
    if (evaluator.trace !== null) {
      const scopeId = currentFrame(snapshot).id;
      const source = loopKey(owner ?? 0, instruction.loopId);
      evaluator.trace.loopValue(source, frame.source, scopeId, frame.variable, entry.key);
      evaluator.trace.loopValue(source, frame.source, scopeId, frame.valueVariable!, entry.value);
    }
    advance(snapshot);
    return;
  }
  const value = iterationValue(frame.source, frame.position);
  frame.position += 1;
  pushIterationScope(snapshot, [
    { name: frame.variable, value: cloneCapturedSerializableValue(value) },
  ]);
  evaluator.trace?.loopValue(
    loopKey(owner ?? 0, instruction.loopId),
    frame.source,
    currentFrame(snapshot).id,
    frame.variable,
    value,
  );
  advance(snapshot);
}

function executeLoopControl(
  instruction: Extract<Instruction, { kind: "loopControl" }>,
  snapshot: RuntimeSnapshot,
): void {
  const frame = snapshot.loopFrames.at(-1);
  if (frame === undefined || frame.loopId !== instruction.loopId) {
    throw fault(
      "TSR042",
      "Loop control does not match the active innermost loop.",
      instruction.span,
    );
  }
  if (frame.callFrameId !== currentCallFrameId(snapshot)) {
    throw fault("TSR042", "Loop control cannot cross a function boundary.", instruction.span);
  }
  if (snapshot.frames.length <= frame.scopeDepth) {
    throw fault("TSR042", "Active loop iteration scope is missing.", instruction.span);
  }
  leaveScopes(snapshot, frame.scopeDepth);
  if (instruction.action === "break") snapshot.loopFrames.pop();
  snapshot.nextInstruction = instruction.target;
}

function pushIterationScope(snapshot: RuntimeSnapshot, bindings: RuntimeBindingSnapshot[]): void {
  assertCounterCanAdvance(snapshot.nextScopeId, "nextScopeId");
  snapshot.frames.push({ id: snapshot.nextScopeId, file: null, entry: null, bindings });
  snapshot.nextScopeId += 1;
}

function iterationLength(
  source:
    | SerializableRuntimeList
    | SerializableRuntimeSet
    | SerializableRuntimeRange
    | SerializableRuntimeDict,
): number {
  if (isDict(source)) return source.entries.length;
  return isRange(source) ? rangeLength(source) : source.items.length;
}

function iterationValue(
  source: SerializableRuntimeList | SerializableRuntimeSet | SerializableRuntimeRange,
  position: number,
): SerializableRuntimeValue {
  return isRange(source) ? source.start + position : source.items[position]!;
}

function rangeLength(range: SerializableRuntimeRange): number {
  return Math.max(0, range.end - range.start + (range.inclusive ? 1 : 0));
}

function assertIntegerRange(range: SerializableRuntimeRange, span: SourceSpan): void {
  const length = rangeLength(range);
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    !Number.isSafeInteger(length)
  ) {
    throw fault("TSR045", "Range iteration requires safe integer bounds.", span);
  }
}

function readTemporary(
  temporaries: readonly RuntimeTemporarySnapshot[],
  temporaryId: number,
  span: SourceSpan,
): SerializableRuntimeValue {
  const temporary = temporaries.find((item) => item.id === temporaryId);
  if (temporary === undefined) {
    throw fault("TSR046", `Temporary '${temporaryId}' is not available.`, span);
  }
  return temporary.value;
}

function cloneTemporary(temporary: RuntimeTemporarySnapshot): RuntimeTemporarySnapshot {
  return { id: temporary.id, value: cloneCapturedSerializableValue(temporary.value) };
}

function cloneInteractionUi(
  ui: RuntimeInteractionActionSnapshot["ui"],
): RuntimeInteractionActionSnapshot["ui"] {
  const accessibleName =
    ui.accessibleName.kind === "text"
      ? { kind: "text" as const, text: ui.accessibleName.text }
      : { kind: "localizedDefault" as const, key: ui.accessibleName.key };
  if (ui.kind === "choice") {
    const options = ui.options.map((option) => ({
      text: option.text,
      value: cloneInteractionChoiceValue(option.value),
      ...(option.background === undefined ? {} : { background: option.background }),
    }));
    return { kind: "choice", options, accessibleName };
  }
  if (ui.kind === "button")
    return {
      kind: "button",
      buttonLabel: ui.buttonLabel,
      ...(ui.background === undefined ? {} : { background: ui.background }),
      accessibleName,
    };
  if (ui.kind === "temporal")
    return {
      kind: "temporal",
      temporalKind: ui.temporalKind,
      hint: ui.hint,
      ...(ui.prefill === undefined ? {} : { prefill: ui.prefill }),
      accessibleName,
    };
  if (ui.kind === "image") return cloneImageUi(ui, accessibleName);
  return {
    kind: ui.kind,
    hint: ui.hint,
    ...(ui.prefill === undefined ? {} : { prefill: ui.prefill }),
    ...(ui.kind === "number" && ui.integer === true ? { integer: true as const } : {}),
    accessibleName,
  };
}

function cloneInteractionAction(
  action: RuntimeInteractionActionSnapshot,
): RuntimeInteractionActionSnapshot {
  return {
    kind: "interaction",
    interactionKind: action.interactionKind,
    actionId: action.actionId,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    ownerCallFrameId: action.ownerCallFrameId,
    scopeDepth: action.scopeDepth,
    loopDepth: action.loopDepth,
    destinationTemporary: action.destinationTemporary,
    expectedResult: action.expectedResult,
    target: action.target,
    speakerId: action.speakerId,
    ui: cloneInteractionUi(action.ui),
    createdAtMs: action.createdAtMs,
    timeoutMs: action.timeoutMs,
    requestEventSequence: action.requestEventSequence,
  };
}

/**
 * A `showButton` timeout in milliseconds: a number of seconds or an elapsed duration greater than zero whose deadline
 * is a representable later scene time.
 */
function buttonTimeoutMs(
  value: SerializableRuntimeValue,
  snapshot: RuntimeSnapshot,
  span: SourceSpan,
): number {
  // A calendar duration has no fixed length (V30 §35).
  if (isDuration(value)) exactDurationMilliseconds(value, "A showButton timeout", span);
  const timeoutMs = buttonTimeoutMilliseconds(value);
  if (timeoutMs === null) {
    throw fault(
      "TSR050",
      "The showButton timeout must be a number of seconds or a duration greater than zero, such as 'timeout: 5' or 'timeout: 500 ms'.",
      span,
    );
  }
  const deadlineMs = snapshot.currentSessionTimeMs + timeoutMs;
  if (!isValidSessionTime(deadlineMs) || deadlineMs <= snapshot.currentSessionTimeMs) {
    throw fault(
      "TSR050",
      "The showButton timeout is outside the supported session-time range.",
      span,
    );
  }
  return timeoutMs;
}

function currentCallFrameId(snapshot: RuntimeSnapshot): number | null {
  return snapshot.callFrames.at(-1)?.id ?? null;
}

function currentFrame(snapshot: RuntimeSnapshot) {
  return snapshot.frames.at(-1)!;
}

/** Whether top-level code declares a name that its activation's root already has, as after a goto back. */
function rerunsTopLevelDeclaration(snapshot: RuntimeSnapshot, name: string): boolean {
  const frame = currentFrame(snapshot);
  return frame.file !== null && frame.bindings.some((binding) => binding.name === name);
}

function advance(snapshot: RuntimeSnapshot): void {
  snapshot.nextInstruction += 1;
}

/**
 * A `say` instruction evaluates visible text, pacing, and speaker output before
 * it can know whether its complete transition is representable. Evaluate that
 * work against a private canonical-state clone so a rejected pacing value cannot
 * retain RNG, warning, event, or action changes.
 */
function executeSayAtomically(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "say" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  const stagedSnapshot = sayEvaluatesNoExpression(instruction, snapshot)
    ? expressionFreeSayStagingClone(snapshot)
    : stagingClone(snapshot);
  const stagedEvents: InterpreterEvent[] = [];
  const stagedEvaluator = evaluator.forSnapshot(stagedSnapshot, stagedEvents);

  // Trace records made while staging commit or vanish with the staged state.
  const stage = evaluator.trace?.stage() ?? null;
  try {
    executeSay(plan, instruction, stagedSnapshot, stagedEvaluator, stagedEvents);
  } catch (error) {
    evaluator.trace?.rollback(stage);
    throw error;
  }
  evaluator.trace?.commit(stage);
  Object.assign(snapshot, stagedSnapshot);
  events.push(...stagedEvents);
}

/**
 * A private clone for atomic staging. Retained settlements are replaced, never changed in place, so the clone shares
 * the current one instead of copying its recorded UI for every staged output.
 */
function stagingClone(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  const staged = cloneCapturedRuntimeSnapshot({ ...snapshot, lastSettlement: null });
  staged.lastSettlement = snapshot.lastSettlement;
  return staged;
}

/**
 * Whether `executeSay` evaluates no expression of this say: it releases prepared output, or its text is literal or
 * prepared, without explicit presentation, at smart or instant pacing. Any expression, even a read, can change nested
 * state before a later step rejects the say, so every other say keeps the deep staging clone.
 */
function sayEvaluatesNoExpression(
  instruction: Extract<Instruction, { kind: "say" }>,
  snapshot: RuntimeSnapshot,
): boolean {
  const prepared = snapshot.preparedSayOutput;
  if (prepared !== null && prepared.owningInstruction === snapshot.nextInstruction) return true;
  return (
    (instruction.textTemporary !== undefined || instruction.value.kind === "literal") &&
    instruction.presentation === null &&
    (instruction.pacing === "smart" || instruction.pacing === "instant")
  );
}

/**
 * Staging for a say that evaluates no expression. Such a say replaces root fields and changes only the speaker
 * warning list and the background actions in place, so it copies those and shares everything else read-only. Every
 * field is listed so that a new snapshot field must be classified here.
 */
function expressionFreeSayStagingClone(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  const staged: Required<RuntimeSnapshot> = {
    format: snapshot.format,
    version: snapshot.version,
    nextInstruction: snapshot.nextInstruction,
    frames: snapshot.frames,
    globals: snapshot.globals,
    speakers: snapshot.speakers,
    defaultSpeaker: snapshot.defaultSpeaker,
    contextualSpeaker: snapshot.contextualSpeaker,
    // No random draw is reachable; the copy is constant-size.
    rng: { ...snapshot.rng },
    warnedSpeakerIds: [...snapshot.warnedSpeakerIds],
    loopFrames: snapshot.loopFrames,
    temporaries: snapshot.temporaries,
    callFrames: snapshot.callFrames,
    retainedScopes: snapshot.retainedScopes,
    fallback: snapshot.fallback,
    nextEventSequence: snapshot.nextEventSequence,
    nextScopeId: snapshot.nextScopeId,
    nextSpeakerId: snapshot.nextSpeakerId,
    nextCallFrameId: snapshot.nextCallFrameId,
    currentSessionTimeMs: snapshot.currentSessionTimeMs,
    observedSessionTimeMs: snapshot.observedSessionTimeMs,
    chatPacingSettings: snapshot.chatPacingSettings,
    temporalCaptures: snapshot.temporalCaptures,
    foregroundAction: snapshot.foregroundAction,
    backgroundActions: [...snapshot.backgroundActions],
    nextActionId: snapshot.nextActionId,
    lastSettlement: snapshot.lastSettlement,
    interactionResultHandoff: snapshot.interactionResultHandoff,
    preparedSayOutput: snapshot.preparedSayOutput,
    settledTimers: snapshot.settledTimers,
    nextTimerId: snapshot.nextTimerId,
    pendingTimerHandlers: snapshot.pendingTimerHandlers,
    stageImage: snapshot.stageImage,
    capturedImages: snapshot.capturedImages,
    scriptStorage: snapshot.scriptStorage,
    scriptStoragePersistent: snapshot.scriptStoragePersistent,
    settledMedia: snapshot.settledMedia,
    nextMediaId: snapshot.nextMediaId,
    cameraView: snapshot.cameraView,
    nextPermanentButtonId: snapshot.nextPermanentButtonId,
    maxCallDepth: snapshot.maxCallDepth,
    status: snapshot.status,
    failure: snapshot.failure,
  };
  return staged;
}

function executeSpeakerAtomically(
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
  operation: (stagedSnapshot: RuntimeSnapshot, stagedEvaluator: Evaluator) => void,
): void {
  const stagedSnapshot = stagingClone(snapshot);
  const stagedEvents: InterpreterEvent[] = [];
  const stagedEvaluator = evaluator.forSnapshot(stagedSnapshot, stagedEvents);

  const stage = evaluator.trace?.stage() ?? null;
  try {
    operation(stagedSnapshot, stagedEvaluator);
  } catch (error) {
    evaluator.trace?.rollback(stage);
    throw error;
  }
  evaluator.trace?.commit(stage);
  Object.assign(snapshot, stagedSnapshot);
  events.push(...stagedEvents);
}

function executeSay(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "say" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  const prepared = snapshot.preparedSayOutput;
  if (prepared !== null && prepared.owningInstruction === snapshot.nextInstruction) {
    validatePacingCreation(snapshot, instruction.span, prepared.durationMs);
    snapshot.preparedSayOutput = null;
    const sequence = emitSay(
      snapshot,
      events,
      instruction.span,
      prepared.speaker,
      // Captured markup is mutable; output markup is frozen.
      cloneMessageMarkup(prepared.content),
      prepared.text,
      prepared.presentation,
    );
    evaluator.trace?.releaseOutput(sequence, prepared.owningInstruction, prepared.text);
    establishPacingAfterSay(
      snapshot,
      events,
      instruction.span,
      prepared.durationMs,
      prepared.skippable,
    );
    snapshot.nextInstruction = prepared.continuationInstruction;
    return;
  }

  const preparedSpeaker =
    instruction.speakerTemporary === undefined
      ? (() => {
          const speaker =
            instruction.speaker === null
              ? snapshot.defaultSpeaker === null
                ? null
                : evaluator.speakerById(snapshot.defaultSpeaker, instruction.span)
              : evaluator.speakerByName(instruction.speaker, instruction.span);
          snapshot.contextualSpeaker = speaker?.id ?? null;
          return {
            output:
              speaker === null ? null : evaluator.outputSpeaker(speaker, instruction.span, events),
            speakerId: speaker?.id ?? null,
          };
        })()
      : preparedOutputSpeaker(snapshot.temporaries, instruction.speakerTemporary, instruction.span);
  const output = preparedSpeaker.output;
  const speaker =
    preparedSpeaker.speakerId === null
      ? null
      : evaluator.speakerById(preparedSpeaker.speakerId, instruction.span);
  const presentation = resolveMessagePresentation(
    instruction.presentation === null ? null : evaluator.evaluate(instruction.presentation),
    speaker,
    copySpan(instruction.span),
  );
  // A trace keeps the causes of the text apart from those of speaker, presentation, and pacing.
  const outer = evaluator.trace?.push() ?? null;
  let authoredText: string;
  if (instruction.textTemporary === undefined)
    authoredText = evaluator.sayText(evaluator.evaluate(instruction.value), instruction.value.span);
  else {
    authoredText = preparedSayText(
      snapshot.temporaries,
      instruction.textTemporary,
      instruction.span,
    );
    evaluator.trace?.readTemporary(
      evaluator.callFrameId(),
      instruction.textTemporary,
      authoredText,
    );
  }
  const textCauses = outer === null ? null : evaluator.trace!.pop(outer);
  const content = parseMessageMarkup(authoredText);
  const text = content.visibleText;
  const pacingValue =
    typeof instruction.pacing === "object"
      ? evaluator.evaluate(instruction.pacing)
      : instruction.pacing;
  const durationMs = sayDurationMs(instruction, text, pacingValue, snapshot);
  const skippable = effectiveSaySkippable(instruction.skipPolicy, speaker, instruction.span);
  const activeGate = snapshot.backgroundActions.find(
    (action): action is RuntimeChatPacingGateActionSnapshot => action.kind === "chatPacingGate",
  );
  if (activeGate !== undefined) {
    if (durationMs === 0) {
      assertEventSequenceCapacity(snapshot, 2, instruction.span);
      settleBackgroundPacingGate(plan, snapshot, activeGate, "supersededByInstantOutput", events);
      const sequence = emitSay(
        snapshot,
        events,
        instruction.span,
        output,
        content,
        text,
        presentation,
      );
      if (textCauses !== null) evaluator.trace!.output(sequence, text, textCauses);
      advance(snapshot);
      return;
    }
    const preparedOutput: RuntimePreparedSayOutputSnapshot = Object.freeze({
      owningInstruction: snapshot.nextInstruction,
      continuationInstruction: snapshot.nextInstruction + 1,
      speaker: output === null ? null : { ...output },
      content,
      text,
      presentation,
      durationMs,
      skippable,
    });
    const index = snapshot.backgroundActions.indexOf(activeGate);
    snapshot.backgroundActions.splice(index, 1);
    snapshot.foregroundAction = Object.freeze({ ...activeGate, preparedOutput });
    snapshot.status = "waiting";
    if (textCauses !== null) evaluator.trace!.holdOutput(snapshot.nextInstruction, textCauses);
    return;
  }
  if (durationMs > 0) validatePacingCreation(snapshot, instruction.span, durationMs);
  const sequence = emitSay(snapshot, events, instruction.span, output, content, text, presentation);
  if (textCauses !== null) evaluator.trace!.output(sequence, text, textCauses);
  if (durationMs > 0)
    establishPacingAfterSay(snapshot, events, instruction.span, durationMs, skippable);
  advance(snapshot);
}

function preparedOutputSpeaker(
  temporaries: readonly RuntimeTemporarySnapshot[],
  temporaryId: number,
  span: SourceSpan,
): { readonly output: OutputSpeaker | null; readonly speakerId: number | null } {
  const value = readTemporary(temporaries, temporaryId, span);
  if (value === null) return { output: null, speakerId: null };
  if (!isObject(value)) throw fault("TSR052", "Prepared say speaker is invalid.", span);
  const identifier = getSerializableProperty(value, "identifier");
  const displayName = getSerializableProperty(value, "displayName");
  const color = getSerializableProperty(value, "color");
  const font = getSerializableProperty(value, "font");
  const avatar = getSerializableProperty(value, "avatar");
  const speakerId = getSerializableProperty(value, "speakerId");
  if (
    typeof identifier !== "string" ||
    typeof displayName !== "string" ||
    (typeof color !== "string" && color !== null) ||
    (typeof font !== "string" && font !== null) ||
    (typeof avatar !== "string" && avatar !== null) ||
    typeof speakerId !== "number" ||
    !Number.isSafeInteger(speakerId)
  )
    throw fault("TSR052", "Prepared say speaker is invalid.", span);
  return { output: Object.freeze({ identifier, displayName, color, font, avatar }), speakerId };
}

function preparedSayText(
  temporaries: readonly RuntimeTemporarySnapshot[],
  temporaryId: number,
  span: SourceSpan,
): string {
  const value = readTemporary(temporaries, temporaryId, span);
  if (typeof value !== "string") throw fault("TSR052", "Prepared say text is invalid.", span);
  return value;
}

function sayDurationMs(
  instruction: Extract<Instruction, { kind: "say" }>,
  text: string,
  pacingValue: SerializableRuntimeValue | "smart" | "instant",
  snapshot: RuntimeSnapshot,
): number {
  try {
    if (pacingValue === "instant") return 0;
    if (pacingValue === "smart") {
      return calculateSmartPacingDurationMs(text, snapshot.chatPacingSettings);
    }
    return secondsToPacingMilliseconds(pacingValue);
  } catch (error) {
    if (error instanceof RuntimeFault) throw error;
    throw fault(
      "TSR050",
      error instanceof Error ? error.message : "Say pacing is invalid.",
      instruction.span,
    );
  }
}

function effectiveSaySkippable(
  explicit: "skippable" | "unskippable" | null,
  speaker: RuntimeSpeakerSnapshot | null,
  span: SourceSpan,
): boolean {
  if (explicit === "skippable") return true;
  if (explicit === "unskippable") return false;
  const configured = speaker?.properties.find(
    (property) => property.name === "defaultSaySkippable",
  );
  if (configured === undefined) return true;
  if (typeof configured.value !== "boolean") {
    throw fault("TSR050", "Speaker property 'defaultSaySkippable' must be a boolean.", span);
  }
  return configured.value;
}

function emitSay(
  snapshot: RuntimeSnapshot,
  events: InterpreterEvent[],
  span: SourceSpan,
  speaker: OutputSpeaker | null,
  content: MessageMarkup,
  text: string,
  presentation: MessagePresentation,
): number {
  const sequence = takeSequence(snapshot);
  events.push(
    Object.freeze({
      kind: "say",
      presentation,
      sequence,
      speaker,
      content,
      text,
      span: copySpan(span),
    } satisfies SayEvent),
  );
  return sequence;
}

function establishPacingAfterSay(
  snapshot: RuntimeSnapshot,
  events: InterpreterEvent[],
  span: SourceSpan,
  durationMs: number,
  skippable: boolean,
): void {
  let deadlineMs: number;
  try {
    deadlineMs = calculatePacingDeadlineMs(snapshot.currentSessionTimeMs, durationMs);
  } catch (error) {
    throw fault(
      "TSR050",
      error instanceof Error ? error.message : "Say pacing deadline is invalid.",
      span,
    );
  }
  const requestEventSequence = takeSequence(snapshot);
  const action: RuntimeChatPacingGateActionSnapshot = Object.freeze({
    kind: "chatPacingGate",
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    continuationInstruction: snapshot.nextInstruction + 1,
    ownerCallFrameId: currentCallFrameId(snapshot),
    scopeDepth: snapshot.frames.length,
    loopDepth: snapshot.loopFrames.length,
    createdAtMs: snapshot.currentSessionTimeMs,
    deadlineMs,
    skippable,
    requestEventSequence,
    preparedOutput: null,
  });
  snapshot.nextActionId += 1;
  snapshot.backgroundActions.push(action);
  const requestEvent: ActionRequestedEvent = Object.freeze({
    kind: "actionRequested",
    sequence: requestEventSequence,
    action: { ...action },
    span: copySpan(span),
  });
  events.push(requestEvent);
}

function validatePacingCreation(
  snapshot: RuntimeSnapshot,
  span: SourceSpan,
  durationMs: number,
): void {
  if (
    !Number.isSafeInteger(snapshot.nextActionId) ||
    snapshot.nextActionId >= Number.MAX_SAFE_INTEGER
  ) {
    throw fault("TSR051", "Runtime action ID space is exhausted.", span);
  }
  assertEventSequenceCapacity(snapshot, requiredEventSequencesForNewPacingGate(), span);
  try {
    calculatePacingDeadlineMs(snapshot.currentSessionTimeMs, durationMs);
  } catch (error) {
    throw fault(
      "TSR050",
      error instanceof Error ? error.message : "Say pacing deadline is invalid.",
      span,
    );
  }
}

/** A positive say emits output, requests its gate, and reserves its completion. */
function requiredEventSequencesForNewPacingGate(): number {
  const sayOutput = 1;
  const pacingRequest = 1;
  const pacingCompletion = 1;
  return sayOutput + pacingRequest + pacingCompletion;
}

/** A new wait needs its request and completion, plus a background gate completion. */
function requiredEventSequencesForNewDelay(snapshot: RuntimeSnapshot): number {
  const delayRequestAndCompletion = 2;
  const backgroundPacingCompletion = snapshot.backgroundActions.some(
    (action) => action.kind === "chatPacingGate",
  )
    ? 1
    : 0;
  return delayRequestAndCompletion + backgroundPacingCompletion;
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
 * at the next instruction. The budget counts the whole invocation, including earlier loops and waits that catch-up
 * settled, so the message names the limit rather than the work of that loop.
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
    { code: "TSR037", message, span: copySpan(span) },
    instructionSourcePath(plan, index),
    events,
  );
}

function instructionBudget(value: number | undefined): number {
  const budget = value ?? 1_000_000;
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new RangeError("Instruction budget must be a positive safe integer.");
  }
  return budget;
}

/**
 * Converts an evaluated `wait`/`timer` duration to milliseconds: a duration value, a number of `unit` (seconds by
 * default), or, for timers, an integer-second range drawn once from the session RNG. Invalid ranges fail before the draw.
 */
export function timerDurationMs(
  evaluator: Evaluator,
  value: SerializableRuntimeValue,
  unit: DurationUnitPlan | null,
  command: "wait" | "timer",
  span: SourceSpan,
): number {
  const range =
    command === "timer" && isRange(value) && (unit === null || unit === "s") ? value : null;
  const drawn =
    range === null || range.start < 0
      ? value
      : evaluator.randomIntegerInRange(range, span, "timer", "duration");
  const amount =
    isDuration(drawn) && unit === null
      ? exactDurationMilliseconds(drawn, command === "timer" ? "A timer" : "wait", span)
      : drawn;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw fault(
      "TSR050",
      command === "timer"
        ? "Timer duration must be a non-negative duration, number of seconds, or range of whole seconds."
        : "Wait duration must be a non-negative duration or finite number.",
      span,
    );
  }
  const durationMs = isDuration(drawn) ? amount : amount * DURATION_UNIT_MILLISECONDS[unit ?? "s"];
  if (!Number.isFinite(durationMs)) {
    throw fault(
      "TSR050",
      `${commandName(command)} duration is outside the supported session-time range.`,
      span,
    );
  }
  return durationMs;
}

/** Absolute deadline for a positive duration; `0` stays immediate. */
export function futureDeadline(
  snapshot: RuntimeSnapshot,
  durationMs: number,
  command: "wait" | "timer",
  span: SourceSpan,
): number {
  const deadlineMs = snapshot.currentSessionTimeMs + durationMs;
  if (!isValidSessionTime(deadlineMs)) {
    throw fault(
      "TSR050",
      `${commandName(command)} duration is outside the supported session-time range.`,
      span,
    );
  }
  if (durationMs > 0 && deadlineMs <= snapshot.currentSessionTimeMs) {
    throw fault(
      "TSR050",
      `${commandName(command)} duration cannot produce a representable future deadline.`,
      span,
    );
  }
  return deadlineMs;
}

function commandName(command: "wait" | "timer"): string {
  return command === "timer" ? "Timer" : "Wait";
}

export function timerLabel(value: SerializableRuntimeValue, span: SourceSpan): string {
  if (isList(value))
    throw fault(
      "TSR050",
      'A list cannot be a timer label. Select one element with "${list}" or list.random.',
      span,
    );
  if (typeof value !== "string") throw fault("TSR050", "A timer label must be a string.", span);
  return value;
}

/**
 * Starts an asynchronous timer as background timed work and, when used as a value, stores its handle. Operands are
 * evaluated in plan order before a range is drawn. A zero first round expires at once and queues its expiry block.
 */
function startTimer(
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
  const range =
    instruction.repeat &&
    isRange(duration) &&
    (instruction.unit === null || instruction.unit === "s")
      ? duration
      : null;
  const zeroRoundFault = () =>
    fault(
      "TSR050",
      "A repeating timer needs every round to last longer than zero.",
      instruction.duration.span,
    );
  // A range that allows a zero-length round is rejected before its first round is drawn.
  if (range !== null && range.start < 1) throw zeroRoundFault();
  const roundDurationMs = timerDurationMs(
    evaluator,
    duration,
    instruction.unit,
    "timer",
    instruction.duration.span,
  );
  if (instruction.repeat && roundDurationMs <= 0) throw zeroRoundFault();
  const deadlineMs = futureDeadline(snapshot, roundDurationMs, "timer", instruction.duration.span);
  if (
    !Number.isSafeInteger(snapshot.nextActionId) ||
    snapshot.nextActionId >= Number.MAX_SAFE_INTEGER
  ) {
    throw fault("TSR051", "Runtime action ID space is exhausted.", instruction.span);
  }
  assertCounterCanAdvance(snapshot.nextTimerId, "nextTimerId");
  // The request, its eventual settlement, and the other active actions' completions must stay representable.
  assertEventSequenceCapacity(
    snapshot,
    2 + requiredFutureActionCompletionEvents(snapshot),
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
        range === null ? null : { start: range.start, end: range.end, inclusive: range.inclusive },
      repeatDurationMs: instruction.repeat && range === null ? roundDurationMs : null,
      roundDurationMs,
      deadlineMs,
      remainingMs: null,
      elapsedMs: 0,
      runningSinceMs: snapshot.currentSessionTimeMs,
      anchoredRounds: instruction.repeat && range === null ? 0 : null,
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
    );
  }
  advance(snapshot);
}

/**
 * `showImage` sets the persistent Stage image and `hideImage` clears it; `null` clears it with a developer warning.
 * Either replaces an active Stage video, which stops.
 */
function showImage(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "showImage" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  const image = instruction.image === null ? null : evaluator.evaluate(instruction.image);
  if (image !== null && typeof image !== "string") {
    throw fault("TSR050", "showImage needs an image file reference or null.", instruction.span);
  }
  if (instruction.image !== null && image === null) {
    emitDeveloperWarning(
      snapshot,
      events,
      "TSW011",
      "showImage received null; the Stage shows no image.",
      instruction.span,
    );
  }
  stopStageVideo(plan, snapshot, events, instruction.span);
  snapshot.stageImage = image;
  evaluator.trace?.image(image);
  advance(snapshot);
}

/**
 * `save` and `delete`. Session-local storage changes at once. Persistent storage waits for the host's acknowledgement:
 * the view changes only when the host reports the write as stored.
 */
function writeStorage(
  instruction: Extract<Instruction, { kind: "storageWrite" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  // Copy the value before the key runs: the key expression may change a borrowed collection.
  const value =
    instruction.value === null
      ? null
      : cloneCapturedSerializableValue(evaluator.evaluate(instruction.value));
  const key = storageKey(
    evaluator.evaluate(instruction.key),
    WRITE_KEY_MESSAGE,
    instruction.key.span,
  );
  assertPersistable(value, instruction.span);
  if (!snapshot.scriptStoragePersistent) {
    writeScriptStorage(snapshot, key, value);
    evaluator.trace?.storage(key, value);
    advance(snapshot);
    return;
  }
  if (
    !Number.isSafeInteger(snapshot.nextActionId) ||
    snapshot.nextActionId >= Number.MAX_SAFE_INTEGER
  ) {
    throw fault("TSR051", "Runtime action ID space is exhausted.", instruction.span);
  }
  // The request, the completion, a possible failure warning, and every active action's own completions.
  assertEventSequenceCapacity(
    snapshot,
    3 + requiredFutureActionCompletionEvents(snapshot),
    instruction.span,
  );
  const requestSequence = takeSequence(snapshot);
  const write: RuntimeStorageWriteActionSnapshot = Object.freeze({
    kind: "storageWrite",
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    continuationInstruction: snapshot.nextInstruction + 1,
    ownerCallFrameId: snapshot.callFrames.at(-1)?.id ?? null,
    scopeDepth: snapshot.frames.length,
    loopDepth: snapshot.loopFrames.length,
    createdAtMs: snapshot.currentSessionTimeMs,
    key,
    value,
    requestEventSequence: requestSequence,
  });
  snapshot.nextActionId += 1;
  snapshot.foregroundAction = write;
  snapshot.status = "waiting";
  evaluator.trace?.awaitStorage(write.actionId, key, value);
  events.push(
    Object.freeze({
      kind: "actionRequested",
      sequence: requestSequence,
      action: { ...write, value: cloneCapturedSerializableValue(value) },
      span: copySpan(instruction.span),
    } satisfies ActionRequestedEvent),
  );
}

/** A media position or duration: a duration value or a number of seconds, finite and not negative. */
function mediaMilliseconds(
  value: SerializableRuntimeValue,
  subject: string,
  span: SourceSpan,
): number {
  const milliseconds = isDuration(value)
    ? exactDurationMilliseconds(value, subject, span)
    : typeof value === "number"
      ? value * 1_000
      : Number.NaN;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw fault(
      "TSR050",
      `Media ${subject} must be a non-negative duration or number of seconds.`,
      span,
    );
  }
  return milliseconds;
}

function mediaRepeat(
  instruction: Extract<Instruction, { kind: "playMedia" }>,
  value: SerializableRuntimeValue,
): RuntimeMediaRepeatSnapshot {
  const repeat = instruction.repeat;
  if (repeat.kind === "once" || repeat.kind === "indefinite") return { kind: repeat.kind };
  if (repeat.kind === "times") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw fault(
        "TSR050",
        "A media repeat count must be a whole number of at least 1.",
        repeat.count.span,
      );
    }
    return { kind: "count", passes: value };
  }
  if (value === true) return { kind: "indefinite" };
  if (value === false) return { kind: "once" };
  if (isDuration(value)) {
    // A calendar duration has no fixed length (V30 §35), whatever its exact part.
    const milliseconds = exactDurationMilliseconds(value, "A repeat budget", repeat.value.span);
    if (Number.isFinite(milliseconds) && milliseconds > 0) return { kind: "budget", milliseconds };
  }
  throw fault(
    "TSR050",
    "Media repeat must be true, false, a count such as '3 times', or a positive duration.",
    repeat.value.span,
  );
}

/**
 * Starts audio or video. Operands are evaluated in plan order and validated before any state changes. The script then
 * waits: an async play until the Player reports the load result, a blocking play until the media ends. A new video
 * replaces an active Stage video. A `null` file plays nothing, with a developer warning.
 */
function startMedia(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "playMedia" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  const file = evaluator.evaluate(instruction.file);
  const repeatValue =
    instruction.repeat.kind === "value"
      ? evaluator.evaluate(instruction.repeat.value)
      : instruction.repeat.kind === "times"
        ? evaluator.evaluate(instruction.repeat.count)
        : null;
  const startAt = instruction.startAt === null ? null : evaluator.evaluate(instruction.startAt);
  const endAt = instruction.endAt === null ? null : evaluator.evaluate(instruction.endAt);
  const volume = instruction.volume === null ? null : evaluator.evaluate(instruction.volume);
  const offsets = instruction.cues.map((cue) => evaluator.evaluate(cue.offset));
  if (file !== null && typeof file !== "string") {
    throw fault("TSR050", "Media file must be a file reference or null.", instruction.file.span);
  }
  const repeat = mediaRepeat(instruction, repeatValue);
  if (!instruction.async && repeat.kind === "indefinite") {
    throw fault("TSR050", "Blocking media cannot repeat indefinitely.", instruction.span);
  }
  if (repeat.kind === "indefinite" && instruction.finishFunctionId !== null) {
    throw fault(
      "TSR050",
      "'finish' never runs for media that repeats indefinitely; stop() does not run it.",
      instruction.span,
    );
  }
  // A supplied option is validated even when it evaluates to null; only an omitted option takes its default.
  const startAtMs =
    instruction.startAt === null
      ? 0
      : mediaMilliseconds(startAt, "startAt", instruction.startAt.span);
  const endAtMs =
    instruction.endAt === null ? null : mediaMilliseconds(endAt, "endAt", instruction.endAt.span);
  if (instruction.endAt !== null && endAtMs !== null && endAtMs <= startAtMs) {
    throw fault("TSR050", "Media endAt must be later than startAt.", instruction.endAt.span);
  }
  if (
    instruction.volume !== null &&
    (typeof volume !== "number" || !(volume >= 0 && volume <= 1))
  ) {
    throw fault(
      "TSR050",
      "Media volume must be a number from 0 through 1.",
      instruction.volume.span,
    );
  }
  const cues = instruction.cues.map((cue, index) => ({
    kind: cue.kind,
    offsetMs: mediaMilliseconds(offsets[index]!, `${cue.kind} position`, cue.offset.span),
    functionId: cue.functionId,
  }));
  if (
    !Number.isSafeInteger(snapshot.nextActionId) ||
    snapshot.nextActionId >= Number.MAX_SAFE_INTEGER - 1
  ) {
    throw fault("TSR051", "Runtime action ID space is exhausted.", instruction.span);
  }
  assertCounterCanAdvance(snapshot.nextMediaId, "nextMediaId");
  // Two requests, their eventual completions, a possible warning, and the other active actions' completions.
  assertEventSequenceCapacity(
    snapshot,
    5 + requiredFutureActionCompletionEvents(snapshot),
    instruction.span,
  );
  const captures = resolveCaptures(snapshot, instruction.captures, instruction.span);
  if (instruction.media === "video") stopStageVideo(plan, snapshot, events, instruction.span);
  const mediaId = snapshot.nextMediaId;
  const mediaSequence = takeSequence(snapshot);
  const action: RuntimeMediaActionSnapshot = {
    kind: "media",
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    createdAtMs: snapshot.currentSessionTimeMs,
    requestEventSequence: mediaSequence,
    media: {
      mediaId,
      handlerRootScopeId:
        instruction.cues.length > 0 || instruction.finishFunctionId !== null
          ? contextRootId(snapshot)
          : null,
      captures,
      media: instruction.media,
      source: file ?? "",
      state: "running",
      loaded: false,
      durationMs: null,
      startAtMs,
      endAtMs,
      volume: typeof volume === "number" ? volume : 1,
      repeat,
      cues,
      finishFunctionId: instruction.finishFunctionId,
      segment: 0,
      committedProgressMs: 0,
      positionMs: startAtMs,
      elapsedMs: 0,
      passesCompleted: 0,
      segmentPositionMs: startAtMs,
      segmentPasses: 0,
      segmentElapsedMs: 0,
      startCuesPending: false,
      points: [],
    },
  };
  snapshot.nextActionId += 1;
  snapshot.nextMediaId += 1;
  snapshot.backgroundActions.push(action);
  if (instruction.destinationTemporary !== null) {
    const handle = { kind: "mediaHandle" as const, mediaId };
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
      sequence: mediaSequence,
      action: { ...action, media: cloneMedia(action.media) },
      span: copySpan(instruction.span),
    } satisfies ActionRequestedEvent),
  );
  if (file === null) {
    emitDeveloperWarning(
      snapshot,
      events,
      "TSW011",
      `${instruction.media === "audio" ? "playAudio" : "playVideo"} received null; nothing plays.`,
      instruction.span,
    );
    stopMediaAction(plan, snapshot, action, events, instruction.span);
    advance(snapshot);
    return;
  }
  const waitSequence = takeSequence(snapshot);
  const wait: RuntimeMediaPlaybackActionSnapshot = Object.freeze({
    kind: "mediaPlayback",
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    continuationInstruction: snapshot.nextInstruction + 1,
    ownerCallFrameId: snapshot.callFrames.at(-1)?.id ?? null,
    scopeDepth: snapshot.frames.length,
    loopDepth: snapshot.loopFrames.length,
    createdAtMs: snapshot.currentSessionTimeMs,
    mediaId,
    until: instruction.async ? "loaded" : "ended",
    requestEventSequence: waitSequence,
  });
  snapshot.nextActionId += 1;
  snapshot.foregroundAction = wait;
  snapshot.status = "waiting";
  events.push(
    Object.freeze({
      kind: "actionRequested",
      sequence: waitSequence,
      action: { ...wait },
      span: copySpan(instruction.span),
    } satisfies ActionRequestedEvent),
  );
}

/**
 * Main-story media presentation waits for the previous message's pacing, like a later `say`: an active background
 * pacing gate becomes the foreground action without prepared output, and this barrier runs again once it settles.
 * A barrier with a receiver waits only when that receiver is a media handle. Interrupt blocks, and functions they
 * call, keep the canonical interrupt pacing behavior, so a barrier never waits while one runs.
 */
function executePacingBarrier(
  instruction: Extract<Instruction, { kind: "pacingBarrier" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
): void {
  const gate = snapshot.backgroundActions.find(
    (action): action is RuntimeChatPacingGateActionSnapshot => action.kind === "chatPacingGate",
  );
  if (
    gate !== undefined &&
    !interruptRunning(snapshot) &&
    (instruction.receiver === null || isPacedHandle(evaluator.evaluate(instruction.receiver)))
  ) {
    snapshot.backgroundActions.splice(snapshot.backgroundActions.indexOf(gate), 1);
    snapshot.foregroundAction = Object.freeze({ ...gate, preparedOutput: null });
    snapshot.status = "waiting";
    return;
  }
  advance(snapshot);
}

/**
 * Shows a permanent button after the shown ones, as background work that waits for clicks. Its block runs for the
 * activation that showed it, like a timer's, and the script continues at once.
 */
function showPermanentButton(
  instruction: Extract<Instruction, { kind: "showPermanentButton" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  const span = copySpan(instruction.span);
  const text = fieldText(
    evaluator.evaluate(instruction.text),
    span,
    currentTemporalContext(snapshot),
  );
  if (
    !Number.isSafeInteger(snapshot.nextActionId) ||
    snapshot.nextActionId >= Number.MAX_SAFE_INTEGER
  ) {
    throw fault("TSR051", "Runtime action ID space is exhausted.", instruction.span);
  }
  assertCounterCanAdvance(snapshot.nextPermanentButtonId, "nextPermanentButtonId");
  // The request, its eventual removal, and the other active actions' completions must stay representable.
  assertEventSequenceCapacity(
    snapshot,
    2 + requiredFutureActionCompletionEvents(snapshot),
    instruction.span,
  );
  const captures = resolveCaptures(snapshot, instruction.captures, instruction.span);
  const sequence = takeSequence(snapshot);
  const buttonId = snapshot.nextPermanentButtonId;
  const action: RuntimePermanentButtonActionSnapshot = {
    kind: "permanentButton",
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    createdAtMs: snapshot.currentSessionTimeMs,
    requestEventSequence: sequence,
    button: {
      buttonId,
      text,
      persist: instruction.persist,
      handlerFunctionId: instruction.handlerFunctionId,
      rootScopeId: contextRootId(snapshot),
      captures,
    },
  };
  snapshot.nextActionId += 1;
  snapshot.nextPermanentButtonId += 1;
  snapshot.backgroundActions.push(action);
  if (instruction.destinationTemporary !== null) {
    const handle = { kind: "permanentButtonHandle" as const, buttonId };
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
      action: { ...action, button: { ...action.button } },
      span,
    } satisfies ActionRequestedEvent),
  );
  advance(snapshot);
}

/** Handles whose property writes wait for the previous message's pacing: media playback and camera views. */
function isPacedHandle(value: SerializableRuntimeValue): boolean {
  return isMediaHandle(value) || isCameraView(value);
}

export function timerDisplay(value: SerializableRuntimeValue, span: SourceSpan): DelayDisplay {
  if (value === "visible" || value === "mystery" || value === "hidden") return value;
  throw fault("TSR050", 'Timer display must be "visible", "mystery", or "hidden".', span);
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}

/**
 * The tags of `takePhoto(tags: …)`: a list or set of texts such as `"bedroom"` or `"punishment: 4"`, read as tags in name
 * order. A repeated tag counts once, and its number wins; anything else fails before the capture is requested.
 */
function captureTags(value: SerializableRuntimeValue, span: SourceSpan): readonly PlanTag[] {
  if (!isList(value) && !isSet(value)) {
    throw fault(
      "TSR083",
      `takePhoto(tags:) takes a list of tags, but this is ${describeRuntimeValue(value)}.`,
      span,
    );
  }
  const tags = new Map<string, Tag>();
  for (const item of value.items) {
    const tag = typeof item === "string" ? readTagText(item) : null;
    if (tag === null) {
      throw fault(
        "TSR083",
        `takePhoto(tags:) takes tags such as "bedroom" or "punishment: 4", but it holds ${typeof item === "string" ? `'${item}'` : describeRuntimeValue(item)}.`,
        span,
      );
    }
    if (addTag(tags, tag) === "conflict") {
      throw fault(
        "TSR083",
        `takePhoto(tags:) gives the tag '${tag.name}' two different numbers.`,
        span,
      );
    }
  }
  return [...tags.values()]
    .sort((left, right) => (left.name < right.name ? -1 : 1))
    .map((tag) => Object.freeze({ name: tag.name, value: tag.value }));
}
