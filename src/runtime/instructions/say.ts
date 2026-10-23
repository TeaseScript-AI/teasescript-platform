import { exactDurationMilliseconds } from "../values/temporal-operations.js";
import { resolveMessagePresentation } from "../message-presentation.js";
import { sayStagesSelectively } from "./say-staging.js";
import type { MessagePresentation } from "../../message-presentation.js";
import type { Instruction } from "../../plan/model.js";
import { parseMessageMarkup, type MessageMarkup } from "../../message-markup.js";
import { isDelayLength, pacingMessage } from "../../delay-rules.js";
import type { Evaluator } from "../evaluator.js";
import { internalFault, RuntimeFault } from "../errors.js";
import {
  assertCounterCanAdvance,
  assertEventSequenceCapacity,
  setCapturedTemporary,
  takeSequence,
} from "../operations/support.js";
import { bindingKey, stateKey } from "../debug/debug-trace.js";
import { GLOBAL_SCOPE_ID } from "../scopes/prepared-references.js";
import type { ActionRequestedEvent, InterpreterEvent, OutputSpeaker, SayEvent } from "../events.js";
import {
  cloneCapturedSerializableValue,
  createCapturedSerializableObject,
  getSerializableProperty,
  type SerializableMessageHandle,
  type SerializableRuntimeValue,
} from "../values/serializable-values.js";
import {
  type RuntimeSnapshot,
  type RuntimeSpeakerSnapshot,
  type RuntimeTemporarySnapshot,
  currentTemporalContext,
} from "../snapshot/state.js";
import {
  ACTION_COMPLETION_EVENTS,
  type RuntimeChatPacingGateActionSnapshot,
} from "../actions/model.js";
import {
  calculatePacingDeadlineMs,
  calculateSmartPacingDurationMs,
  exactPacingMilliseconds,
} from "../actions/pacing.js";
import { describeShownValue } from "../values/value-types.js";
import { isAnyDuration, isObject } from "../values/value-predicates.js";
import { fieldText } from "../values/value-text.js";
import {
  advance,
  currentCallFrameId,
  durationFix,
  fault,
  readTemporary,
  type SourceSpan,
} from "./support.js";
import { copySpan } from "../../plan/source-location.js";
import { cloneCapturedRuntimeSnapshot } from "../snapshot/snapshot-construction.js";

// Say and its speakers: declaring a speaker, and preparing, showing, and pacing a message.

export function executeDeclareSpeaker(
  instruction: Extract<Instruction, { kind: "declareSpeaker" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  executeSpeakerAtomically(snapshot, evaluator, events, (stagedSnapshot, stagedEvaluator) => {
    if (stagedEvaluator.binding(instruction.name) !== undefined) {
      throw fault(
        "TSR001",
        internalFault(`The plan sets up speaker '${instruction.name}' twice.`),
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
        throw fault(
          "TSR007",
          internalFault(
            `The plan gives speaker '${instruction.name}' the property '${property.name}' twice.`,
          ),
          property.span,
        );
      }
      const propertyValue = cloneCapturedSerializableValue(
        stagedEvaluator.evaluateStartValue(
          { kind: "speaker", name: instruction.name },
          property.value,
        ),
      );
      if (property.name === "defaultSaySkippable" && typeof propertyValue !== "boolean") {
        throw fault("TSR050", notSkippableFlag(propertyValue), property.span);
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
}

export function executePrepareSaySpeaker(
  instruction: Extract<Instruction, { kind: "prepareSaySpeaker" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
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
}

export function executePrepareSayText(
  instruction: Extract<Instruction, { kind: "prepareSayText" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
): void {
  const value = evaluator.evaluate(instruction.value);
  const text =
    instruction.field === true
      ? fieldText(value, instruction.value.span, currentTemporalContext(snapshot))
      : evaluator.sayText(value, instruction.value.span);
  setCapturedTemporary(snapshot.temporaries, instruction.destinationTemporary, text);
  evaluator.trace?.writeTemporary(evaluator.callFrameId(), instruction.destinationTemporary, text);
  advance(snapshot);
}

export function executePrepareSayContextualSpeaker(
  instruction: Extract<Instruction, { kind: "prepareSayContextualSpeaker" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
): void {
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
}

/**
 * A `say` instruction evaluates visible text, pacing, and speaker output before
 * it can know whether its complete transition is representable. Evaluate that
 * work against a private stage so a rejected pacing value cannot retain RNG,
 * warning, event, or action changes: copies of the parts the say changes in
 * place, or a canonical-state clone when an expression may change any other.
 */
export function executeSayAtomically(
  instruction: Extract<Instruction, { kind: "say" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  const stagedSnapshot = sayStagesSelectively(instruction)
    ? selectiveSayStagingClone(snapshot, instruction.destinationTemporary !== undefined)
    : stagingClone(snapshot);
  const stagedEvents: InterpreterEvent[] = [];
  const stagedEvaluator = evaluator.forSnapshot(stagedSnapshot, stagedEvents);

  // Trace records made while staging commit or vanish with the staged state.
  const stage = evaluator.trace?.stage() ?? null;
  try {
    executeSay(instruction, stagedSnapshot, stagedEvaluator, stagedEvents);
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
 * Staging for a say whose expressions change no state but the generator (`sayStagesSelectively`). Such a say replaces
 * root fields and changes in place only the generator, the speaker warning list, and for a result-bearing say its
 * temporaries and live messages, so it copies those and shares everything else read-only. Every field is listed so
 * that a new snapshot field must be classified here.
 */
function selectiveSayStagingClone(
  snapshot: RuntimeSnapshot,
  givesHandle: boolean,
): RuntimeSnapshot {
  const staged: Required<RuntimeSnapshot> = {
    format: snapshot.format,
    version: snapshot.version,
    nextInstruction: snapshot.nextInstruction,
    frames: snapshot.frames,
    globals: snapshot.globals,
    speakers: snapshot.speakers,
    defaultSpeaker: snapshot.defaultSpeaker,
    contextualSpeaker: snapshot.contextualSpeaker,
    // A draw advances the generator in place; the copy is constant-size.
    rng: { ...snapshot.rng },
    warnedSpeakerIds: [...snapshot.warnedSpeakerIds],
    loopFrames: snapshot.loopFrames,
    // The handle is set as a new temporary or replaces an earlier one's value, so each temporary is copied.
    temporaries: givesHandle
      ? snapshot.temporaries.map((temporary) => ({ ...temporary }))
      : snapshot.temporaries,
    callFrames: snapshot.callFrames,
    retainedScopes: snapshot.retainedScopes,
    nextEventSequence: snapshot.nextEventSequence,
    nextScopeId: snapshot.nextScopeId,
    nextSpeakerId: snapshot.nextSpeakerId,
    nextCallFrameId: snapshot.nextCallFrameId,
    currentSessionTimeMs: snapshot.currentSessionTimeMs,
    observedSessionTimeMs: snapshot.observedSessionTimeMs,
    chatPacingSettings: snapshot.chatPacingSettings,
    temporalCaptures: snapshot.temporalCaptures,
    foregroundAction: snapshot.foregroundAction,
    backgroundActions: snapshot.backgroundActions,
    nextActionId: snapshot.nextActionId,
    lastSettlement: snapshot.lastSettlement,
    interactionResultHandoff: snapshot.interactionResultHandoff,
    settledTimers: snapshot.settledTimers,
    nextTimerId: snapshot.nextTimerId,
    pendingTimerHandlers: snapshot.pendingTimerHandlers,
    stageImage: snapshot.stageImage,
    capturedImages: snapshot.capturedImages,
    storedFiles: snapshot.storedFiles,
    scriptStorage: snapshot.scriptStorage,
    scriptStoragePersistent: snapshot.scriptStoragePersistent,
    settledMedia: snapshot.settledMedia,
    nextMediaId: snapshot.nextMediaId,
    cameraView: snapshot.cameraView,
    nextPermanentButtonId: snapshot.nextPermanentButtonId,
    // Records are never changed in place; a shown message adds one.
    liveMessages: givesHandle ? [...snapshot.liveMessages] : snapshot.liveMessages,
    debugMode: snapshot.debugMode,
    playerProfile: snapshot.playerProfile,
    // A say changes no control state; the operation's control keeps it.
    randomControl: snapshot.randomControl,
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
  instruction: Extract<Instruction, { kind: "say" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
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
  const content = sayMarkup(instruction, authoredText);
  const text = content.visibleText;
  const pacingValue =
    typeof instruction.pacing === "object"
      ? evaluator.evaluate(instruction.pacing)
      : instruction.pacing;
  const durationMs = sayDurationMs(instruction, text, pacingValue, snapshot);
  const skippable = effectiveSaySkippable(instruction.skipPolicy, speaker, instruction.span);
  if (durationMs > 0) validatePacingCreation(snapshot, instruction.span, durationMs);
  const sequence = emitSay(snapshot, events, instruction.span, output, content, text, presentation);
  if (textCauses !== null) evaluator.trace!.output(sequence, text, textCauses);
  if (instruction.destinationTemporary !== undefined)
    giveMessageHandle(
      snapshot,
      evaluator,
      instruction.destinationTemporary,
      sequence,
      authoredText,
    );
  if (durationMs > 0) holdForReadingTime(snapshot, events, instruction.span, durationMs, skippable);
  else advance(snapshot);
}

/**
 * The message a result-bearing say just showed becomes live with its markup source, and its handle goes to the say's
 * result temporary. Its ID is the say event's sequence, the newest, so the records stay in ascending order.
 */
function giveMessageHandle(
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  destinationTemporary: number,
  messageId: number,
  sourceText: string,
): void {
  snapshot.liveMessages.push({ messageId, sourceText });
  const handle: SerializableMessageHandle = { kind: "messageHandle", messageId };
  setCapturedTemporary(snapshot.temporaries, destinationTemporary, handle);
  evaluator.trace?.writeTemporary(evaluator.callFrameId(), destinationTemporary, handle);
}

function preparedOutputSpeaker(
  temporaries: readonly RuntimeTemporarySnapshot[],
  temporaryId: number,
  span: SourceSpan,
): { readonly output: OutputSpeaker | null; readonly speakerId: number | null } {
  const value = readTemporary(temporaries, temporaryId, span);
  if (value === null) return { output: null, speakerId: null };
  if (!isObject(value))
    throw fault("TSR052", internalFault("The prepared speaker of a say is invalid."), span);
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
    throw fault("TSR052", internalFault("The prepared speaker of a say is invalid."), span);
  return { output: Object.freeze({ identifier, displayName, color, font, avatar }), speakerId };
}

function preparedSayText(
  temporaries: readonly RuntimeTemporarySnapshot[],
  temporaryId: number,
  span: SourceSpan,
): string {
  const value = readTemporary(temporaries, temporaryId, span);
  if (typeof value !== "string")
    throw fault("TSR052", internalFault("The prepared text of a say is invalid."), span);
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
    if (!isAnyDuration(pacingValue))
      throw fault(
        "TSR050",
        `Say pacing is a duration or instant, but this is ${describeShownValue(pacingValue)}. ${durationFix(pacingValue, "3 s")}`,
        instruction.span,
      );
    const milliseconds = exactDurationMilliseconds(pacingValue, "Say pacing", instruction.span);
    if (!isDelayLength(milliseconds))
      throw fault("TSR050", pacingMessage(describeShownValue(pacingValue)), instruction.span);
    return exactPacingMilliseconds(milliseconds);
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
    throw fault("TSR050", notSkippableFlag(configured.value), span);
  }
  return configured.value;
}

/**
 * The markup of each say's most recent text, keyed by its plan instruction: a say that shows the same text again, as
 * in a loop or another session of the plan, parses it once. Each say keeps one entry, replaced when its text changes;
 * the markup is deeply frozen and holds nothing of a session.
 */
const lastSayMarkup = new WeakMap<
  object,
  { readonly text: string; readonly markup: MessageMarkup }
>();

function sayMarkup(
  instruction: Extract<Instruction, { kind: "say" }>,
  text: string,
): MessageMarkup {
  const last = lastSayMarkup.get(instruction);
  if (last !== undefined && last.text === text) return last.markup;
  const markup = parseMessageMarkup(text);
  lastSayMarkup.set(instruction, { text, markup });
  return markup;
}

export function emitSay(
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

/**
 * A paced message lasts its reading time: the script waits at the say, as at a `wait`, until time or a permitted skip
 * settles the gate, and then continues with the next statement (owner decision on #829, 2026-10-11).
 */
function holdForReadingTime(
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
  });
  snapshot.nextActionId += 1;
  snapshot.foregroundAction = action;
  snapshot.status = "waiting";
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
    throw fault("TSR051", internalFault("The session has used up its action numbers."), span);
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
  return sayOutput + pacingRequest + ACTION_COMPLETION_EVENTS.chatPacingGate;
}

/** `defaultSaySkippable` holds `value`, which is not true or false. */
function notSkippableFlag(value: SerializableRuntimeValue): string {
  return `Speaker property 'defaultSaySkippable' must be true or false (boolean), but this is ${describeShownValue(value)}.`;
}
