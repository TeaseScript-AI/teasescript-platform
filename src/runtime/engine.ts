import type {
  Instruction,
  InstructionPlan,
  InteractionUiPayload,
  PlanSourceLocation,
  PreparedInteractionUiPayload,
} from "../plan/model.js";
import { parseMessageMarkup, type MessageMarkup } from "../message-markup.js";
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
export type {
  ActionCompletionOutcome,
  PendingActionOperationResult,
  RuntimeOperationResult,
  TimeObservationOutcome,
} from "./operations/model.js";
export { RuntimeDataError } from "./operations/support.js";
import type {
  ActionRequestedEvent,
  CompleteEvent,
  ExitEvent,
  InterpreterEvent,
  OutputSpeaker,
  RuntimeFailureEvent,
  SayEvent,
} from "./events.js";
import type { XorShift32State } from "./random.js";
import {
  cloneCapturedSerializableValue,
  createCapturedSerializableList,
  createCapturedSerializableObject,
  getSerializableProperty,
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
} from "./state.js";
import type {
  RuntimeChatPacingGateActionSnapshot,
  RuntimeInteractionActionSnapshot,
  RuntimePreparedSayOutputSnapshot,
} from "./actions/model.js";
import { isValidSessionTime } from "./actions/delay.js";
import {
  calculatePacingDeadlineMs,
  calculateSmartPacingDurationMs,
  secondsToPacingMilliseconds,
} from "./actions/pacing.js";
import { settleBackgroundPacingGate } from "./operations/pacing-gate.js";
import { isList, isObject, isRange, isSet, isSpeakerReference } from "./value-predicates.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

export interface RuntimeRunOptions {
  readonly instructionBudget?: number;
}

export function executeInstruction(
  plan: InstructionPlan,
  inputSnapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
): RuntimeOperationResult {
  const captured = captureExecutableData(plan, inputSnapshot);
  const context = new RuntimeExecutionContext(captured.snapshot, capabilities);
  const instructionsExecuted = executeCapturedInstruction(
    captured.plan,
    captured.snapshot,
    context,
  );
  return result(captured.snapshot, context.events, instructionsExecuted);
}

function executeCapturedInstruction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  context: RuntimeExecutionContext,
): number {
  if (snapshot.status === "halted" || snapshot.status === "failed") {
    return 0;
  }
  if (snapshot.status === "waiting") return 0;
  if (snapshot.nextInstruction === plan.rootEndInstruction && snapshot.callFrames.length === 0) {
    const completeEventAndFutureCompletions = requiredEventSequencesForRootCompletion(snapshot);
    assertEventSequenceCapacity(snapshot, completeEventAndFutureCompletions);
    snapshot.terminalContinuationHandoff = null;
    snapshot.status = "halted";
    const terminalInstruction = plan.instructions[plan.rootEndInstruction - 1];
    context.events.push(
      createCompleteEvent(snapshot, terminalInstruction?.span ?? plan.sourceSpan),
    );
    return 1;
  }
  const instructionIndex = snapshot.nextInstruction;
  const instruction = plan.instructions[instructionIndex];
  if (instruction === undefined) {
    snapshot.status = "halted";
    return 0;
  }

  snapshot.status = "running";
  const evaluator = context.evaluator();
  try {
    executePlannedInstruction(plan, instruction, snapshot, evaluator, context.events);
    if (snapshot.interactionResultHandoff?.continuationInstruction === instructionIndex) {
      snapshot.interactionResultHandoff = null;
    }
    if (
      snapshot.status === "running" &&
      snapshot.callFrames.length === 0 &&
      snapshot.nextInstruction === plan.rootEndInstruction
    ) {
      snapshot.status = "halted";
      const completeEventAndFutureCompletions = requiredEventSequencesForRootCompletion(snapshot);
      assertEventSequenceCapacity(snapshot, completeEventAndFutureCompletions);
      context.events.push(createCompleteEvent(snapshot, instruction.span));
    }
  } catch (error) {
    if (!(error instanceof RuntimeFault)) throw error;
    failSnapshot(snapshot, error.toInfo(), context.events);
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
  return stepValidatedStateToEvent(captured.plan, captured.snapshot, capabilities, options);
}

/** Steps engine-owned plan/state that already passed complete validation. */
export function stepValidatedStateToEvent(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: RuntimeRunOptions = {},
): RuntimeOperationResult {
  const budget = instructionBudget(options.instructionBudget);
  const context = new RuntimeExecutionContext(snapshot, capabilities);
  let instructionsExecuted = 0;
  while (
    snapshot.status !== "waiting" &&
    snapshot.status !== "halted" &&
    snapshot.status !== "failed" &&
    context.events.length === 0
  ) {
    if (instructionsExecuted >= budget) {
      failForBudget(plan, snapshot, context.events);
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
  return runValidatedState(captured.plan, captured.snapshot, capabilities, options);
}

/** Runs engine-owned plan/state that already passed complete validation. */
export function runValidatedState(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: RuntimeRunOptions = {},
): RuntimeOperationResult {
  const budget = instructionBudget(options.instructionBudget);
  const context = new RuntimeExecutionContext(snapshot, capabilities);
  let instructionsExecuted = 0;
  while (
    snapshot.status !== "waiting" &&
    snapshot.status !== "halted" &&
    snapshot.status !== "failed"
  ) {
    if (instructionsExecuted >= budget) {
      failForBudget(plan, snapshot, context.events);
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
    case "declareSpeaker": {
      executeSpeakerAtomically(snapshot, evaluator, events, (stagedSnapshot, stagedEvaluator) => {
        if (findBinding(stagedSnapshot, instruction.name) !== undefined) {
          throw fault(
            "TSR001",
            `Speaker '${instruction.name}' is already visible in this scope.`,
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
        currentFrame(stagedSnapshot).bindings.push({
          name: instruction.name,
          value: { kind: "speakerReference", speakerId: speaker.id, identifier: instruction.name },
        });
        stagedSnapshot.contextualSpeaker = speaker.id;
        for (const property of instruction.properties) {
          if (speaker.properties.some((item) => item.name === property.name)) {
            throw fault("TSR007", `Duplicate speaker property '${property.name}'.`, property.span);
          }
          const propertyValue = cloneCapturedSerializableValue(
            stagedEvaluator.evaluate(property.value),
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
        advance(stagedSnapshot);
      });
      return;
    }
    case "setDeclaredSpeakerProperty": {
      executeSpeakerAtomically(snapshot, evaluator, events, (stagedSnapshot, stagedEvaluator) => {
        const speaker = stagedEvaluator.speakerByName(instruction.speaker, instruction.span);
        if (speaker.properties.some((property) => property.name === instruction.name)) {
          throw fault(
            "TSR007",
            `Duplicate speaker property '${instruction.name}'.`,
            instruction.span,
          );
        }
        stagedSnapshot.contextualSpeaker = speaker.id;
        const propertyValue = cloneCapturedSerializableValue(
          stagedEvaluator.evaluate(instruction.value),
        );
        if (instruction.name === "defaultSaySkippable" && typeof propertyValue !== "boolean") {
          throw fault(
            "TSR050",
            "Speaker property 'defaultSaySkippable' must be a boolean.",
            instruction.span,
          );
        }
        speaker.properties.push({ name: instruction.name, value: propertyValue });
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
      snapshot.frames.push({ id: snapshot.nextScopeId, bindings: [] });
      snapshot.nextScopeId += 1;
      advance(snapshot);
      return;
    case "leaveScope":
      if (snapshot.frames.length === 1) {
        throw fault("TSR033", "Cannot leave the root lexical scope.", instruction.span);
      }
      snapshot.frames.pop();
      advance(snapshot);
      return;
    case "declareBinding": {
      if (findBinding(snapshot, instruction.name) !== undefined) {
        throw fault(
          "TSR001",
          `Variable '${instruction.name}' is already visible in this scope.`,
          instruction.span,
        );
      }
      currentFrame(snapshot).bindings.push({
        name: instruction.name,
        value: cloneCapturedSerializableValue(evaluator.evaluate(instruction.value)),
      });
      advance(snapshot);
      return;
    }
    case "prepareReference":
      setCapturedTemporary(
        snapshot.temporaries,
        instruction.destinationTemporary,
        evaluator.prepareReference(instruction.expression),
      );
      advance(snapshot);
      return;
    case "validateAssignmentTarget":
      evaluator.validateAssignmentTarget(instruction.target);
      advance(snapshot);
      return;
    case "assign":
      evaluator.assign(instruction.target, evaluator.evaluate(instruction.value));
      advance(snapshot);
      return;
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
      setCapturedTemporary(
        snapshot.temporaries,
        instruction.destinationTemporary,
        evaluator.visibleText(evaluator.evaluate(instruction.value), instruction.value.span),
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
      bindSuppliedParameter(plan, instruction, snapshot);
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
    case "returnValue":
      returnFromFunction(plan, snapshot, evaluator.evaluate(instruction.value), instruction.span);
      return;
    case "returnVoid":
      returnFromFunction(plan, snapshot, null, instruction.span);
      return;
    case "say": {
      executeSayAtomically(plan, instruction, snapshot, evaluator, events);
      return;
    }
    case "wait": {
      const value = evaluator.evaluate(instruction.duration);
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw fault(
          "TSR050",
          "Wait duration must be a finite non-negative number.",
          instruction.duration.span,
        );
      }
      const multiplier =
        instruction.unit === "ms"
          ? 1
          : instruction.unit === "min"
            ? 60_000
            : instruction.unit === "h"
              ? 3_600_000
              : 1_000;
      const durationMs = value * multiplier;
      const deadlineMs = snapshot.currentSessionTimeMs + durationMs;
      if (!Number.isFinite(durationMs) || !isValidSessionTime(deadlineMs)) {
        throw fault(
          "TSR050",
          "Wait duration is outside the supported session-time range.",
          instruction.duration.span,
        );
      }
      if (value > 0 && (durationMs <= 0 || deadlineMs <= snapshot.currentSessionTimeMs)) {
        throw fault(
          "TSR050",
          "Wait duration cannot produce a representable future deadline.",
          instruction.duration.span,
        );
      }
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
            snapshot.rng,
            evaluator,
            instruction.span,
          )
        : { ui: instruction.ui, stagedWrites: [] as const, rngState: snapshot.rng.state };
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
        requestEventSequence: sequence,
      });
      commitInteractionMaterialization(snapshot, materialized.stagedWrites, materialized.rngState);
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
    case "exit":
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
      snapshot.terminalContinuationHandoff = null;
      snapshot.defaultSpeaker = null;
      snapshot.contextualSpeaker = null;
      snapshot.frames.splice(1);
      snapshot.loopFrames.length = 0;
      snapshot.callFrames.length = 0;
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
  readonly rngState: number;
}

function materializeInteractionUi(
  prepared: PreparedInteractionUiPayload,
  temporaries: RuntimeTemporarySnapshot[],
  canonicalRng: XorShift32State,
  evaluator: Evaluator,
  span: SourceSpan,
): MaterializedInteractionUi {
  const stagedRng: XorShift32State = {
    algorithm: canonicalRng.algorithm,
    state: canonicalRng.state,
  };
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
    const text = evaluator.visibleTextWithRng(temporary.value, span, stagedRng);
    stagedWrites.push({ temporaryId: temporary.id, value: text });
    return text;
  };

  let ui: InteractionUiPayload;
  if (prepared.kind === "button") {
    ui = {
      kind: "button",
      buttonLabel: readText(prepared.buttonLabelTemporary),
      accessibleName: prepared.accessibleName,
    };
  } else if (prepared.kind === "text" || prepared.kind === "number") {
    ui = {
      kind: prepared.kind,
      hint: prepared.hintTemporary === null ? null : readText(prepared.hintTemporary),
      accessibleName: prepared.accessibleName,
    };
  } else {
    const source = read(prepared.optionsTemporary);
    if (!isList(source.value) || source.value.items.length !== prepared.optionCount) {
      throw fault(
        "TSR052",
        "Prepared choice options do not match the canonical option count.",
        span,
      );
    }
    const texts = source.value.items.map((value) =>
      evaluator.visibleTextWithRng(value, span, stagedRng),
    );
    const labels = prepared.labelType === "none" ? null : prepared.labels;
    if (prepared.labelType !== "none" && (labels === null || labels.length !== texts.length)) {
      throw fault(
        "TSR052",
        "Prepared choice labels do not match the canonical option count.",
        span,
      );
    }
    ui = {
      kind: "choice",
      labelType: prepared.labelType,
      options: texts.map((text, index) => ({ text, label: labels?.[index] ?? null })),
      accessibleName: prepared.accessibleName,
    };
    stagedWrites.push({ temporaryId: source.id, value: createCapturedSerializableList(texts) });
  }

  assertInteractionUiLimits(ui, span);
  if (ui.kind === "choice" && ui.labelType === "none") {
    const visible = new Set<string>();
    for (const option of ui.options) {
      if (visible.has(option.text))
        throw fault("TSR052", "Unlabelled choice text must evaluate to unique strings.", span);
      visible.add(option.text);
    }
  }
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
    rngState: stagedRng.state,
  });
}

function commitInteractionMaterialization(
  snapshot: RuntimeSnapshot,
  stagedWrites: readonly {
    readonly temporaryId: number;
    readonly value: SerializableRuntimeValue;
  }[],
  rngState: number,
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
  snapshot.rng.state = rngState;
}

function assertInteractionUiLimits(ui: InteractionUiPayload, span: SourceSpan): void {
  const strings: string[] = [];
  if (ui.accessibleName.kind === "text") strings.push(ui.accessibleName.text);
  if (ui.kind === "button") strings.push(ui.buttonLabel);
  else if (ui.kind === "text" || ui.kind === "number") {
    if (ui.hint !== null) strings.push(ui.hint);
  } else {
    for (const option of ui.options) {
      strings.push(option.text);
      if (typeof option.label === "string") strings.push(option.label);
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
  const supplied = new Map(
    instruction.arguments.map((argument) => [
      argument.parameterName,
      cloneCapturedSerializableValue(evaluator.evaluate(argument.value)),
    ]),
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
    id: snapshot.nextCallFrameId,
    functionId: definition.id,
    functionName: definition.name,
    callSiteSpan: copySpan(instruction.span),
    returnInstruction: instruction.returnInstruction,
    destinationTemporary: instruction.destinationTemporary,
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
  snapshot.temporaries.length = 0;
  snapshot.frames.push({ id: snapshot.nextScopeId, bindings: [] });
  snapshot.nextScopeId += 1;
  snapshot.nextInstruction = definition.entryInstruction;
}

function bindSuppliedParameter(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "bindSuppliedParameter" }>,
  snapshot: RuntimeSnapshot,
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
    declareFunctionBinding(snapshot, parameter.name, argument.value, instruction.span);
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
  declareFunctionBinding(
    snapshot,
    parameter.name,
    evaluator.evaluate(instruction.value),
    instruction.span,
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
): void {
  const { frame } = activeFunction(plan, snapshot, span);
  const returned = cloneCapturedSerializableValue(value);
  snapshot.frames.splice(frame.scopeBaseDepth);
  snapshot.loopFrames.splice(frame.loopBaseDepth);
  snapshot.callFrames.pop();
  snapshot.temporaries.splice(
    0,
    snapshot.temporaries.length,
    ...frame.callerTemporaries.map(cloneTemporary),
  );
  if (snapshot.temporaries.some((temporary) => temporary.id === frame.destinationTemporary)) {
    throw fault("TSR050", "Function result destination is already occupied.", span);
  }
  snapshot.temporaries.push({ id: frame.destinationTemporary, value: returned });
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
  const frame = snapshot.callFrames.at(-1);
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
  snapshot: RuntimeSnapshot,
  name: string,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): void {
  if (findBinding(snapshot, name) !== undefined) {
    throw fault("TSR001", `Parameter '${name}' duplicates a visible binding.`, span);
  }
  currentFrame(snapshot).bindings.push({ name, value: cloneCapturedSerializableValue(value) });
}

function executeLoopStart(
  instruction: Extract<Instruction, { kind: "loopStart" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
): void {
  let frame = snapshot.loopFrames.at(-1);
  if (frame?.loopId !== instruction.loopId) {
    if (snapshot.loopFrames.some((item) => item.loopId === instruction.loopId)) {
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
      const source = evaluator.evaluate(instruction.expression);
      if (!isList(source) && !isSet(source) && !isRange(source)) {
        throw fault(
          "TSR044",
          "for requires a list, set, or range source.",
          instruction.expression.span,
        );
      }
      if (isRange(source)) assertIntegerRange(source, instruction.expression.span);
      frame = {
        kind: "for",
        loopId: instruction.loopId,
        scopeDepth,
        variable: instruction.variable,
        // EVIDENCE: the guards above narrow source to the three iterable runtime collection variants.
        source: cloneCapturedSerializableValue(source) as Extract<
          RuntimeLoopFrameSnapshot,
          { kind: "for" }
        >["source"],
        position: 0,
        callFrameId: currentCallFrameId(snapshot),
      };
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
  const value = iterationValue(frame.source, frame.position);
  frame.position += 1;
  pushIterationScope(snapshot, [
    { name: frame.variable, value: cloneCapturedSerializableValue(value) },
  ]);
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
  snapshot.frames.splice(frame.scopeDepth);
  if (instruction.action === "break") snapshot.loopFrames.pop();
  snapshot.nextInstruction = instruction.target;
}

function pushIterationScope(snapshot: RuntimeSnapshot, bindings: RuntimeBindingSnapshot[]): void {
  assertCounterCanAdvance(snapshot.nextScopeId, "nextScopeId");
  snapshot.frames.push({ id: snapshot.nextScopeId, bindings });
  snapshot.nextScopeId += 1;
}

function iterationLength(
  source: SerializableRuntimeList | SerializableRuntimeSet | SerializableRuntimeRange,
): number {
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
    const options = ui.options.map((option) => ({ text: option.text, label: option.label }));
    return { kind: "choice", labelType: ui.labelType, options, accessibleName };
  }
  if (ui.kind === "button") return { kind: "button", buttonLabel: ui.buttonLabel, accessibleName };
  return { kind: ui.kind, hint: ui.hint, accessibleName };
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
    requestEventSequence: action.requestEventSequence,
  };
}

function currentCallFrameId(snapshot: RuntimeSnapshot): number | null {
  return snapshot.callFrames.at(-1)?.id ?? null;
}

function currentFrame(snapshot: RuntimeSnapshot) {
  return snapshot.frames.at(-1)!;
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
  const stagedSnapshot = cloneCapturedRuntimeSnapshot(snapshot);
  const stagedEvents: InterpreterEvent[] = [];
  const stagedEvaluator = evaluator.forSnapshot(stagedSnapshot, stagedEvents);

  executeSay(plan, instruction, stagedSnapshot, stagedEvaluator, stagedEvents);
  validateTerminalCompletionCapacityAfterSay(plan, stagedSnapshot, instruction.span);
  Object.assign(snapshot, stagedSnapshot);
  events.push(...stagedEvents);
}

/**
 * A terminal say and root completion are one public instruction result. Check
 * the complete event and later action completions before committing the say.
 */
function validateTerminalCompletionCapacityAfterSay(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  span: SourceSpan,
): void {
  if (
    snapshot.status !== "running" ||
    snapshot.callFrames.length !== 0 ||
    snapshot.nextInstruction !== plan.rootEndInstruction
  )
    return;
  assertEventSequenceCapacity(snapshot, requiredEventSequencesForRootCompletion(snapshot), span);
}

function executeSpeakerAtomically(
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
  operation: (stagedSnapshot: RuntimeSnapshot, stagedEvaluator: Evaluator) => void,
): void {
  const stagedSnapshot = cloneCapturedRuntimeSnapshot(snapshot);
  const stagedEvents: InterpreterEvent[] = [];
  const stagedEvaluator = evaluator.forSnapshot(stagedSnapshot, stagedEvents);

  operation(stagedSnapshot, stagedEvaluator);
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
    emitSay(snapshot, events, instruction.span, prepared.speaker, prepared.content, prepared.text);
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
  const authoredText =
    instruction.textTemporary === undefined
      ? evaluator.visibleText(evaluator.evaluate(instruction.value), instruction.value.span)
      : preparedSayText(snapshot.temporaries, instruction.textTemporary, instruction.span);
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
      emitSay(snapshot, events, instruction.span, output, content, text);
      advance(snapshot);
      return;
    }
    const preparedOutput: RuntimePreparedSayOutputSnapshot = Object.freeze({
      owningInstruction: snapshot.nextInstruction,
      continuationInstruction: snapshot.nextInstruction + 1,
      speaker: output === null ? null : { ...output },
      content,
      text,
      durationMs,
      skippable,
    });
    const index = snapshot.backgroundActions.indexOf(activeGate);
    snapshot.backgroundActions.splice(index, 1);
    snapshot.foregroundAction = Object.freeze({ ...activeGate, preparedOutput });
    snapshot.status = "waiting";
    return;
  }
  if (durationMs > 0) validatePacingCreation(snapshot, instruction.span, durationMs);
  emitSay(snapshot, events, instruction.span, output, content, text);
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
): void {
  events.push(
    Object.freeze({
      kind: "say",
      sequence: takeSequence(snapshot),
      speaker,
      content,
      text,
      span: copySpan(span),
    } satisfies SayEvent),
  );
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

function requiredEventSequencesForRootCompletion(snapshot: RuntimeSnapshot): number {
  const rootCompleteEvent = 1;
  return rootCompleteEvent + requiredFutureActionCompletionEvents(snapshot);
}

function createCompleteEvent(snapshot: RuntimeSnapshot, span: SourceSpan): CompleteEvent {
  return Object.freeze({
    kind: "complete",
    sequence: takeSequence(snapshot),
    span: copySpan(span),
  });
}

function failSnapshot(
  snapshot: RuntimeSnapshot,
  failure: RuntimeErrorInfo,
  events: InterpreterEvent[],
): void {
  const failureSequence = takeSequence(snapshot);
  snapshot.status = "failed";
  snapshot.failure = { code: failure.code, message: failure.message, span: copySpan(failure.span) };
  events.push(
    Object.freeze({
      kind: "runtimeFailure",
      sequence: failureSequence,
      code: failure.code,
      message: failure.message,
      span: copySpan(failure.span),
    } satisfies RuntimeFailureEvent),
  );
}

function failForBudget(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  events: InterpreterEvent[],
): void {
  const span = plan.instructions[snapshot.nextInstruction]?.span ?? plan.sourceSpan;
  failSnapshot(
    snapshot,
    { code: "TSR037", message: "Runtime instruction budget exceeded.", span: copySpan(span) },
    events,
  );
}

function instructionBudget(value: number | undefined): number {
  const budget = value ?? 10_000;
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new RangeError("Instruction budget must be a positive safe integer.");
  }
  return budget;
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
