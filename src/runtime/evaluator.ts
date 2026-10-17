import {
  argumentCountMessage,
  argumentShapeProblem,
  dictArgumentsProblem,
  FIXED_PARAMETERS,
  getArgumentsProblem,
  LIST_ONLY_METHODS,
  NO_ARGUMENTS,
  POSITIONAL_METHODS,
  positionalShape,
  scriptArgumentCountMessage,
  unknownNamedArgumentMessage,
} from "../argument-rules.js";
import { LIST_FUNCTION_SHAPES, MIN_MAX_TAKES } from "../list-function-rules.js";
import type { DeveloperWarningCode, RuntimeErrorCode } from "../diagnostic-codes.js";
import { temporalCaptureAt } from "./temporal-captures.js";
import {
  combinedDateAndTime,
  compareTemporal,
  hasTemporalMethod,
  exactDurationMilliseconds,
  TEMPORAL_GETTERS,
  temporalBinary,
  temporalConverted,
  temporalNow,
  temporalMethod,
  calendarDurationProperty,
  temporalProperty,
} from "./temporal-operations.js";
import { normalizeColor } from "../color.js";
import type {
  AssignmentTargetPlan,
  BinaryExpressionPlan,
  ExpressionPlan,
  InstructionPlan,
  PlanSourceLocation,
  PlanTag,
  RangeExpressionPlan,
  TagQueryExpressionPlan,
  TagQueryStepPlan,
  TypeCheckPlan,
  TypePlan,
} from "../plan/model.js";
import { compareTagValue, evaluateTagSteps, passesTagList } from "../tag-query.js";
import { normalizeTagName } from "../tags.js";
import { globMatches, isPathGlob } from "../project-paths.js";
import { escapedMarkupLength, escapeMarkup, parseMessageMarkup } from "../message-markup.js";
import {
  expressionPlanChildren,
  lazyDefaultArgumentIndex,
  lazyDefaultCallOperation,
} from "../plan/expression-children.js";
import type { LazyDefaultOperation } from "../lazy-defaults.js";
import { NUMERIC_FUNCTIONS } from "../numeric-functions.js";
import {
  ANGLE_ARITHMETIC_ROUTE,
  ANGLE_FUNCTIONS,
  angleArgumentMessage,
  angleArithmetic,
  angleDegrees,
  anglePropertyMessage,
  angleValue,
  compareAngles,
  formatAngle,
  type StoredAngle,
} from "../angle.js";
import {
  PERSON_FIELDS,
  PLAYER,
  propertiesReadThrough,
  speakerPropertySource,
  speakerPropertyValue,
} from "../speaker-terms.js";
import { accountFieldValue } from "./account.js";
import {
  LIST_STATISTICS,
  linearRegression,
  listStatistic,
  listValues,
  percentage,
  predict,
  weightedChoices,
  weightedIndex,
} from "./list-statistics.js";
import { CORE_RUNTIME_BUILTINS, type ConversionName } from "../language-facts.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { internalFault, RuntimeFault } from "./errors.js";
import type { InstructionTraceCollector, RuntimeInstructionObserver } from "./instruction-trace.js";
import type {
  DeveloperWarningEvent,
  InterpreterEvent,
  MessageRemovedEvent,
  MessageUpdatedEvent,
  OutputSpeaker,
} from "./events.js";
import { copySpan, takeSequence } from "./operations/support.js";
import {
  GLOBAL_SCOPE_ID,
  detachPreparedReferencesForMutation,
  freezePreparedReferenceDescendants,
  preparePreparedReferencesForListRemoval,
  preparePreparedReferencesForListReorder,
  preparedReferenceSpeakerPath,
  readPreparedReference,
  refreshPreparedReferenceFallbacks,
  scopeBindings,
  serializePreparedReference,
  type PreparedReferenceDescriptor,
  type PreparedReferenceStep,
} from "./prepared-references.js";
import { nextXorShift32, type RandomSource } from "./random.js";
import {
  sampleChance,
  sampleIndex,
  sampleOrder,
  sampleRangeInteger,
  type PrimitiveDraw,
} from "./random-draws.js";
import {
  RandomControlSignal,
  type RandomControl,
  type RandomNatural,
  type RandomSupport,
} from "./random-control.js";
import {
  isVisibleScalar,
  quotedText,
  quotedTextWithin,
  valueNotation,
  visibleText,
} from "./value-text.js";
import { checkTextLength, MAX_TEXT_LENGTH, messageText, textTooLong } from "./text-length.js";
import {
  checkCollectionLength,
  collectionTooLong,
  MAX_COLLECTION_LENGTH,
} from "./collection-size.js";
import { base64Text, jsonText, textFromBase64, valueFromJson } from "./json-base64.js";
import { textSha256 } from "./sha256.js";
import {
  emptyRangeProblem,
  rangeBoundRule,
  rangeLength,
  rangeText,
  wholeRangeMessage,
} from "../range-checks.js";
import {
  logicalOperandRule,
  notNumberFix,
  UNIT_AMOUNT_RULE,
  unitAmountFix,
} from "../operand-rules.js";
import { loweredOperand } from "./lowered-operands.js";
import {
  cameraPlacementMessage,
  handleMemberMessage,
  isCameraPlacement,
  isMediaVolume,
  isTimerDisplay,
  mediaVolumeMessage,
  timerDisplayMessage,
} from "../handle-rules.js";
import { unmeasurableLengthMessage } from "../delay-rules.js";
import {
  RANGE_LIST_FIX,
  rangeListLengthProblem,
  SET_OPERATIONS,
  setOperationArgumentMessage,
  setOperationItems,
  sortOrder,
} from "./collection-operations.js";
import {
  addDurations,
  calendarDuration,
  compareDurations,
  divideDuration,
  durationFamily,
  durationParts,
  durationPropertyMessage,
  durationQuotient,
  exactDuration,
  formatDuration,
  isCalendar,
  negateDuration,
  scaleDuration,
  unitValue,
  ZERO_DIVISOR,
  type AnyDuration,
} from "../duration.js";
import {
  callStringMethod,
  checkTextArguments,
  regexFromText,
  missingMemberMessage,
  STRING_METHODS,
  stringLength,
} from "./string-operations.js";
import {
  LIST_JOIN,
  methodArgumentCountMessage,
  unknownTextMemberMessage,
} from "../text-operations.js";
import { missingPropertyMessage } from "../object-properties.js";
import { findScriptStorageEntry, storageKey, storageKeyPlace } from "./script-storage.js";
import {
  addSerializableSetValue,
  clearSerializableDict,
  clearSerializableSet,
  cloneCapturedSerializableValue,
  cloneSerializableValue,
  findRuntimeIdentity,
  createCapturedSerializableList,
  createCapturedSerializableSet,
  dictProperty,
  getSerializableDictEntry,
  getSerializableProperty,
  removeSerializableDictEntry,
  removeSerializableSetValue,
  serializableEquals,
  serializableSetContains,
  SerializableValueError,
  setCapturedSerializableDictValue,
  setCapturedSerializableProperty,
  setOwnedSerializableDictValue,
  type SerializableRuntimeDict,
  type SerializableRuntimeList,
  type SerializableRuntimeObject,
  type SerializableRuntimeRange,
  type SerializableRuntimeSet,
  type SerializableRuntimeTemporal,
  type SerializableRuntimeValue,
  type SerializableTimerHandle,
  type SerializableMediaHandle,
  type SerializableMessageHandle,
  type SerializableCameraViewHandle,
  type SerializablePermanentButtonHandle,
  type SerializableScriptReference,
  type SerializableRuntimeProperty,
  type SerializableSpeakerReference,
} from "./serializable-values.js";
import {
  currentTemporalContext,
  type RuntimeBindingSnapshot,
  type RuntimeSnapshot,
  type RuntimeSpeakerSnapshot,
  type RuntimeTemporarySnapshot,
  MAX_RUNTIME_SESSION_TIME_MS,
} from "./state.js";
import {
  describeRuntimeValue,
  isAngle,
  isAnyDuration,
  isCalendarDuration,
  isDict,
  isDuration,
  isList,
  isObject,
  isRange,
  isScriptReference,
  isRegex,
  isSet,
  isSpeakerReference,
  isTemporal,
  isTimerHandle,
  isMediaHandle,
  isMessageHandle,
  isCameraView,
  isPermanentButton,
} from "./value-predicates.js";
import {
  assertValueType,
  cannotConvert,
  describeShownValue,
  shownChoice,
  describeValue as describeTypedValue,
  matchesValueType,
  storedValueMismatch,
} from "./value-types.js";
import {
  mediaProperty,
  pauseMedia,
  resumeMedia,
  seekMedia,
  setMediaVolume,
  type MediaHandleRecord,
  type MediaWarning,
} from "./media.js";
import {
  activeMediaAction,
  drainMediaEvents,
  mediaRecord,
  stopMediaAction,
} from "./operations/media-lifecycle.js";
import {
  pauseTimer,
  resumeTimer,
  setTimerDisplay,
  setTimerRemaining,
  setTimerRepeatDuration,
  timerProperty,
  type TimerHandleRecord,
  type TimerWarning,
} from "./timers.js";
import {
  activeTimerAction,
  expireTimerAction,
  stopTimerAction,
  timerRecord,
} from "./operations/timer-lifecycle.js";
import { removePermanentButtons, shownPermanentButton } from "./permanent-buttons.js";
import { contextRootId, findRoot, findScope } from "./activations.js";
import {
  bindingKey,
  emptyDependencies,
  stateKey,
  type DebugDependencies,
  type StatePart,
  type RuntimeDebugRandomOperation,
  type TraceStore,
} from "./debug-trace.js";
import { isValidSessionTime } from "./actions/delay.js";
import {
  booleanFromText,
  CONVERSIONS,
  defaultDescription,
  fitsDefault,
  isConversion,
  numberFromText,
  MIN_MAX_BUILTINS,
  withoutNegativeZero,
  type CallShape,
  type Conversion,
  type ValueConversion,
} from "../conversions.js";

export interface RuntimeCapabilityCall {
  readonly positional: readonly SerializableRuntimeValue[];
  readonly named: Readonly<Record<string, SerializableRuntimeValue>>;
  readonly span: RichSourceSpan;
}

export type RuntimeBuiltinFunction = (call: RuntimeCapabilityCall) => SerializableRuntimeValue;

export interface RuntimeCapabilities {
  readonly builtins?: Readonly<Record<string, RuntimeBuiltinFunction>>;
  /** Compatibility/testing override. Serializable xorshift32 is used otherwise. */
  readonly random?: RandomSource;
}

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/** `text` with `part` of a `"${...}"` text appended; `TSR084` when the text would be too long. */
function templateText(text: string, part: string, span: SourceSpan): string {
  // The later placeholders have not run yet, so the length the whole text would reach is not known.
  if (text.length + part.length > MAX_TEXT_LENGTH) throw textTooLong("${…}", span, null);
  return text + part;
}

/** Builtin records that a session created and froze itself, with data properties only (`RuntimeSession`). */
const ADMITTED_BUILTINS = new WeakSet<object>();

/** Marks a builtin record the engine created and froze, which reading never changes; returns it. */
export function admittedBuiltinRecord<T extends object>(record: T): T {
  ADMITTED_BUILTINS.add(record);
  return record;
}

export class RuntimeExecutionContext {
  public readonly events: InterpreterEvent[] = [];
  /** Whether the instruction observer ended the operation before an instruction. */
  public stopped = false;
  #evaluator: Evaluator | null = null;

  public constructor(
    private readonly snapshot: RuntimeSnapshot,
    private readonly capabilities: RuntimeCapabilities,
    private readonly plan: InstructionPlan,
    /** The debug trace of the operation, or `null` when it is not traced. */
    public readonly trace: TraceStore | null = null,
    /** The instruction trace the call returns, or `null` when it returns none. */
    public readonly instructionTrace: InstructionTraceCollector | null = null,
    /** The operation's controlled randomness, or `null` when every draw is natural. */
    public readonly control: RandomControl | null = null,
    /** The session host's instruction observer, or `null`. */
    public readonly observer: RuntimeInstructionObserver | null = null,
  ) {}

  public evaluator(): Evaluator {
    if (this.#evaluator !== null) {
      this.#evaluator.refreshBuiltinRegistration();
      return this.#evaluator;
    }
    this.#evaluator = new Evaluator(
      this.snapshot,
      this.capabilities,
      this.events,
      this.plan,
      this.trace,
      this.control,
    );
    return this.#evaluator;
  }
}

export class Evaluator {
  readonly #builtins: Record<string, RuntimeBuiltinFunction> = Object.create(null);

  /** The builtin record `#builtins` was last filled from. */
  #registered: RuntimeCapabilities["builtins"] = undefined;

  #referenceEpoch = 0;

  /** Whether the reference being prepared keeps a copy of its root (`preparedReferenceTemporaries`). */
  #keepPreparedRoot = false;

  /** Whether a start value is being evaluated, which may not select anything at random (ADR 0022 §6). */
  #startValue = false;

  /** With controlled randomness, the generator state before the last draw: its ID. */
  #drawId = 0;

  /** Whether the call or `load` of `evaluateWithoutDefault` needs its default. */
  #defaultNeeded = false;

  public constructor(
    private readonly snapshot: RuntimeSnapshot,
    private readonly capabilities: RuntimeCapabilities,
    private readonly events: InterpreterEvent[],
    private readonly plan: InstructionPlan,
    /** The debug trace that observes evaluation, or `null`. */
    public readonly trace: TraceStore | null = null,
    /** The operation's controlled randomness, or `null` when every draw is natural. */
    public readonly control: RandomControl | null = null,
  ) {
    this.refreshBuiltinRegistration();
  }

  public refreshBuiltinRegistration(): void {
    const builtins = this.capabilities.builtins;
    // A session's admitted record cannot change; a host's record is read again, as reading it may give or do more.
    if (
      builtins === this.#registered &&
      (builtins === undefined || ADMITTED_BUILTINS.has(builtins))
    )
      return;
    for (const name of Object.keys(this.#builtins)) delete this.#builtins[name];
    Object.assign(this.#builtins, builtins ?? {});
    this.#registered = builtins;
  }

  public forSnapshot(snapshot: RuntimeSnapshot, events: InterpreterEvent[]): Evaluator {
    return new Evaluator(snapshot, this.capabilities, events, this.plan, this.trace, this.control);
  }

  public evaluate(expression: ExpressionPlan): SerializableRuntimeValue {
    return this.#evaluateMachine(expression, false).value;
  }

  /**
   * Evaluates a call or `load` whose `default:` runs as the instructions after it (see
   * `StoreTemporaryInstruction.defaultTemporary`): its value, or `USE_DEFAULT` when it needs the default.
   */
  public evaluateWithoutDefault(
    expression: ExpressionPlan,
  ): SerializableRuntimeValue | typeof USE_DEFAULT {
    this.#defaultNeeded = false;
    const { value } = this.#evaluateMachine(expression, false, true);
    return this.#defaultNeeded ? USE_DEFAULT : value;
  }

  /** Evaluates the start value of a global or a speaker property. */
  public evaluateStartValue(expression: ExpressionPlan): SerializableRuntimeValue {
    this.#startValue = true;
    try {
      return this.evaluate(expression);
    } finally {
      this.#startValue = false;
    }
  }

  /** The binding that `name` refers to at the current point of execution. */
  public binding(name: string): RuntimeBindingSnapshot | undefined {
    return findBindingLocation(this.snapshot, this.plan, name)?.binding;
  }

  #evaluateLeaf(
    expression: Extract<
      ExpressionPlan,
      {
        kind:
          | "literal"
          | "regex"
          | "duration"
          | "calendarDuration"
          | "identifier"
          | "debugMode"
          | "accountField"
          | "temporary"
          | "preparedReference";
      }
    >,
  ): SerializableRuntimeValue {
    switch (expression.kind) {
      case "literal":
        return expression.value;
      case "regex":
        return { kind: "regex", source: expression.source, flags: expression.flags };
      case "debugMode":
        // The host sets it, so a read has no recorded origin.
        this.trace?.readState(
          stateKey("debugMode"),
          null,
          "debugMode",
          this.snapshot.debugMode,
          true,
        );
        return this.snapshot.debugMode;
      case "accountField": {
        const value = accountFieldValue(this.snapshot.account, expression.name);
        if (value === undefined)
          throw fault(
            "TSR017",
            `The account has no '${expression.name}': the player's account does not give one. Give the player a value of its own instead, as in 'player.${expression.name} = ...'.`,
            expression.span,
          );
        // The host gave the account, so a read has no recorded origin.
        this.trace?.readState(
          stateKey("account", expression.name),
          null,
          `account.${expression.name}`,
          value,
          true,
        );
        return value;
      }
      case "duration":
        return exactDuration(expression.milliseconds);
      case "calendarDuration":
        return calendarDuration(expression);
      case "identifier": {
        if (expression.name === "speaker" && this.snapshot.contextualSpeaker !== null) {
          const speaker = this.speakerById(this.snapshot.contextualSpeaker, expression.span);
          const reference: SerializableRuntimeValue = {
            kind: "speakerReference",
            speakerId: speaker.id,
            identifier: speaker.identifier,
          };
          if (this.trace !== null) this.#readState(reference, null);
          return reference;
        }
        const location = findBindingLocation(this.snapshot, this.plan, expression.name);
        if (location === undefined) throw this.#unknownName(expression.name, expression.span);
        this.trace?.readBinding(location.frame.id, expression.name, location.binding.value);
        return location.binding.value;
      }
      case "temporary": {
        const value = readTemporary(
          this.snapshot.temporaries,
          expression.temporaryId,
          expression.span,
        );
        // A prepared message reads `speaker` from the temporary that holds its speaker, `null` when it has none.
        if (value === null && speakerTemporaries(this.plan).has(expression.temporaryId))
          throw noSpeaker(expression.span);
        this.trace?.readTemporary(this.callFrameId(), expression.temporaryId, value);
        return value;
      }
      case "preparedReference": {
        const serialized = readTemporary(
          this.snapshot.temporaries,
          expression.temporaryId,
          expression.span,
        );
        const value = this.#resolvePreparedReference(serialized, expression.span);
        if (this.trace !== null)
          this.#tracePreparedReference(serialized, expression.temporaryId, value, expression.span);
        return value;
      }
    }
  }

  /** The call frame whose temporaries execution sees now, or 0 outside every call. */
  public callFrameId(): number {
    return this.snapshot.callFrames.at(-1)?.id ?? 0;
  }

  /** The runtime state a speaker reference or handle names, or `null` for any other value. */
  #stateKey(value: SerializableRuntimeValue): string | null {
    if (isSpeakerReference(value)) return stateKey("speaker", value.speakerId);
    if (isTimerHandle(value)) return stateKey("timer", value.timerId);
    if (isMediaHandle(value)) return stateKey("media", value.mediaId);
    if (isPermanentButton(value)) return stateKey("button", value.buttonId);
    if (isMessageHandle(value)) return stateKey("message", value.messageId);
    if (isCameraView(value)) return stateKey("camera");
    return null;
  }

  /**
   * A read of one `property` of the state `value` names, or of all of it with `null`. A speaker was declared by the
   * script; a handle's creation explains itself.
   */
  #readState(value: SerializableRuntimeValue, property: string | null): void {
    const key = this.#stateKey(value);
    if (key === null) return;
    this.trace!.readState(
      key,
      property,
      isSpeakerReference(value) ? value.identifier : null,
      value,
      isSpeakerReference(value),
    );
  }

  /**
   * A change of the state `value` names, with the causes collected so far: an assignment sets one property, a timer or
   * media method its timed properties, and removing a permanent button all of it.
   */
  #writeState(
    value: SerializableRuntimeValue,
    property: string,
    assigned: SerializableRuntimeValue,
    span: SourceSpan,
    part: StatePart,
  ): void {
    const key = this.#stateKey(value);
    if (key === null) return;
    const owner = isSpeakerReference(value)
      ? value.identifier
      : isTimerHandle(value)
        ? "timer"
        : isMediaHandle(value)
          ? "media"
          : isCameraView(value)
            ? "camera"
            : isMessageHandle(value)
              ? "message"
              : "permanent button";
    this.trace!.writeState(
      part === "whole" || part === "timed" ? "mutation" : "assignment",
      key,
      part,
      `${owner}.${property}`,
      assigned,
      span,
    );
  }

  /** A collection method changed the variable its receiver names; the call's value comes from that change. */
  #traceMutation(descriptor: PreparedReferenceDescriptor | null, span: SourceSpan): void {
    this.trace!.replace(this.#traceVariableChange("mutation", descriptor, span));
  }

  /**
   * Records the new version of the variable a change inside it reached, unless the change reached a copy, with the
   * causes collected so far.
   */
  #traceVariableChange(
    kind: "mutation" | "assignment",
    descriptor: PreparedReferenceDescriptor | null,
    span: SourceSpan,
  ): number | null {
    if (descriptor === null || descriptor.detached) return null;
    const { rootFrameId, rootName } = descriptor;
    if (rootFrameId === null || rootName === null) return null;
    const root = scopeBindings(this.snapshot, rootFrameId)?.find(
      (binding) => binding.name === rootName,
    );
    if (root === undefined) return null;
    return this.trace!.write(kind, bindingKey(rootFrameId, rootName), rootName, root.value, span);
  }

  /** A prepared reference reads the variable it names, or, once detached, its own captured value. */
  #tracePreparedReference(
    serialized: SerializableRuntimeValue,
    temporaryId: number,
    value: SerializableRuntimeValue,
    span: SourceSpan,
  ): void {
    const descriptor = readPreparedReference(serialized, span);
    if (!descriptor.detached && descriptor.rootFrameId !== null && descriptor.rootName !== null)
      this.trace!.readBinding(descriptor.rootFrameId, descriptor.rootName, value);
    else this.trace!.readTemporary(this.callFrameId(), temporaryId, value);
  }

  #evaluateMachine(root: ExpressionPlan, reference: boolean, probe = false): EvaluatedExpression {
    const trace = this.trace;
    if (trace === null) return this.#runMachine(evaluationFrame(root, reference, probe), null);
    // Traced evaluation collects causes per frame; the root's join the collector it started from.
    const outer = trace.acc;
    const rootFrame = evaluationFrame(root, reference, probe);
    try {
      return this.#runMachine(rootFrame, trace);
    } finally {
      trace.focus(outer, rootFrame.deps, true);
    }
  }

  #runMachine(rootFrame: EvaluationFrame, trace: TraceStore | null): EvaluatedExpression {
    // Frames are consumed synchronously within one instruction; no continuation escapes
    // into a checkpoint. Collection calls invalidate cached reference cursors.
    this.#referenceEpoch = 0;
    const pending: EvaluationFrame[] = [rootFrame];
    // With a trace, the frame that finished last, whose causes its parent takes over.
    let previous: EvaluationFrame | null = null;
    let previousDepth = 0;
    let finished: EvaluationFrame | null = null;
    let result: EvaluatedExpression = {
      value: null,
      owned: false,
      descriptor: null,
      epoch: this.#referenceEpoch,
    };
    while (pending.length) {
      const frame = pending.at(-1)!;
      const expression = frame.expression;
      if (trace !== null) {
        finished = pending.length < previousDepth ? previous : null;
        // A template keeps each placeholder's causes apart in an interpolation record.
        trace.focus(
          (frame.deps ??= emptyDependencies()),
          finished?.deps ?? null,
          expression.kind !== "template",
        );
        previous = frame;
        previousDepth = pending.length;
      }
      if (frame.reference) {
        if (expression.kind === "group") {
          if (frame.stage++ === 0) {
            pending.push(evaluationFrame(expression.expression, true));
            continue;
          }
          pending.pop();
          continue;
        }
        if (expression.kind === "property" || expression.kind === "index") {
          if (frame.stage === 0) {
            frame.stage = 1;
            pending.push(evaluationFrame(expression.object, true));
            continue;
          }
          if (frame.stage === 1) {
            // Reference children share one descriptor and a cursor. Rewalk from the
            // root only after a collection call could have mutated an earlier step.
            frame.descriptor = result.descriptor!;
            frame.value =
              result.epoch === this.#referenceEpoch
                ? result.value
                : this.#resolveDescriptor(frame.descriptor, expression.object.span);
            if (expression.kind === "property") {
              const base = frame.value;
              if (
                (isList(base) || isSet(base)) &&
                ["first", "last", "random"].includes(expression.name)
              ) {
                if (base.items.length === 0)
                  throw emptyCollection(
                    expression.name,
                    base,
                    this.#receiverLabel(expression.object),
                    expression.span,
                  );
                const index =
                  expression.name === "first"
                    ? 0
                    : expression.name === "last"
                      ? base.items.length - 1
                      : this.#drawIndex(expression.span, "collectionRandom", base.items);
                if (expression.name === "random") trace?.randomResult(base.items[index]!);
                if (isSet(base)) {
                  // A set member is read as a copy: changing it must not change the set or its uniqueness.
                  const member = cloneCapturedSerializableValue(base.items[index]!);
                  frame.descriptor = {
                    rootFrameId: null,
                    rootName: null,
                    path: [],
                    capturedRoot: member,
                    detached: true,
                  };
                  frame.value = member;
                } else {
                  frame.descriptor.path.push({ kind: "index", index });
                  frame.value = base.items[index]!;
                }
              } else if (isMessageHandle(base)) {
                // A message's text is state of the message, outside the value that holds the handle, so the
                // reference keeps the text read now, as it would keep a text variable's value.
                const text = this.#getProperty(
                  base,
                  expression.name,
                  expression.span,
                  expression.object,
                );
                frame.descriptor = {
                  rootFrameId: null,
                  rootName: null,
                  path: [],
                  capturedRoot: text,
                  detached: true,
                };
                frame.value = text;
              } else {
                frame.descriptor.path.push({ kind: "property", name: expression.name });
                frame.value = this.#getProperty(
                  base,
                  expression.name,
                  expression.span,
                  expression.object,
                );
              }
              result = {
                value: frame.value,
                owned: false,
                descriptor: frame.descriptor,
                epoch: this.#referenceEpoch,
              };
              pending.pop();
              continue;
            }
            this.#assertIndexable(frame.value, expression.object, expression.span);
            frame.epoch = this.#referenceEpoch;
            frame.stage = 2;
            pending.push(evaluationFrame(expression.index));
            continue;
          }
          if (expression.kind !== "index") throw new TypeError("Invalid reference continuation.");
          if (isDict(frame.value)) {
            const key = this.#dictKey(result.value, expression.index.span);
            frame.descriptor!.path.push({ kind: "key", key });
            result = {
              value: this.#dictValue(frame.value, key, expression),
              owned: false,
              descriptor: frame.descriptor,
              epoch: frame.epoch,
            };
            pending.pop();
            continue;
          }
          // EVIDENCE: invariant: index reference stage 1 validates and retains the list or dict receiver.
          const object = frame.value as SerializableRuntimeList;
          const index = this.#listPosition(
            object,
            expression.object,
            expression.index,
            result.value,
            "read",
          );
          frame.descriptor!.path.push({ kind: "index", index });
          result = {
            value: object.items[index]!,
            owned: false,
            descriptor: frame.descriptor,
            epoch: frame.epoch,
          };
          pending.pop();
          continue;
        }
        // The contextual `speaker` is no variable, so it is read as a value below, like any other expression.
        if (
          expression.kind === "identifier" &&
          !(expression.name === "speaker" && this.snapshot.contextualSpeaker !== null)
        ) {
          const location = findBindingLocation(this.snapshot, this.plan, expression.name);
          if (location === undefined) throw this.#unknownName(expression.name, expression.span);
          trace?.readBinding(location.frame.id, expression.name, location.binding.value);
          // Only the root of a prepared reference, reached through reference frames alone, keeps a copy, and only where
          // the plan keeps one: for instance, a call in an index read after it can remove an ancestor of the value it
          // selects. The receiver of an immediate call resolves through its binding, so it shares the root instead.
          const prepared = pending.every((pendingFrame) => pendingFrame.reference);
          result = {
            value: location.binding.value,
            owned: false,
            descriptor: {
              rootFrameId: location.frame.id,
              rootName: expression.name,
              path: [],
              capturedRoot: !prepared
                ? location.binding.value
                : this.#keepPreparedRoot
                  ? cloneCapturedSerializableValue(location.binding.value)
                  : undefined,
              detached: false,
            },
            epoch: this.#referenceEpoch,
          };
          pending.pop();
          continue;
        }
        if (expression.kind === "preparedReference") {
          const serialized = readTemporary(
            this.snapshot.temporaries,
            expression.temporaryId,
            expression.span,
          );
          let descriptor = readPreparedReference(serialized, expression.span);
          // A prepared-reference leaf only copies its descriptor; its parent resolves it at the receiver span. One
          // that keeps a copy of its root is resolved here instead, so that it is detached at this use, as an
          // assignment through it would be, once its path leads nowhere from its variable.
          let value: SerializableRuntimeValue = null;
          let epoch = -1;
          if (!descriptor.detached && descriptor.capturedRoot !== undefined) {
            value = this.#resolvePreparedReference(serialized, expression.span);
            descriptor = readPreparedReference(serialized, expression.span);
            epoch = this.#referenceEpoch;
          }
          if (trace !== null)
            this.#tracePreparedReference(
              serialized,
              expression.temporaryId,
              descriptor.capturedRoot ??
                this.#resolveDescriptor({ ...descriptor, path: [] }, expression.span),
              expression.span,
            );
          result = { value, owned: false, descriptor, epoch };
          pending.pop();
          continue;
        }
        if (frame.stage++ === 0) {
          pending.push(evaluationFrame(expression));
          continue;
        }
        const capturedRoot = cloneCapturedSerializableValue(result.value);
        result = {
          value: capturedRoot,
          owned: false,
          descriptor: { rootFrameId: null, rootName: null, path: [], capturedRoot, detached: true },
          epoch: this.#referenceEpoch,
        };
        pending.pop();
        continue;
      }
      let value: SerializableRuntimeValue;
      let owned = false;
      switch (expression.kind) {
        case "literal":
        case "regex":
        case "duration":
        case "calendarDuration":
        case "identifier":
        case "debugMode":
        case "accountField":
        case "temporary":
        case "preparedReference":
          value = this.#evaluateLeaf(expression);
          break;
        case "group":
          if (frame.stage++ === 0) {
            pending.push(evaluationFrame(expression.expression));
            continue;
          }
          value = result.value;
          break;
        case "list":
        case "object":
        case "set": {
          const childCount =
            expression.kind === "object"
              ? expression.properties.length
              : expression.elements.length;
          if (frame.stage === 0) {
            if (expression.kind === "object") {
              const names = new Set<string>();
              for (const property of expression.properties) {
                if (names.has(property.name))
                  throw fault(
                    "TSR007",
                    internalFault(
                      `The plan builds an object with the property '${property.name}' twice.`,
                    ),
                    property.span,
                  );
                names.add(property.name);
              }
            }
            frame.stage = 1;
          } else {
            if (expression.kind === "set") addSerializableSetValue(frame.set!, result.value);
            else
              frame.results!.push(
                result.owned ? result.value : cloneCapturedSerializableValue(result.value),
              );
          }
          if (frame.index < childCount) {
            pending.push(
              evaluationFrame(
                expression.kind === "object"
                  ? expression.properties[frame.index++]!.value
                  : expression.elements[frame.index++]!,
              ),
            );
            continue;
          }
          // Children were captured when evaluated (ADR 0014), so the literal owns them.
          owned = true;
          if (expression.kind === "set") value = frame.set!;
          else if (expression.kind === "list") value = { kind: "list", items: frame.results! };
          else
            value = {
              kind: "object",
              properties: expression.properties.map((property, i) => ({
                name: property.name,
                value: frame.results![i]!,
              })),
            };
          break;
        }
        case "dict": {
          if (frame.stage === 1) {
            // The key was evaluated; its value follows.
            frame.key = this.#dictKey(result.value, expression.entries[frame.index]!.key.span);
            frame.stage = 2;
            pending.push(evaluationFrame(expression.entries[frame.index]!.value));
            continue;
          }
          if (frame.stage === 2) {
            // A later entry with an equal key replaces the earlier one in its position.
            setOwnedSerializableDictValue(
              frame.dict!,
              frame.key!,
              result.owned ? result.value : cloneCapturedSerializableValue(result.value),
            );
            frame.index += 1;
          }
          if (frame.index < expression.entries.length) {
            frame.stage = 1;
            pending.push(evaluationFrame(expression.entries[frame.index]!.key));
            continue;
          }
          // Values were captured when evaluated (ADR 0014), so the literal owns them.
          owned = true;
          value = frame.dict!;
          break;
        }
        case "template":
          if (frame.stage === 1) {
            const part = expression.parts[frame.index - 1]!;
            if (part.kind === "expression") {
              if (trace === null)
                frame.text = templateText(
                  frame.text,
                  this.interpolationText(result.value, part.expression.span),
                  expression.span,
                );
              else {
                // A list's selection draw belongs to the placeholder, whose text the string then depends on.
                const placeholder = finished?.deps ?? emptyDependencies();
                trace.focus(placeholder, null, false);
                const text = this.interpolationText(result.value, part.expression.span);
                trace.focus(frame.deps!, null, false);
                trace.interpolation(placeholder, text, part.expression.span);
                frame.text = templateText(frame.text, text, expression.span);
              }
            }
          }
          while (
            frame.index < expression.parts.length &&
            expression.parts[frame.index]!.kind === "text"
          ) {
            const part = expression.parts[frame.index++]!;
            if (part.kind === "text")
              frame.text = templateText(frame.text, part.value, expression.span);
          }
          if (frame.index < expression.parts.length) {
            const part = expression.parts[frame.index++]!;
            if (part.kind === "expression") {
              frame.stage = 1;
              pending.push(evaluationFrame(part.expression));
              continue;
            }
          }
          value = frame.text;
          break;
        case "property":
          if (frame.stage++ === 0) {
            pending.push(evaluationFrame(expression.object));
            continue;
          }
          value = this.#getProperty(
            result.value,
            expression.name,
            expression.span,
            expression.object,
          );
          break;
        case "index":
          if (frame.stage === 0) {
            frame.stage = 1;
            pending.push(evaluationFrame(expression.object));
            continue;
          }
          if (frame.stage === 1) {
            frame.value = result.value;
            this.#assertIndexable(frame.value, expression.object, expression.span);
            frame.stage = 2;
            pending.push(evaluationFrame(expression.index));
            continue;
          }
          if (isDict(frame.value)) {
            value = this.#dictValue(
              frame.value,
              this.#dictKey(result.value, expression.index.span),
              expression,
            );
            break;
          }
          {
            // EVIDENCE: invariant: stage 1 validates and retains the index receiver.
            const object = frame.value as SerializableRuntimeList;
            const index = this.#listPosition(
              object,
              expression.object,
              expression.index,
              result.value,
              "read",
            );
            value = object.items[index]!;
          }
          break;
        case "typeTest":
          if (frame.stage++ === 0) {
            pending.push(evaluationFrame(expression.value));
            continue;
          }
          value = matchesValueType(result.value, expression.type) !== expression.negated;
          break;
        case "unary":
          if (frame.stage++ === 0) {
            pending.push(evaluationFrame(expression.operand));
            continue;
          }
          if (expression.operator === "not") {
            if (typeof result.value !== "boolean")
              throw notBoolean(
                "'not' needs true or false (boolean)",
                expression.operand,
                result.value,
                expression.operand.span,
                this.plan,
              );
            value = !result.value;
          } else if (isAnyDuration(result.value)) {
            value = expression.operator === "+" ? result.value : negateDuration(result.value);
          } else if (isAngle(result.value)) {
            value = expression.operator === "+" ? result.value : angleValue(-result.value.degrees);
          } else {
            if (typeof result.value !== "number") {
              const operand = operandLabel(expression.operand, this.plan);
              throw notNumber(
                `'${expression.operator}${operand ?? ""}'`,
                operand,
                "",
                result.value,
                expression.operand.span,
              );
            }
            // Negating a finite number gives a finite number.
            value = expression.operator === "+" ? result.value : -result.value;
          }
          break;
        case "unit": {
          if (frame.stage++ === 0) {
            pending.push(evaluationFrame(expression.operand));
            continue;
          }
          const unit = expression.calendar ? `calendar ${expression.unit}` : expression.unit;
          if (typeof result.value !== "number")
            throw fault(
              "TSR027",
              `${UNIT_AMOUNT_RULE}, but this is ${describeShownValue(result.value)}.${unitAmountFix(unit, isAnyDuration(result.value))}`,
              expression.operand.span,
            );
          const duration = unitValue(result.value, expression);
          if (typeof duration === "string")
            throw fault(
              "TSR009",
              `${duration}. Use a whole number before the '${unit}'.`,
              expression.span,
            );
          // Calendar parts must stay whole numbers that a value can store, like the milliseconds' finite range.
          const parts = durationParts(duration);
          if (
            !Number.isSafeInteger(parts.months) ||
            !Number.isSafeInteger(parts.days) ||
            !Number.isFinite(parts.milliseconds)
          )
            throw fault(
              "TSR036",
              `The number ${operandText(result.value)} before the '${unit}' gives a duration too long to represent. Use a smaller number.`,
              expression.span,
            );
          value = duration;
          break;
        }
        case "angleUnit": {
          if (frame.stage++ === 0) {
            pending.push(evaluationFrame(expression.operand));
            continue;
          }
          if (typeof result.value !== "number")
            throw fault(
              "TSR027",
              `${UNIT_AMOUNT_RULE}, but this is ${describeShownValue(result.value)}.${unitAmountFix(expression.unit, isAngle(result.value))}`,
              expression.operand.span,
            );
          const degrees = angleDegrees(result.value, expression.unit);
          if (degrees === undefined)
            throw fault(
              "TSR036",
              `The number ${operandText(result.value)} before the '${expression.unit}' gives an angle too large to represent. Use a smaller number.`,
              expression.span,
            );
          value = angleValue(degrees);
          break;
        }
        case "binary":
          if (frame.stage === 0) {
            frame.stage = 1;
            pending.push(evaluationFrame(expression.left));
            continue;
          }
          if (frame.stage === 1) {
            frame.value = result.value;
            // An operand is read when it is evaluated: copy a shared list, set, or object before a call in the right
            // operand can change it.
            if (
              (expression.operator === "==" || expression.operator === "!=") &&
              !result.owned &&
              (isList(frame.value) ||
                isSet(frame.value) ||
                isObject(frame.value) ||
                isDict(frame.value)) &&
              mayRunCall(expression.right)
            )
              frame.value = cloneCapturedSerializableValue(frame.value);
            if (expression.operator === "and" || expression.operator === "or") {
              if (typeof frame.value !== "boolean")
                throw notLogicalOperand(
                  expression.operator,
                  expression.left,
                  frame.value,
                  this.plan,
                );
              if (expression.operator === "and" ? !frame.value : frame.value) {
                value = frame.value;
                break;
              }
            }
            // The fallback runs only for a null value (V30 §18).
            if (expression.operator === "otherwise" && frame.value !== null) {
              value = frame.value;
              break;
            }
            frame.stage = 2;
            pending.push(evaluationFrame(expression.right));
            continue;
          }
          value = this.#binary(expression, frame.value, result.value);
          break;
        case "range":
          if (frame.stage === 0) {
            frame.stage = 1;
            pending.push(evaluationFrame(expression.start));
            continue;
          }
          if (frame.stage === 1) {
            frame.value = rangeBound(expression, "start", result.value, this.plan);
            frame.stage = 2;
            pending.push(evaluationFrame(expression.end));
            continue;
          }
          // EVIDENCE: invariant: range stage 1 validates the start before evaluating the end.
          value = {
            kind: "range",
            // EVIDENCE: invariant: range stage 1 validates and retains the numeric start.
            start: frame.value as number,
            end: rangeBound(expression, "end", result.value, this.plan),
            inclusive: expression.inclusive,
          };
          break;
        case "call":
          if (frame.stage === 0) {
            frame.stage = 1;
            if (expression.callee.kind === "property") {
              pending.push(evaluationFrame(expression.callee.object, true));
              continue;
            }
          } else if (frame.stage === 1 && expression.callee.kind === "property") {
            frame.value =
              result.epoch === this.#referenceEpoch
                ? result.value
                : this.#resolveDescriptor(result.descriptor!, expression.callee.object.span);
            // A traced call keeps the variable its receiver names, which a collection method may change.
            if (trace !== null) frame.descriptor = result.descriptor;
          } else if (frame.stage === 2) {
            const argument = expression.arguments[frame.index - 1]!;
            const captured = cloneCapturedSerializableValue(result.value);
            if (argument.kind === "positional") frame.positional!.push(captured);
            else {
              if (Object.hasOwn(frame.named!, argument.name))
                throw fault(
                  "TSR010",
                  internalFault(`The plan passes the named argument '${argument.name}' twice.`),
                  argument.span,
                );
              frame.named![argument.name] = captured;
            }
          } else if (frame.stage === 3) {
            const fallback = expression.arguments[frame.lazy]!.value;
            value = acceptedDefault(
              lazyDefaultCallOperation(expression)!,
              cloneCapturedSerializableValue(result.value),
              expression.typeCheck,
              fallback.span,
            );
            break;
          }
          // The default runs only when the call needs it, after the other arguments and the call's own work.
          if (frame.index === frame.lazy) frame.index += 1;
          if (frame.index < expression.arguments.length) {
            frame.stage = 2;
            pending.push(evaluationFrame(expression.arguments[frame.index++]!.value));
            continue;
          }
          {
            const called = this.#call(
              expression,
              frame.value,
              frame.positional!,
              frame.named!,
              frame.lazy !== -1 || frame.probe,
            );
            if (called === USE_DEFAULT) {
              if (frame.probe) {
                this.#defaultNeeded = true;
                value = null;
                break;
              }
              frame.stage = 3;
              pending.push(evaluationFrame(expression.arguments[frame.lazy]!.value));
              continue;
            }
            value = called;
          }
          if (
            trace !== null &&
            expression.callee.kind === "property" &&
            MUTATING_METHODS.has(expression.callee.name) &&
            (isList(frame.value) || isSet(frame.value) || isDict(frame.value))
          )
            this.#traceMutation(frame.descriptor, expression.span);
          break;
        case "tagQuery":
          // Every bound and tag list is evaluated once, in written order, before any image is matched.
          if (frame.stage === 0) frame.stage = 1;
          else frame.results!.push(result.value);
          if (frame.index < expression.operands.length) {
            pending.push(evaluationFrame(expression.operands[frame.index++]!));
            continue;
          }
          value = this.#tagQuery(expression, frame.results!);
          owned = true;
          break;
        case "storageLoad":
          if (frame.stage === 0) {
            frame.stage = 1;
            pending.push(evaluationFrame(expression.key));
            continue;
          }
          if (frame.stage === 1) {
            const key = storageKey(result.value, "load", expression.key.span);
            const entry = findScriptStorageEntry(this.snapshot, key);
            if (
              entry !== undefined &&
              this.#storedValueFits(key, entry.value, expression.type, expression.span)
            ) {
              value = entry.value;
              if (trace !== null) {
                trace.readStorage(key);
                trace.load(key, true, false, value, expression.span);
              }
              break;
            }
            if (expression.default === null) {
              value = null;
              // A probe's default runs as the instructions after it.
              if (frame.probe) this.#defaultNeeded = true;
              trace?.load(key, false, false, value, expression.span);
              break;
            }
            // The default is evaluated only for an absent key, or a stored value that does not fit the load's type.
            frame.key = key;
            frame.stage = 2;
            pending.push(evaluationFrame(expression.default));
            continue;
          }
          value = result.value;
          // The default takes the place of the stored value, so it fits the load's type, or is null.
          if (expression.type !== null)
            assertValueType(
              value,
              {
                type: { kind: "union", members: [expression.type, { kind: "null" }] },
                place: storageKeyPlace(frame.key!),
              },
              expression.default!.span,
            );
          trace?.load(frame.key!, false, true, value, expression.span);
          break;
      }
      result = { value, owned, descriptor: null, epoch: this.#referenceEpoch };
      pending.pop();
    }
    return result;
  }

  #unknownName(name: string, span: SourceSpan): RuntimeFault {
    // `speaker` is no variable: a message with a speaker reads it before any lookup, so this message has none.
    if (name === "speaker") return noSpeaker(span);
    return (
      this.#unsetVariable(name, span) ??
      fault(
        "TSR006",
        internalFault(`The plan uses the name '${name}' but does not declare it.`),
        span,
      )
    );
  }

  /**
   * The compiler resolves every name, so a top-level variable of the file that the running code cannot find has a `let`
   * that has not run in this activation: one entered at a label after the `let`, or code that runs before it, such as a
   * function called earlier (ADR 0022 §3.4). The message names the label the activation started at. Another name, such
   * as a configured global the host did not supply, gives `null`.
   */
  #unsetVariable(name: string, span: SourceSpan): RuntimeFault | null {
    const root = findRoot(this.snapshot, contextRootId(this.snapshot));
    if (root?.file === null || root === undefined || !declaresTopLevel(this.plan, root.file, name))
      return null;
    const file = this.plan.files[root.file]!;
    const label =
      root.entry === file.entryInstruction
        ? undefined
        : file.labels.find((candidate) => candidate.instruction === root.entry)?.name;
    return fault(
      "TSR070",
      label === undefined
        ? `'${name}' has no value yet: its 'let ${name}' has not run. Give ${name} a value before it is used.`
        : `'${name}' has no value yet: this file was started at label '${label}', and its 'let ${name}' has not run since. Give ${name} a value after the label, or make it a global.`,
      span,
    );
  }

  public assign(target: AssignmentTargetPlan, value: SerializableRuntimeValue): void {
    if (target.kind === "identifier") {
      const location = findBindingLocation(this.snapshot, this.plan, target.name);
      if (location === undefined) {
        throw (
          this.#unsetVariable(target.name, target.span) ??
          fault(
            "TSR002",
            internalFault(`The plan assigns to '${target.name}' but does not declare it.`),
            target.span,
          )
        );
      }
      // A speaker's own global names it for the whole session, so the compiler rejects an assignment to it (TSV004). A
      // variable that holds a speaker is an ordinary variable.
      const held = location.binding.value;
      if (
        location.frame.id === GLOBAL_SCOPE_ID &&
        isSpeakerReference(held) &&
        held.identifier === target.name
      ) {
        throw fault(
          "TSR034",
          internalFault(
            `The plan assigns to speaker '${target.name}', whose name always refers to that speaker.`,
          ),
          target.span,
        );
      }
      detachPreparedReferencesForMutation(this.snapshot, {
        rootFrameId: location.frame.id,
        rootName: target.name,
        path: [],
      });
      location.binding.value = cloneCapturedSerializableValue(value);
      this.trace?.write(
        "assignment",
        bindingKey(location.frame.id, target.name),
        target.name,
        location.binding.value,
      );
      return;
    }
    const object = this.evaluate(target.object);
    const receiverDescriptor =
      target.object.kind === "preparedReference"
        ? readPreparedReference(
            readTemporary(this.snapshot.temporaries, target.object.temporaryId, target.object.span),
            target.object.span,
          )
        : null;
    if (target.kind === "property") {
      if (receiverDescriptor !== null && !receiverDescriptor.detached) {
        const mutationStep: PreparedReferenceStep = { kind: "property", name: target.name };
        detachPreparedReferencesForMutation(this.snapshot, {
          rootFrameId: receiverDescriptor.rootFrameId,
          rootName: receiverDescriptor.rootName,
          path: [...receiverDescriptor.path, mutationStep],
          speakerPath: preparedReferenceSpeakerPath(this.snapshot, receiverDescriptor, [
            mutationStep,
          ]),
        });
      }
      if (isObject(object)) {
        setCapturedSerializableProperty(object, target.name, value);
        if (this.trace !== null)
          this.#traceVariableChange("assignment", receiverDescriptor, target.span);
        return;
      }
      // A speaker, timer, media, or camera view keeps its properties as runtime state, which every name for it reads.
      if (isSpeakerReference(object)) {
        const speaker = this.speakerById(object.speakerId, target.span);
        // A reference prepared to the property, through any name for the speaker, keeps the value it leads to now; so
        // does one to a property read through it, as a term through `gender`.
        const has = (name: string) => speaker.properties.some((property) => property.name === name);
        for (const name of [target.name, ...propertiesReadThrough(has, target.name)]) {
          const path: PreparedReferenceStep[] = [{ kind: "property", name }];
          detachPreparedReferencesForMutation(this.snapshot, {
            rootFrameId: GLOBAL_SCOPE_ID,
            rootName: speaker.identifier,
            path,
            speakerPath: { speakerId: speaker.id, path },
          });
        }
        setSpeakerProperty(speaker, target.name, value, target.span);
        if (this.trace !== null)
          this.#writeState(object, target.name, value, target.span, { property: target.name });
        return;
      }
      if (isTimerHandle(object)) {
        this.#assignTimerProperty(object, target.name, value, target.span);
        if (this.trace !== null)
          this.#writeState(object, target.name, value, target.span, { property: target.name });
        return;
      }
      if (isMediaHandle(object)) {
        this.#assignMediaProperty(object, target.name, value, target.span);
        if (this.trace !== null)
          this.#writeState(object, target.name, value, target.span, { property: target.name });
        return;
      }
      if (isCameraView(object)) {
        this.#assignCameraProperty(target.name, value, target.span);
        if (this.trace !== null)
          this.#writeState(object, target.name, value, target.span, { property: target.name });
        return;
      }
      if (isMessageHandle(object)) {
        this.#assignMessageProperty(object, target.name, value, target.span, target.object);
        return;
      }
      throw this.#noAssignableProperties(target.object, object, target.span);
    }
    if (isSet(object)) throw this.#notIndexable("TSR004", target.object, object, target.span);
    if (isDict(object)) {
      // A new key is added at the end; an existing key keeps its position.
      const key = this.#dictKey(this.evaluate(target.index), target.index.span);
      if (
        object.entries.length >= MAX_COLLECTION_LENGTH &&
        getSerializableDictEntry(object, key) === undefined
      )
        throw collectionTooLong(
          "dict",
          "assigning to a new key",
          target.span,
          object.entries.length + 1,
        );
      if (receiverDescriptor !== null && !receiverDescriptor.detached) {
        const mutationStep: PreparedReferenceStep = { kind: "key", key };
        detachPreparedReferencesForMutation(this.snapshot, {
          rootFrameId: receiverDescriptor.rootFrameId,
          rootName: receiverDescriptor.rootName,
          path: [...receiverDescriptor.path, mutationStep],
          speakerPath: preparedReferenceSpeakerPath(this.snapshot, receiverDescriptor, [
            mutationStep,
          ]),
        });
      }
      setCapturedSerializableDictValue(object, key, value);
      if (this.trace !== null)
        this.#traceVariableChange("assignment", receiverDescriptor, target.span);
      return;
    }
    if (!isList(object)) throw this.#notIndexable("TSR005", target.object, object, target.span);
    const index = this.#listPosition(
      object,
      target.object,
      target.index,
      this.evaluate(target.index),
      "assign",
    );
    if (receiverDescriptor !== null && !receiverDescriptor.detached) {
      const mutationStep: PreparedReferenceStep = { kind: "index", index };
      detachPreparedReferencesForMutation(this.snapshot, {
        rootFrameId: receiverDescriptor.rootFrameId,
        rootName: receiverDescriptor.rootName,
        path: [...receiverDescriptor.path, mutationStep],
        speakerPath: preparedReferenceSpeakerPath(this.snapshot, receiverDescriptor, [
          mutationStep,
        ]),
      });
    }
    object.items[index] = cloneCapturedSerializableValue(value);
    if (this.trace !== null)
      this.#traceVariableChange("assignment", receiverDescriptor, target.span);
  }

  /**
   * Runs `items += more`, or `items = items + more`, while the variable holds a list. The joined list starts with the
   * variable's own elements, so copies of the added ones are appended in place, as `addAll` adds them, instead of a
   * copy of the whole list for every addition. The result, its type check, its failures, and the prepared references
   * it freezes are those of the assignment. Gives `false`, having evaluated nothing, for any other assignment, and
   * while Debug traces, which explains the joined value.
   */
  public appendAssigned(
    target: AssignmentTargetPlan,
    value: ExpressionPlan,
    typeCheck: TypeCheckPlan | undefined,
  ): boolean {
    if (
      this.trace !== null ||
      target.kind !== "identifier" ||
      value.kind !== "binary" ||
      value.operator !== "+" ||
      value.left.kind !== "identifier" ||
      value.left.name !== target.name ||
      (typeCheck !== undefined && typeCheck.type.kind !== "list")
    )
      return false;
    const location = findBindingLocation(this.snapshot, this.plan, target.name);
    if (location === undefined) return false;
    const list = location.binding.value;
    if (!isList(list)) return false;
    const left = this.evaluate(value.left);
    const right = this.evaluate(value.right);
    // The compiler reads the variable before a user call in `more`, so without one `more` changes the list only in
    // place. Every store into the variable fits its type, so the joined list fits when the added elements do.
    if (
      left !== list ||
      !isList(right) ||
      (typeCheck !== undefined && !matchesValueType(right, typeCheck.type))
    ) {
      const joined = this.#binary(value, left, right);
      if (typeCheck !== undefined) assertValueType(joined, typeCheck, value.span);
      this.assign(target, joined);
      return true;
    }
    checkCollectionLength(
      "list",
      list.items.length + right.items.length,
      Math.max(list.items.length, right.items.length),
      "joining with +",
      value.span,
    );
    detachPreparedReferencesForMutation(this.snapshot, {
      rootFrameId: location.frame.id,
      rootName: target.name,
      path: [],
    });
    // Copies are taken first, so a list can add itself.
    const added = right.items.map((item) => cloneCapturedSerializableValue(item));
    for (const item of added) list.items.push(item);
    return true;
  }

  /**
   * `keepsRoot`: whether an attached reference keeps a copy of its root, as the plan decides for its temporary. Gives
   * the reference to store and the value it selects, which the debug trace shows instead of the reference.
   */
  public prepareReference(
    expression: ExpressionPlan,
    keepsRoot: boolean,
  ): { readonly reference: SerializableRuntimeObject; readonly value: SerializableRuntimeValue } {
    this.#keepPreparedRoot = keepsRoot;
    const prepared = this.#evaluateMachine(expression, true);
    let descriptor = prepared.descriptor!;
    // A reference extended from one that keeps a copy for its own preparation shares that copy.
    if (!keepsRoot && !descriptor.detached) descriptor = { ...descriptor, capturedRoot: undefined };
    return {
      reference: serializePreparedReference(
        this.#restorableDescriptor(descriptor, expression.span),
      ),
      value: prepared.value,
    };
  }

  /**
   * Restore validation needs the path of a stored reference to lead somewhere from its captured root and, while it is
   * attached, from its binding. Either can fall behind: an index can add the value it names after the root was
   * captured, or remove an ancestor of that value from the binding, and a reference extended from an earlier one keeps
   * that one's root, which lacks what a function call since then has added. A reference whose binding no longer leads
   * there is detached, as its first use would detach it, and fails now if its captured root falls short as well, as
   * that use would fail. An attached reference whose captured root falls short captures the root it resolves through.
   */
  #restorableDescriptor(
    descriptor: PreparedReferenceDescriptor,
    span: SourceSpan,
  ): PreparedReferenceDescriptor {
    if (descriptor.detached) return descriptor;
    if (descriptor.capturedRoot === undefined) {
      // Without a call after its root was read, nothing changed the variable while the reference was prepared.
      this.#resolveDescriptor(descriptor, span);
      return descriptor;
    }
    if (!this.#resolves(descriptor, span)) {
      const detached = { ...descriptor, detached: true };
      this.#resolveDescriptor(detached, span);
      return detached;
    }
    if (this.#resolves({ ...descriptor, detached: true }, span)) return descriptor;
    return {
      ...descriptor,
      capturedRoot: this.#resolveDescriptor({ ...descriptor, path: [] }, span),
    };
  }

  #resolves(descriptor: PreparedReferenceDescriptor, span: SourceSpan): boolean {
    try {
      this.#resolveDescriptor(descriptor, span);
      return true;
    } catch (error) {
      if (error instanceof RuntimeFault) return false;
      throw error;
    }
  }

  public validateAssignmentTarget(target: AssignmentTargetPlan): void {
    if (target.kind === "identifier") return;
    const object = this.evaluate(target.object);
    if (target.kind === "property") {
      if (
        !isObject(object) &&
        !isSpeakerReference(object) &&
        !isTimerHandle(object) &&
        !isMediaHandle(object) &&
        !isMessageHandle(object) &&
        !isCameraView(object)
      ) {
        throw this.#noAssignableProperties(target.object, object, target.span);
      }
      return;
    }
    if (isSet(object)) throw this.#notIndexable("TSR004", target.object, object, target.span);
    if (isDict(object)) {
      this.#dictKey(this.evaluate(target.index), target.index.span);
      return;
    }
    if (!isList(object)) throw this.#notIndexable("TSR005", target.object, object, target.span);
    this.#listPosition(object, target.object, target.index, this.evaluate(target.index), "assign");
  }

  public validateCallReceiver(
    receiver: SerializableRuntimeValue,
    method: string,
    span: SourceSpan,
  ): void {
    if (isCameraView(receiver))
      throw fault("TSR016", handleMemberMessage("camera", method, "call"), span);
    if (isTimerHandle(receiver) || isMediaHandle(receiver)) {
      if (!["pause", "resume", "stop"].includes(method)) {
        throw fault(
          "TSR016",
          handleMemberMessage(isTimerHandle(receiver) ? "timer" : "media", method, "call"),
          span,
        );
      }
      return;
    }
    if (isMessageHandle(receiver) || isPermanentButton(receiver)) {
      if (method !== "remove")
        throw fault("TSR016", removableHandleMethodMessage(receiver, method), span);
      return;
    }
    if (typeof receiver === "string") {
      if (!STRING_METHODS.has(method))
        throw fault("TSR016", unknownTextMemberMessage(method, "method"), span);
      return;
    }
    if (isTemporal(receiver)) {
      if (!hasTemporalMethod(receiver, method))
        throw fault(
          "TSR016",
          `${describeRuntimeValue(receiver).replace(/^a/u, "A")} has no method '${method}'.`,
          span,
        );
      return;
    }
    if (isRange(receiver) && method === "toList") return;
    if (!isList(receiver) && !isSet(receiver) && !isDict(receiver)) {
      throw fault("TSR016", missingMemberMessage(receiver, method, "method"), span);
    }
    const supported = isDict(receiver)
      ? DICT_METHODS
      : isSet(receiver)
        ? new Set(["add", "remove", "clear", "contains", "toList", ...SET_OPERATIONS])
        : new Set([
            ...SET_OPERATIONS,
            "sort",
            "shuffle",
            "reverse",
            "add",
            "addAll",
            "remove",
            "removeAt",
            "removeFirst",
            "removeLast",
            "clear",
            "contains",
            "indexOf",
            "lastIndexOf",
            "count",
            "get",
            "toSet",
            "join",
            "take",
            "takeLast",
          ]);
    if (!supported.has(method)) throw fault("TSR016", noCollectionMethod(receiver, method), span);
  }

  #resolvePreparedReference(
    serialized: SerializableRuntimeValue,
    span: SourceSpan,
  ): SerializableRuntimeValue {
    const descriptor = readPreparedReference(serialized, span);
    if (descriptor.detached) return this.#resolveDescriptor(descriptor, span);
    try {
      return this.#resolveDescriptor(descriptor, span);
    } catch (error) {
      if (
        !(error instanceof RuntimeFault) ||
        !isObject(serialized) ||
        descriptor.capturedRoot === undefined
      )
        throw error;
      setCapturedSerializableProperty(serialized, "detached", true);
      return this.#resolveDescriptor({ ...descriptor, detached: true }, span);
    }
  }

  #resolveDescriptor(
    descriptor: PreparedReferenceDescriptor,
    span: SourceSpan,
  ): SerializableRuntimeValue {
    let value: SerializableRuntimeValue;
    if (!descriptor.detached && descriptor.rootFrameId !== null && descriptor.rootName !== null) {
      const binding = scopeBindings(this.snapshot, descriptor.rootFrameId)?.find(
        (candidate) => candidate.name === descriptor.rootName,
      );
      if (binding === undefined) {
        throw fault(
          "TSR053",
          internalFault("A prepared reference points to a variable that no longer exists."),
          span,
        );
      }
      value = binding.value;
    } else {
      // EVIDENCE: readPreparedReference and the reference machine give every detached or rootless reference a captured
      // root, and #restorableDescriptor detaches only a reference that keeps one.
      value = descriptor.capturedRoot!;
    }
    for (const step of descriptor.path) {
      if (step.kind === "property") {
        value = this.#getProperty(value, step.name, span);
        continue;
      }
      if (step.kind === "key") {
        const entry = isDict(value) ? getSerializableDictEntry(value, step.key) : undefined;
        if (entry === undefined)
          throw fault(
            "TSR053",
            `The dict entry this statement changes no longer exists: something in the same statement removed the key ${quotedText(messageText(step.key))}. Make the change in a separate statement.`,
            span,
          );
        value = entry.value;
        continue;
      }
      // Only a list is addressed by position; a set member is always read as a copy.
      if (isList(value)) {
        if (step.index < 0 || step.index >= value.items.length) {
          throw fault(
            "TSR025",
            `The list element this statement changes no longer exists: something in the same statement removed position ${step.index}. Make the change in a separate statement.`,
            span,
          );
        }
        value = value.items[step.index]!;
        continue;
      }
      throw fault(
        "TSR008",
        "The list this statement changes was replaced while the statement ran. Make the change in a separate statement.",
        span,
      );
    }
    return value;
  }

  public speakerByName(name: string, span: SourceSpan): RuntimeSpeakerSnapshot {
    const binding = this.binding(name);
    if (binding === undefined || !isSpeakerReference(binding.value)) {
      throw fault("TSR023", internalFault(`'${name}' is not a declared speaker.`), span);
    }
    return this.speakerById(binding.value.speakerId, span);
  }

  public speakerById(id: number, span: SourceSpan): RuntimeSpeakerSnapshot {
    const speaker = this.snapshot.speakers.find((item) => item.id === id);
    if (speaker === undefined)
      throw fault("TSR023", internalFault(`The session has no speaker with ID ${id}.`), span);
    return speaker;
  }

  /** A speaker's name or title as shown text, like any other shown value, or `null` when it is not set. */
  #speakerText(speaker: RuntimeSpeakerSnapshot, name: string, span: SourceSpan): string | null {
    const value = speaker.properties.find((property) => property.name === name)?.value;
    if (
      value === undefined ||
      value === null ||
      typeof value === "string" ||
      !isVisibleScalar(value)
    )
      return optionalSpeakerString(speaker, name, span);
    return visibleText(value, span, currentTemporalContext(this.snapshot));
  }

  /**
   * `player.copyFrom(account)` (V30 §37): the player gets a copy of each person field of the account and loses each one
   * the account lacks, in place, so its other properties keep their order.
   */
  public copyAccount(span: SourceSpan): void {
    const player = this.speakerByName(PLAYER, span);
    const reference: SerializableRuntimeValue = {
      kind: "speakerReference",
      speakerId: player.id,
      identifier: player.identifier,
    };
    // The copy may change every person field, so a reference prepared to one keeps the value it leads to now.
    for (const name of PERSON_FIELDS) {
      const path: PreparedReferenceStep[] = [{ kind: "property", name }];
      detachPreparedReferencesForMutation(this.snapshot, {
        rootFrameId: GLOBAL_SCOPE_ID,
        rootName: player.identifier,
        path,
        speakerPath: { speakerId: player.id, path },
      });
    }
    for (const name of PERSON_FIELDS) {
      const value = this.snapshot.account.find((field) => field.name === name)?.value;
      if (value === undefined) {
        const index = player.properties.findIndex((property) => property.name === name);
        if (index >= 0) player.properties.splice(index, 1);
        continue;
      }
      setSpeakerProperty(player, name, value, span);
      if (this.trace === null) continue;
      // Each field depends only on the account's field it copies.
      const previous = this.trace.push();
      this.trace.readState(stateKey("account", name), null, `account.${name}`, value, true);
      this.#writeState(reference, name, value, span, { property: name });
      this.trace.pop(previous);
    }
  }

  public outputSpeaker(
    speaker: RuntimeSpeakerSnapshot,
    span: SourceSpan,
    events: InterpreterEvent[],
  ): OutputSpeaker {
    // The player's own message shows no name and no avatar (V30 §37).
    if (speaker.identifier === PLAYER)
      return Object.freeze({
        identifier: PLAYER,
        displayName: "",
        color: normalizeColor(
          speaker.properties.find((property) => property.name === "color")?.value,
        ),
        font: optionalSpeakerString(speaker, "font", span),
        avatar: null,
      });
    const explicit = this.#speakerText(speaker, "displayName", span);
    let displayName: string;
    let fallback = false;
    if (explicit !== null) {
      if (explicit.length === 0) {
        throw fault(
          "TSR022",
          `Speaker '${speaker.identifier}' has an empty displayName. Give it a name, or leave displayName out to show '${speaker.identifier}'.`,
          span,
        );
      }
      displayName = explicit;
    } else {
      const parts = [
        this.#speakerText(speaker, "title", span) ?? this.#speakerText(speaker, "shortTitle", span),
        this.#speakerText(speaker, "firstName", span),
        this.#speakerText(speaker, "lastName", span),
      ].filter((part): part is string => part !== null && part.length > 0);
      checkTextLength(
        parts.reduce((length, part) => length + part.length + 1, -1),
        "say",
        span,
      );
      const derived = parts.join(" ");
      displayName = derived.length === 0 ? speaker.identifier : derived;
      fallback = derived.length === 0;
    }
    if (fallback && !this.snapshot.warnedSpeakerIds.includes(speaker.id)) {
      const warningSequence = takeSequence(this.snapshot);
      this.snapshot.warnedSpeakerIds.push(speaker.id);
      events.push(
        Object.freeze({
          kind: "developerWarning",
          sequence: warningSequence,
          severity: "warning",
          code: "TSW001" satisfies DeveloperWarningCode,
          message: `Speaker '${speaker.identifier}' uses its identifier as the display name.`,
          span: copySpan(span),
        } satisfies DeveloperWarningEvent),
      );
    }
    return Object.freeze({
      identifier: speaker.identifier,
      displayName,
      color: normalizeColor(
        speaker.properties.find((property) => property.name === "color")?.value,
      ),
      font: optionalSpeakerString(speaker, "font", span),
      avatar: optionalSpeakerString(speaker, "avatar", span),
    });
  }

  /** `${...}` text. A list selects one element with the session RNG, again at every evaluation. */
  public interpolationText(value: SerializableRuntimeValue, span: SourceSpan): string {
    if (isDict(value)) throw fault("TSR021", DICT_TEXT_MESSAGE, span);
    if (!isList(value)) return visibleText(value, span, currentTemporalContext(this.snapshot));
    if (value.items.length === 0)
      throw fault(
        "TSR019",
        "'${...}' shows one random element of a list, but this list is empty. Check its length first.",
        span,
      );
    if (!value.items.every(isVisibleScalar))
      throw fault(
        "TSR021",
        "An interpolated list may contain only text, numbers, true, false, null, durations, angles, date and time values, script references, and regexes, because one element is shown as text.",
        span,
      );
    return visibleText(
      this.#randomItem(value.items, span, "interpolation"),
      span,
      currentTemporalContext(this.snapshot),
    );
  }

  /** `say` text. A value other than a scalar shows in code-like notation, escaped so that markup leaves it literal. */
  public sayText(value: SerializableRuntimeValue, span: SourceSpan): string {
    // A script reference shows as the call that makes it, and a regex as its literal, which are notation too.
    if (isVisibleScalar(value) && !isScriptReference(value) && !isRegex(value))
      return visibleText(value, span, currentTemporalContext(this.snapshot));
    const notation = valueNotation(
      value,
      span,
      (handle) => this.#handleNotation(handle, span),
      "say",
    );
    // Escaping puts a backslash before some characters, so only a notation that could get too long is measured first.
    if (notation.length * 2 > MAX_TEXT_LENGTH)
      checkTextLength(escapedMarkupLength(notation), "say", span);
    return escapeMarkup(notation);
  }

  /**
   * A handle as `say` shows it, from the state the snapshot holds now: `<timer "Beat", 7 s left>`,
   * `<timer, paused, 7 s left>`, `<media "music.mp3", playing at 12 s>`, a settled `<timer, finished>`, or
   * `<permanent button "Stop">`.
   */
  #handleNotation(
    handle:
      | SerializableTimerHandle
      | SerializableMediaHandle
      | SerializablePermanentButtonHandle
      | SerializableCameraViewHandle,
    span: SourceSpan,
  ): string {
    if (this.trace !== null) this.#readState(handle, null);
    if (isCameraView(handle)) {
      const view = this.#cameraView();
      return view.shown ? `<camera ${view.placement}>` : "<camera, hidden>";
    }
    if (isPermanentButton(handle)) {
      const shown = shownPermanentButton(this.snapshot, handle.buttonId);
      return shown === undefined
        ? "<permanent button, removed>"
        : quotedTextWithin("<permanent button ", shown.button.text, ">", "say", span);
    }
    const now = this.snapshot.currentSessionTimeMs;
    const time = (value: SerializableRuntimeValue | undefined): string =>
      value !== undefined && isDuration(value) ? formatDuration(value.milliseconds) : "";
    if (isTimerHandle(handle)) {
      const timer = this.#timer(handle, span);
      const left = `${time(timerProperty(timer, "remaining", now))} left`;
      const rest =
        timer.state === "running"
          ? `, ${left}>`
          : timer.state === "paused"
            ? `, paused, ${left}>`
            : `, ${timer.state}>`;
      return timer.label === null
        ? `<timer${rest}`
        : quotedTextWithin("<timer ", timer.label, rest, "say", span);
    }
    const media = this.#media(handle, span);
    const at = `at ${time(mediaProperty(media, "position", now))}`;
    const state =
      media.state === "running"
        ? `playing ${at}`
        : media.state === "paused"
          ? `paused ${at}`
          : media.state;
    return quotedTextWithin("<media ", media.source, `, ${state}>`, "say", span);
  }

  /** One element of `list.join()`: a scalar as visible text, without selecting from nested lists. */
  #joinedText(item: SerializableRuntimeValue, span: SourceSpan): string {
    if (!isVisibleScalar(item))
      throw fault(
        "TSR021",
        "join() can only join text, numbers, true or false, null, durations, angles, date and time values, script references, and regexes. Select an element or a property first.",
        span,
      );
    return visibleText(item, span, currentTemporalContext(this.snapshot));
  }

  #binary(
    expression: BinaryExpressionPlan,
    left: SerializableRuntimeValue,
    right: SerializableRuntimeValue,
  ): SerializableRuntimeValue {
    if (expression.operator === "and" || expression.operator === "or") {
      if (typeof right !== "boolean")
        throw notLogicalOperand(expression.operator, expression.right, right, this.plan);
      return right;
    }
    if (expression.operator === "otherwise") return right;
    if (expression.operator === "==" || expression.operator === "!=") {
      const equal = serializableEquals(left, right);
      return expression.operator === "==" ? equal : !equal;
    }
    if (expression.operator === "in") {
      if (!isRange(right))
        throw fault(
          "TSR035",
          internalFault(
            `The plan applies 'in' to ${describeShownValue(right)}, but 'in' needs a range on its right side.`,
          ),
          expression.span,
        );
      return (
        typeof left === "number" &&
        left >= right.start &&
        (right.inclusive ? left <= right.end : left < right.end)
      );
    }
    if (
      expression.operator === "+" &&
      (typeof left === "string" || typeof right === "string" || isList(left) || isList(right))
    )
      return this.#joined(expression, left, right);
    const temporal = temporalBinary(expression.operator, left, right, expression.span);
    if (temporal !== undefined) return temporal;
    if (isAngle(left) || isAngle(right)) return angleBinary(expression, left, right, this.plan);
    if (isAnyDuration(left) || isAnyDuration(right))
      return this.#durationBinary(expression, left, right);
    if (["<", "<=", ">", ">="].includes(expression.operator)) {
      if (
        (typeof left !== "number" || typeof right !== "number") &&
        (typeof left !== "string" || typeof right !== "string")
      ) {
        throw notComparable(expression, left, right, this.plan);
      }
      if (expression.operator === "<") return left < right;
      if (expression.operator === "<=") return left <= right;
      if (expression.operator === ">") return left > right;
      return left >= right;
    }
    const leftNumber = operandNumber(expression, "left", left, this.plan);
    const rightNumber = operandNumber(expression, "right", right, this.plan);
    let result: number;
    switch (expression.operator) {
      case "+":
        result = leftNumber + rightNumber;
        break;
      case "-":
        result = leftNumber - rightNumber;
        break;
      case "*":
        result = leftNumber * rightNumber;
        break;
      case "/":
        result = leftNumber / rightNumber;
        break;
      case "%":
        result = leftNumber % rightNumber;
        break;
      default:
        throw fault(
          "TSR035",
          internalFault(`The engine has no arithmetic for the operator '${expression.operator}'.`),
          expression.span,
        );
    }
    if (!Number.isFinite(result)) throw noArithmeticResult(expression, left, right, this.plan);
    return result;
  }

  /**
   * `+` on text or a list (V30 §4): two texts join, and two lists give a new list of copies of the left elements, then
   * the right ones. Nothing converts, so any other operand fails with what to write instead.
   */
  #joined(
    expression: BinaryExpressionPlan,
    left: SerializableRuntimeValue,
    right: SerializableRuntimeValue,
  ): SerializableRuntimeValue {
    if (typeof left === "string" && typeof right === "string") {
      checkTextLength(left.length + right.length, "joining with +", expression.span);
      return left + right;
    }
    if (isList(left) && isList(right)) {
      checkCollectionLength(
        "list",
        left.items.length + right.items.length,
        Math.max(left.items.length, right.items.length),
        "joining with +",
        expression.span,
      );
      return createCapturedSerializableList(left.items.concat(right.items));
    }
    throw fault(
      "TSR009",
      `'+' joins two texts or two lists and adds numbers or durations, but these are ${describeRuntimeValue(left)} and ${describeRuntimeValue(right)}.${joinFix(left, right)}`,
      expression.span,
    );
  }

  /**
   * Duration arithmetic and comparison (ADR 0026); mixing with plain numbers is explicit only. A calendar duration stays
   * one, its months and days stay whole, and calendar durations compare and divide only within one family, never with
   * an exact duration.
   */
  #durationBinary(
    expression: BinaryExpressionPlan,
    left: SerializableRuntimeValue,
    right: SerializableRuntimeValue,
  ): SerializableRuntimeValue {
    const span = expression.span;
    const operator = expression.operator;
    const result = (duration: AnyDuration | string): AnyDuration => {
      // An exact duration divided by zero has no result like a number; a calendar one keeps its parts' error code.
      if (duration === ZERO_DIVISOR)
        throw isAnyDuration(left) && isCalendar(left)
          ? noArithmeticResult(expression, left, right, this.plan, "TSR009")
          : noArithmeticResult(expression, left, right, this.plan);
      if (typeof duration === "string")
        throw fault("TSR009", `Operator '${operator}': ${duration}.`, span);
      // Calendar parts must stay whole numbers that a value can store, like the milliseconds' finite range.
      const parts = durationParts(duration);
      if (
        !Number.isSafeInteger(parts.months) ||
        !Number.isSafeInteger(parts.days) ||
        !Number.isFinite(parts.milliseconds)
      )
        throw noArithmeticResult(expression, left, right, this.plan);
      return duration;
    };
    if (isAnyDuration(left) && isAnyDuration(right)) {
      switch (operator) {
        case "+":
          return result(addDurations(left, right));
        case "-":
          return result(addDurations(left, right, -1));
        case "/": {
          const ratio = durationQuotient(left, right);
          // An exact zero divisor has no result like a number's; a calendar one has no family to divide in.
          if (ratio === ZERO_DIVISOR)
            throw isCalendar(left)
              ? noArithmeticResult(expression, left, right, this.plan, "TSR009")
              : noArithmeticResult(expression, left, right, this.plan);
          if (typeof ratio === "string")
            throw fault(
              "TSR009",
              `${formatDuration(left)} cannot be divided by ${formatDuration(right)}: ${ratio}.`,
              span,
            );
          if (!Number.isFinite(ratio)) throw noArithmeticResult(expression, left, right, this.plan);
          return ratio;
        }
        case "<":
        case "<=":
        case ">":
        case ">=": {
          const order = compareDurations(left, right);
          if (typeof order === "string")
            throw fault(
              "TSR009",
              `${formatDuration(left)} and ${formatDuration(right)} cannot be compared: ${order}.`,
              span,
            );
          if (operator === "<") return order < 0;
          if (operator === "<=") return order <= 0;
          if (operator === ">") return order > 0;
          return order >= 0;
        }
      }
    } else if (isAnyDuration(left) && typeof right === "number") {
      if (operator === "*") return result(scaleDuration(left, right));
      if (operator === "/") return result(divideDuration(left, right));
    } else if (typeof left === "number" && isAnyDuration(right) && operator === "*") {
      return result(scaleDuration(right, left));
    }
    throw fault(
      "TSR009",
      ["<", "<=", ">", ">="].includes(operator)
        ? `'${operator}' cannot compare ${kindAndValue(left)} with ${kindAndValue(right)}. Use a duration on both sides.`
        : `'${operator}' cannot combine ${kindAndValue(left)} and ${kindAndValue(right)}. Add or subtract two durations, or multiply or divide a duration by a number.`,
      span,
    );
  }

  /**
   * `defaulted`: the call has a `default:`, which `named` leaves out; the call gives `USE_DEFAULT` when it needs it.
   */
  #call(
    expression: Extract<ExpressionPlan, { kind: "call" }>,
    receiver: SerializableRuntimeValue,
    positional: SerializableRuntimeValue[],
    named: Record<string, SerializableRuntimeValue>,
    defaulted: boolean,
  ): SerializableRuntimeValue | typeof USE_DEFAULT {
    if (expression.callee.kind === "identifier") {
      const name = expression.callee.name;
      if (isConversion(name))
        return this.#conversion(
          name,
          positional,
          named,
          defaulted,
          expression.arguments[0]?.value,
          expression.span,
        );
      if (name === "hashText") return hashedText(positional, named, expression.span);
      if (NUMERIC_FUNCTIONS.has(name))
        return this.#numericFunction(name, positional, named, expression.span);
      if (ANGLE_FUNCTIONS.has(name)) return angleFunction(name, positional, named, expression.span);
      if (MIN_MAX_BUILTINS.has(name))
        return this.#minMaxBuiltin(name, positional, named, expression.span);
      if (LIST_STATISTICS.has(name)) return listStatistic(name, positional, named, expression.span);
      if (name === "linearRegression") return linearRegression(positional, named, expression.span);
      if (name === "predict") return predict(positional, named, expression.span);
      if (name === "randomWeighted")
        return this.#randomWeighted(positional, named, expression.span);
      if (name === "script") return scriptReference(positional, named, expression.span);
      const coreBuiltin = CORE_RUNTIME_BUILTINS.some((builtin) => builtin === name);
      const platformPrelude = name === "escapeMarkup";
      const hostBuiltin = !coreBuiltin && !platformPrelude;
      const builtin = Object.hasOwn(this.#builtins, name) ? this.#builtins[name] : undefined;
      // While the unit before a paused draw runs again, a host builtin returns its recorded result without being
      // called, so it need not be registered then.
      const recorded = hostBuiltin ? this.control?.replayedBuiltin() : undefined;
      if (hostBuiltin && builtin === undefined && recorded === undefined) {
        // The compiler rejects a call of a parenthesized name that is not a function, such as `(x)()`, but a plan
        // compiled before it did may still hold one, so the message does not blame the Playroom.
        const bound = this.binding(name);
        throw fault(
          "TSR011",
          `'${name}' is ${bound === undefined ? "not a function the Playroom provides" : `${describeShownValue(bound.value)}, not a function`}, so it cannot be called. Call a function by its name instead.`,
          expression.callee.span,
        );
      }
      if (TEMPORAL_GETTERS.has(name)) {
        const now = this.snapshot.currentSessionTimeMs;
        const capture = temporalCaptureAt(this.snapshot.temporalCaptures, now);
        return temporalNow(name, positional, named, capture, now, expression.span);
      }
      const call = Object.freeze({
        positional: Object.freeze(positional),
        named: Object.freeze(named),
        span: copySpan(expression.span),
      });
      let returned: SerializableRuntimeValue;
      try {
        switch (name) {
          case "random":
            returned = this.#randomBuiltin(call);
            break;
          case "chance":
            returned = this.#chanceBuiltin(call);
            break;
          case "randomInteger":
            returned = this.#randomIntegerBuiltin(call);
            break;
          case "escapeMarkup":
            returned = this.#escapeMarkupBuiltin(call);
            break;
          default:
            returned = recorded === undefined ? builtin!(call) : recorded;
        }
      } catch (error) {
        // A pause, or the host's decision callback failing, is not the builtin's failure.
        if (error instanceof RandomControlSignal) throw error;
        if (error instanceof SerializableValueError) {
          const code = error.code === "cyclic" ? "TSR031" : "TSR013";
          throw fault(code, invalidReturn(name, error.message), expression.span);
        }
        // A text that would be too long fails as it does anywhere else.
        if (error instanceof RuntimeFault && error.code === "TSR084") throw error;
        // A core built-in's own failure keeps its code and already says what to do; a host's comes with the built-in's
        // name.
        if (!hostBuiltin && error instanceof RuntimeFault) throw error;
        const message = messageText(error instanceof Error ? error.message : String(error)).trim();
        const reason =
          message === "" ? "" : `: ${/[.!?…]$/u.test(message) ? message : `${message}.`}`;
        throw fault(
          "TSR012",
          `The built-in function '${name}' failed${reason === "" ? "." : reason} Check the values the script passes to '${name}'. If they are correct, report this with a debug export.`,
          expression.span,
        );
      }
      let copied: SerializableRuntimeValue;
      try {
        copied = cloneSerializableValue(returned);
      } catch (error) {
        if (error instanceof SerializableValueError)
          throw fault("TSR013", invalidReturn(name, error.message), expression.span);
        throw error;
      }
      // Handles and speaker references name records that only the runtime creates; a host cannot hand one out.
      const identity = findRuntimeIdentity(copied);
      if (identity !== null) {
        const kind = describeRuntimeValue(identity);
        throw fault(
          "TSR013",
          internalFault(
            `The built-in function '${name}' returned a value that contains ${kind}. Only the engine creates ${kind.replace(/^an? /u, "")}s, so a built-in cannot return one.`,
          ),
          expression.span,
        );
      }
      if (hostBuiltin) this.control?.recordBuiltin(copied);
      return copied;
    }
    if (expression.callee.kind === "property" && isTimerHandle(receiver)) {
      const called = this.#callTimer(
        receiver,
        expression.callee.name,
        positional,
        named,
        expression.span,
      );
      if (this.trace !== null)
        this.#writeState(receiver, `${expression.callee.name}()`, null, expression.span, "timed");
      return called;
    }
    if (expression.callee.kind === "property" && isMediaHandle(receiver)) {
      const called = this.#callMedia(
        receiver,
        expression.callee.name,
        positional,
        named,
        expression.span,
      );
      if (this.trace !== null)
        this.#writeState(receiver, `${expression.callee.name}()`, null, expression.span, "timed");
      return called;
    }
    if (expression.callee.kind === "property" && isPermanentButton(receiver)) {
      const called = this.#callPermanentButton(
        receiver,
        expression.callee.name,
        positional,
        named,
        expression.span,
      );
      if (this.trace !== null)
        this.#writeState(receiver, "removed", null, expression.span, "whole");
      return called;
    }
    if (expression.callee.kind === "property" && isMessageHandle(receiver))
      return this.#callMessage(
        receiver,
        expression.callee.name,
        positional,
        named,
        expression.span,
      );
    if (expression.callee.kind === "property" && typeof receiver === "string") {
      const name = Object.keys(named)[0];
      if (name !== undefined)
        throw fault(
          "TSR015",
          unknownNamedArgumentMessage(expression.callee.name, name, []),
          expression.span,
        );
      return callStringMethod(receiver, expression.callee.name, positional, expression.span);
    }
    if (expression.callee.kind === "property" && isTemporal(receiver)) {
      return temporalMethod(
        receiver,
        expression.callee.name,
        positional,
        named,
        currentTemporalContext(this.snapshot),
        expression.span,
      );
    }
    if (expression.callee.kind === "property" && isDict(receiver)) {
      this.#referenceEpoch++;
      return this.#callDict(receiver, expression, positional, named, defaulted);
    }
    if (
      expression.callee.kind === "property" &&
      expression.callee.name === "toList" &&
      isRange(receiver)
    ) {
      const problem = argumentShapeProblem(
        "toList",
        NO_ARGUMENTS,
        positional.length,
        Object.keys(named),
      );
      if (problem !== undefined) throw fault("TSR028", problem.message, expression.span);
      return rangeList(receiver, expression.span);
    }
    if (expression.callee.kind === "property") {
      return this.#callCollection(
        receiver!,
        expression.callee.object,
        expression.callee.name,
        positional,
        named,
        defaulted,
        expression.span,
        expression.typeCheck === undefined || expression.callee.name === "get"
          ? null
          : // Plan validation accepts a type check only on an `add` or `addAll` call with one argument, or a `get` call
            // with a `default:`, whose default checks it when it is used; it checks the last argument.
            { check: expression.typeCheck, span: expression.arguments.at(-1)!.value.span },
      );
    }
    const callee =
      expression.callee.kind === "literal" ? null : planLabel(expression.callee, this.plan);
    throw fault(
      "TSR014",
      `Only a function or a method can be called, but ${callee === null ? "this" : `'${callee}'`} is neither. Call a function by its name instead.`,
      expression.callee.span,
    );
  }

  /** `added` is the check of an element that `add` inserts, from the compiler (ADR 0021 rule 1.7). */
  #callCollection(
    receiver: SerializableRuntimeValue,
    receiverPlan: ExpressionPlan,
    name: string,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    defaulted: boolean,
    span: SourceSpan,
    added: { readonly check: TypeCheckPlan; readonly span: SourceSpan } | null,
  ): SerializableRuntimeValue | typeof USE_DEFAULT {
    this.#referenceEpoch++;
    if (!isList(receiver) && !isSet(receiver))
      throw fault("TSR016", missingMemberMessage(receiver, name, "method"), span);
    const namedArgument = Object.keys(named)[0];
    // Only a list's `get` takes a named argument, its `default:`; a set has no `get`.
    if (namedArgument !== undefined && name !== "get")
      throw fault("TSR015", unknownNamedArgumentMessage(name, namedArgument, []), span);
    // The method's parameters as the compiler checks them for a list or a set.
    const expect = (): void => {
      const method = POSITIONAL_METHODS.get(name) ?? LIST_ONLY_METHODS.get(name)!;
      if (positional.length !== method.parameters!.length)
        throw fault("TSR028", methodArgumentCountMessage(method, positional.length), span);
    };
    try {
      if (isSet(receiver)) {
        switch (name) {
          case "add":
            expect();
            if (added !== null) assertValueType(positional[0]!, added.check, added.span);
            if (
              receiver.items.length >= MAX_COLLECTION_LENGTH &&
              !serializableSetContains(receiver, positional[0]!)
            )
              throw collectionTooLong("set", "add(...)", span, receiver.items.length + 1);
            addSerializableSetValue(receiver, positional[0]!);
            return null;
          case "remove":
            expect();
            removeSerializableSetValue(receiver, positional[0]!);
            return null;
          case "clear":
            expect();
            clearSerializableSet(receiver);
            return null;
          case "contains":
            expect();
            return serializableSetContains(receiver, positional[0]!);
          case "toList":
            expect();
            return createCapturedSerializableList(receiver.items);
          case "intersection":
          case "union":
          case "difference": {
            expect();
            const argument = this.#setOperationArgument(name, positional[0]!, span);
            const items = setOperationItems(name, receiver.items, argument);
            checkCollectionLength(
              "set",
              items.length,
              Math.max(receiver.items.length, argument.length),
              `${name}(...)`,
              span,
            );
            return createCapturedSerializableSet(items);
          }
          case "sort":
          case "shuffle":
          case "reverse":
            throw fault(
              "TSR016",
              `A set keeps its insertion order, so it has no ${name}(). Copy it into a list with toList() first.`,
              span,
            );
          default:
            throw fault("TSR016", noCollectionMethod(receiver, name), span);
        }
      }
      switch (name) {
        case "add":
          expect();
          if (added !== null) assertValueType(positional[0]!, added.check, added.span);
          checkCollectionLength(
            "list",
            receiver.items.length + 1,
            receiver.items.length,
            "add(...)",
            span,
          );
          receiver.items.push(cloneCapturedSerializableValue(positional[0]!));
          return null;
        case "addAll": {
          expect();
          const other = positional[0]!;
          if (!isList(other))
            throw fault(
              "TSR060",
              `addAll() needs a list, not ${describeRuntimeValue(other)}.${isSet(other) ? " Copy a set into a list with toList() first." : isRange(other) ? RANGE_LIST_FIX : ""}`,
              span,
            );
          // Every element is checked before any is added, and copies are taken first, so a list can add itself.
          if (added !== null)
            for (const item of other.items) assertValueType(item, added.check, added.span);
          checkCollectionLength(
            "list",
            receiver.items.length + other.items.length,
            Math.max(receiver.items.length, other.items.length),
            "addAll(...)",
            span,
          );
          const items = other.items.map((item) => cloneCapturedSerializableValue(item));
          for (const item of items) receiver.items.push(item);
          return null;
        }
        case "remove": {
          expect();
          const index = this.#findValue(receiver.items, positional[0]!);
          if (index >= 0) this.#removeListItem(receiver, index);
          else {
            this.#warn(
              "TSW002",
              "remove(...) found no matching value, so the list is unchanged.",
              span,
            );
          }
          return null;
        }
        case "removeAt": {
          expect();
          const index = this.#listPosition(
            receiver,
            receiverPlan,
            null,
            positional[0]!,
            "remove",
            span,
          );
          return this.#removeListItem(receiver, index);
        }
        case "removeFirst":
        case "removeLast":
          expect();
          if (receiver.items.length === 0)
            throw fault(
              "TSR018",
              `Cannot call ${name}() on an empty list. Check that the list's length is above 0 first.`,
              span,
            );
          return this.#removeListItem(
            receiver,
            name === "removeFirst" ? 0 : receiver.items.length - 1,
          );
        case "clear":
          expect();
          if (receiver.items.length > 0) {
            freezePreparedReferenceDescendants(this.snapshot, receiver);
            receiver.items.length = 0;
          }
          return null;
        case "contains":
          expect();
          return this.#findValue(receiver.items, positional[0]!) >= 0;
        // A value that no element equals has no position: null (#840).
        case "indexOf":
        case "lastIndexOf": {
          expect();
          const index = this.#findValue(receiver.items, positional[0]!, name === "lastIndexOf");
          return index < 0 ? null : index;
        }
        case "count": {
          expect();
          let count = 0;
          for (const item of receiver.items)
            if (serializableEquals(item, positional[0]!)) count += 1;
          return count;
        }
        // A value that is not a position of the list, such as a negative or fractional index, text, or null, gives the
        // default (#844).
        case "get": {
          const problem = getArgumentsProblem("list", positional.length, [
            ...Object.keys(named),
            ...(defaulted ? ["default"] : []),
          ]);
          if (problem !== undefined) throw fault("TSR028", problem.message, span);
          const index = positional[0]!;
          return typeof index === "number" &&
            Number.isInteger(index) &&
            index >= 0 &&
            index < receiver.items.length
            ? receiver.items[index]!
            : USE_DEFAULT;
        }
        case "toSet":
          expect();
          return createCapturedSerializableSet(receiver.items);
        case "take":
        case "takeLast": {
          expect();
          const count = positional[0]!;
          if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
            throw fault(
              "TSR057",
              `${name}() needs a whole number of at least 0, not ${typeof count === "number" ? count : describeRuntimeValue(count)}.`,
              span,
            );
          // A count beyond the length takes the whole list.
          return createCapturedSerializableList(
            name === "take"
              ? receiver.items.slice(0, count)
              : receiver.items.slice(Math.max(0, receiver.items.length - count)),
          );
        }
        case "sort":
        case "shuffle":
          expect();
          this.#reorderList(
            receiver,
            name === "sort" ? sortOrder(receiver.items, span) : this.#shuffleOrder(receiver, span),
          );
          return null;
        // The last element first: the old indexes from the end.
        case "reverse":
          expect();
          this.#reorderList(
            receiver,
            receiver.items.map((_, index) => receiver.items.length - 1 - index),
          );
          return null;
        case "intersection":
        case "union":
        case "difference": {
          expect();
          const argument = this.#setOperationArgument(name, positional[0]!, span);
          const items = setOperationItems(name, receiver.items, argument);
          checkCollectionLength(
            "list",
            items.length,
            Math.max(receiver.items.length, argument.length),
            `${name}(...)`,
            span,
          );
          return createCapturedSerializableList(items);
        }
        case "join": {
          checkTextArguments(LIST_JOIN, positional, span);
          // EVIDENCE: invariant: checkTextArguments proved that a given separator is text.
          const separator = (positional[0] as string | undefined) ?? ", ";
          let length = separator.length * Math.max(0, receiver.items.length - 1);
          const texts = receiver.items.map((item) => {
            const text = this.#joinedText(item, span);
            length += text.length;
            return text;
          });
          checkTextLength(length, "join", span);
          return texts.join(separator);
        }
        default:
          throw fault("TSR016", noCollectionMethod(receiver, name), span);
      }
    } catch (error) {
      if (error instanceof RuntimeFault) throw error;
      throw this.#translateValueError(error, span);
    }
  }

  /** `contains`, `remove`, `clear`, and `get` of a dict, each with a text key except `clear`. */
  #callDict(
    receiver: SerializableRuntimeDict,
    expression: Extract<ExpressionPlan, { kind: "call" }>,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    defaulted: boolean,
  ): SerializableRuntimeValue | typeof USE_DEFAULT {
    // EVIDENCE: invariant: #call dispatches here only for a property callee.
    const callee = expression.callee as Extract<ExpressionPlan, { kind: "property" }>;
    const name = callee.name;
    const span = expression.span;
    if (!DICT_METHODS.has(name)) throw fault("TSR016", noCollectionMethod(receiver, name), span);
    const problem = dictArgumentsProblem(name, positional.length, [
      ...Object.keys(named),
      ...(defaulted ? ["default"] : []),
    ]);
    if (problem !== undefined) throw fault("TSR028", problem.message, span);
    if (name === "clear") {
      if (receiver.entries.length > 0) {
        freezePreparedReferenceDescendants(this.snapshot, receiver);
        clearSerializableDict(receiver);
      }
      return null;
    }
    const keyPlan = expression.arguments[0]!.value;
    const key = this.#dictKey(positional[0]!, keyPlan.span);
    switch (name) {
      case "contains":
        return getSerializableDictEntry(receiver, key) !== undefined;
      case "get": {
        // A stored null is a value, so only a missing entry gives the default.
        const entry = getSerializableDictEntry(receiver, key);
        return entry === undefined ? USE_DEFAULT : entry.value;
      }
      default: {
        if (getSerializableDictEntry(receiver, key) === undefined)
          throw missingKey(key, this.#receiverLabel(callee.object), keyPlan, span, this.plan);
        freezePreparedReferenceDescendants(this.snapshot, receiver, key);
        return removeSerializableDictEntry(receiver, key)!.value;
      }
    }
  }

  /** `button.remove()` removes a shown button and its queued click; removing it again does nothing (#836). */
  #callPermanentButton(
    button: SerializablePermanentButtonHandle,
    name: string,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    span: SourceSpan,
  ): null {
    if (name !== "remove") throw fault("TSR016", removableHandleMethodMessage(button, name), span);
    const problem = argumentShapeProblem(name, NO_ARGUMENTS, positional.length, Object.keys(named));
    if (problem !== undefined) throw fault("TSR028", problem.message, span);
    removePermanentButtons(
      this.snapshot,
      (shown) => shown.button.buttonId === button.buttonId,
      span,
      this.events,
    );
    return null;
  }

  #timer(handle: SerializableTimerHandle, span: SourceSpan): TimerHandleRecord {
    const timer = timerRecord(this.snapshot, handle.timerId);
    if (timer === undefined)
      throw fault(
        "TSR053",
        internalFault("A timer handle refers to a timer that the session does not have."),
        span,
      );
    return timer;
  }

  /** `pause()`, `resume()`, and `stop()`; repeated calls in the reached state are silent no-ops. */
  #callTimer(
    handle: SerializableTimerHandle,
    name: string,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    span: SourceSpan,
  ): null {
    if (!["pause", "resume", "stop"].includes(name)) {
      throw fault("TSR016", handleMemberMessage("timer", name, "call"), span);
    }
    const problem = argumentShapeProblem(name, NO_ARGUMENTS, positional.length, Object.keys(named));
    if (problem !== undefined) throw fault("TSR028", problem.message, span);
    const timer = this.#timer(handle, span);
    const action = activeTimerAction(this.snapshot, handle.timerId);
    const now = this.snapshot.currentSessionTimeMs;
    if (name === "stop") {
      if (action !== undefined) stopTimerAction(this.snapshot, action, span, this.events);
      return null;
    }
    if (name === "resume" && timer.state === "paused") {
      assertRepresentableRound(now, timer.remainingMs!, timer.repeat, span);
    }
    const warning = name === "pause" ? pauseTimer(timer, now) : resumeTimer(timer, now);
    if (warning !== null) this.#warn(warning.code, warning.message, span);
    // A round that is already due while its expiry work waits behind a block ends now, like `remaining = 0`.
    if (action !== undefined && timer.state === "paused" && timer.remainingMs === 0) {
      expireTimerAction(this.snapshot, action, now, span, this.events, this.trace, this.control);
    }
    return null;
  }

  /** Assignment to `remaining`, `display`, or `repeatDuration` of a timer handle. */
  #assignTimerProperty(
    handle: SerializableTimerHandle,
    name: string,
    value: SerializableRuntimeValue,
    span: SourceSpan,
  ): void {
    const timer = this.#timer(handle, span);
    const now = this.snapshot.currentSessionTimeMs;
    let warning: TimerWarning | "expired" | null;
    if (name === "display") {
      warning = setTimerDisplay(timer, timerDisplayValue(value, span));
    } else if (name === "remaining" || name === "repeatDuration") {
      if (!isAnyDuration(value)) {
        throw fault(
          "TSR050",
          `Timer ${name} must be a duration such as '10 s', but this is ${describeShownValue(value)}.`,
          span,
        );
      }
      exactDurationMilliseconds(value, `Timer ${name}`, span);
      if (name === "remaining") {
        if (timer.state === "running" || timer.state === "paused") {
          assertRepresentableRound(now, Math.max(0, value.milliseconds), timer.repeat, span);
        }
        warning = setTimerRemaining(timer, value.milliseconds, now);
      } else {
        if (
          !(value.milliseconds > 0) ||
          !isValidSessionTime(now + value.milliseconds) ||
          now + value.milliseconds <= now
        ) {
          throw fault(
            "TSR050",
            `Timer repeatDuration must be longer than zero and short enough for scene time to reach, but this is ${describeShownValue(value)}.`,
            span,
          );
        }
        warning = setTimerRepeatDuration(timer, value.milliseconds, now);
      }
    } else {
      throw fault("TSR003", handleMemberMessage("timer", name, "assign"), span);
    }
    if (warning === "expired") {
      expireTimerAction(
        this.snapshot,
        activeTimerAction(this.snapshot, handle.timerId)!,
        now,
        span,
        this.events,
        this.trace,
        this.control,
      );
    } else if (warning !== null) {
      this.#warn(warning.code, warning.message, span);
    }
  }

  #media(handle: SerializableMediaHandle, span: SourceSpan): MediaHandleRecord {
    const media = mediaRecord(this.snapshot, handle.mediaId);
    if (media === undefined)
      throw fault(
        "TSR053",
        internalFault("A media handle refers to media that the session does not have."),
        span,
      );
    return media;
  }

  /** `pause()`, `resume()`, and `stop()`; repeated calls in the reached state are silent no-ops. */
  #callMedia(
    handle: SerializableMediaHandle,
    name: string,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    span: SourceSpan,
  ): null {
    if (!["pause", "resume", "stop"].includes(name)) {
      throw fault("TSR016", handleMemberMessage("media", name, "call"), span);
    }
    const problem = argumentShapeProblem(name, NO_ARGUMENTS, positional.length, Object.keys(named));
    if (problem !== undefined) throw fault("TSR028", problem.message, span);
    const media = this.#media(handle, span);
    const action = activeMediaAction(this.snapshot, handle.mediaId);
    if (name === "stop") {
      if (action !== undefined) stopMediaAction(null, this.snapshot, action, this.events, span);
      return null;
    }
    // Playback already reached by now is committed before its segment changes.
    if (action !== undefined) drainMediaEvents(null, this.snapshot, action, this.events, span);
    const now = this.snapshot.currentSessionTimeMs;
    this.#mediaWarning(name === "pause" ? pauseMedia(media, now) : resumeMedia(media, now), span);
    return null;
  }

  /** Assignment to `position`, `remaining`, or `volume` of a media handle. */
  #assignMediaProperty(
    handle: SerializableMediaHandle,
    name: string,
    value: SerializableRuntimeValue,
    span: SourceSpan,
  ): void {
    const media = this.#media(handle, span);
    if (name === "volume") {
      if (!isMediaVolume(value))
        throw fault("TSR050", mediaVolumeMessage(describeShownValue(value)), span);
      this.#mediaWarning(setMediaVolume(media, value), span);
      return;
    }
    if (name !== "position" && name !== "remaining") {
      throw fault("TSR003", handleMemberMessage("media", name, "assign"), span);
    }
    if (!isAnyDuration(value) || !Number.isFinite(value.milliseconds)) {
      throw fault(
        "TSR050",
        `Media ${name} must be a duration such as '10 s', but this is ${describeShownValue(value)}.`,
        span,
      );
    }
    exactDurationMilliseconds(value, `Media ${name}`, span);
    const action = activeMediaAction(this.snapshot, handle.mediaId);
    // Playback already reached by now is committed before the seek starts a new segment.
    if (action !== undefined) drainMediaEvents(null, this.snapshot, action, this.events, span);
    this.#mediaWarning(
      seekMedia(media, value.milliseconds, this.snapshot.currentSessionTimeMs, name),
      span,
    );
    // A seek to the end of the range completes the pass at once, like a timer's `remaining = 0`.
    if (action !== undefined) {
      drainMediaEvents(null, this.snapshot, action, this.events, span, true);
    }
  }

  /** The default camera's view, which snapshot validation guarantees once a camera view handle exists. */
  #cameraView(): NonNullable<RuntimeSnapshot["cameraView"]> {
    const view = this.snapshot.cameraView;
    if (view === null) throw new TypeError("A camera view handle outlived its camera view.");
    return view;
  }

  /** `view.placement = "window" | "stage"` moves a shown camera view; a hidden one stays hidden and only warns. */
  #assignCameraProperty(name: string, value: SerializableRuntimeValue, span: SourceSpan): void {
    if (name !== "placement")
      throw fault("TSR003", handleMemberMessage("camera", name, "assign"), span);
    if (!isCameraPlacement(value))
      throw fault("TSR050", cameraPlacementMessage(shownChoice(value)), span);
    const view = this.#cameraView();
    if (!view.shown) {
      this.#warn(
        "TSW010",
        "This camera view is hidden, so its placement does not change. Show it with showCamera first.",
        span,
      );
      return;
    }
    view.placement = value;
  }

  /** The index of a message handle's live record; snapshot validation keeps one for every handle the state holds. */
  #liveMessage(handle: SerializableMessageHandle, span: SourceSpan): number {
    const messages = this.snapshot.liveMessages;
    let low = 0;
    let high = messages.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const id = messages[middle]!.messageId;
      if (id === handle.messageId) return middle;
      if (id < handle.messageId) low = middle + 1;
      else high = middle - 1;
    }
    throw fault(
      "TSR053",
      internalFault("A message handle refers to a message that the session does not have."),
      span,
    );
  }

  /**
   * `message.remove()` takes the message out of the conversation, which an event tells; its record keeps its text,
   * marked removed. Removing it again does nothing, and no pacing starts (#836).
   */
  #callMessage(
    handle: SerializableMessageHandle,
    name: string,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    span: SourceSpan,
  ): null {
    if (name !== "remove") throw fault("TSR016", removableHandleMethodMessage(handle, name), span);
    const problem = argumentShapeProblem(name, NO_ARGUMENTS, positional.length, Object.keys(named));
    if (problem !== undefined) throw fault("TSR028", problem.message, span);
    const index = this.#liveMessage(handle, span);
    const record = this.snapshot.liveMessages[index]!;
    if (record.removed === true) return null;
    const sequence = takeSequence(this.snapshot);
    this.events.push(
      Object.freeze({
        kind: "messageRemoved",
        sequence,
        messageId: handle.messageId,
        span: copySpan(span),
      } satisfies MessageRemovedEvent),
    );
    this.snapshot.liveMessages[index] = { ...record, removed: true };
    this.trace?.messageRemoved(
      stateKey("message", handle.messageId),
      handle.messageId,
      record.sourceText,
      span,
      sequence,
    );
    return null;
  }

  /**
   * `message.text = …` gives the shown message new text in place, which an event tells; the same text again changes
   * nothing. Its speaker, presentation, and place in the conversation stay, and no pacing starts. A removed message
   * keeps the text it had, as a stopped timer keeps its state, and the write reports developer warning `TSW010`, whose
   * advice names `receiver` as written, or `line` for a receiver without a name.
   */
  #assignMessageProperty(
    handle: SerializableMessageHandle,
    name: string,
    value: SerializableRuntimeValue,
    span: SourceSpan,
    receiver: ExpressionPlan,
  ): void {
    if (name !== "text")
      throw fault("TSR003", handleMemberMessage("messageHandle", name, "assign"), span);
    if (typeof value !== "string")
      throw fault(
        "TSR050",
        `Message property 'text' must be text (string), but this is ${describeShownValue(value)}. Convert it with toString(...) first.`,
        span,
      );
    const index = this.#liveMessage(handle, span);
    const record = this.snapshot.liveMessages[index]!;
    if (record.removed === true) {
      const label = this.#receiverLabel(receiver) ?? "line";
      this.#warn(
        "TSW010",
        `This message was removed, so its text does not change. Show a new message with say instead. To keep a message you want to change later, empty it with '${label}.text = ""' instead of removing it.`,
        span,
      );
      return;
    }
    if (record.sourceText === value) return;
    const content = parseMessageMarkup(value);
    const sequence = takeSequence(this.snapshot);
    this.events.push(
      Object.freeze({
        kind: "messageUpdated",
        sequence,
        messageId: handle.messageId,
        content,
        text: content.visibleText,
        span: copySpan(span),
      } satisfies MessageUpdatedEvent),
    );
    this.snapshot.liveMessages[index] = { messageId: handle.messageId, sourceText: value };
    this.trace?.messageText(
      stateKey("message", handle.messageId),
      handle.messageId,
      value,
      span,
      sequence,
    );
  }

  #mediaWarning(warning: MediaWarning | null, span: SourceSpan): void {
    if (warning !== null) this.#warn(warning.code, warning.message, span);
  }

  /**
   * Whether a stored value fits the load's type, if it has one (V30 §25). A value that does not is ignored by this load,
   * with a warning, and stays stored.
   */
  #storedValueFits(
    key: string,
    value: SerializableRuntimeValue,
    type: TypePlan | null,
    span: SourceSpan,
  ): boolean {
    const warning = type === null ? null : storedValueMismatch(key, value, type);
    if (warning === null) return true;
    this.#warn("TSW016", warning, span);
    return false;
  }

  #warn(code: DeveloperWarningCode, message: string, span: SourceSpan): void {
    this.events.push(
      Object.freeze({
        kind: "developerWarning",
        sequence: takeSequence(this.snapshot),
        severity: "warning",
        code,
        message,
        span: copySpan(span),
      } satisfies DeveloperWarningEvent),
    );
  }

  #getCollectionProperty(
    value: SerializableRuntimeList | SerializableRuntimeSet,
    name: string,
    span: SourceSpan,
    collection: ExpressionPlan | null,
  ): SerializableRuntimeValue {
    if (name === "length") return value.items.length;
    if (value.items.length === 0 && (name === "first" || name === "last" || name === "random"))
      throw emptyCollection(name, value, this.#optionalLabel(collection), span);
    if (name === "first" || name === "last")
      return value.items[name === "first" ? 0 : value.items.length - 1]!;
    if (name === "random") return this.#randomItem(value.items, span, "collectionRandom");
    throw fault(
      "TSR017",
      `${isList(value) ? "Lists" : "Sets"} have no property '${name}'. Use length, first, last, or random.`,
      span,
    );
  }

  #getSpeakerProperty(
    speaker: RuntimeSpeakerSnapshot,
    name: string,
    span: SourceSpan,
  ): SerializableRuntimeValue {
    const property = speakerPropertyValue(
      (own) => speaker.properties.find((item) => item.name === own)?.value,
      name,
    );
    if (property === undefined)
      throw fault("TSR017", `Speaker '${speaker.identifier}' has no property '${name}'.`, span);
    return property;
  }

  #getObjectProperty(
    object: SerializableRuntimeObject,
    name: string,
    span: SourceSpan,
    plan: ExpressionPlan | null,
  ): SerializableRuntimeValue {
    const value = getSerializableProperty(object, name);
    if (value === undefined)
      throw fault(
        "TSR017",
        missingPropertyMessage(
          this.#optionalLabel(plan),
          name,
          object.properties.map((property) => property.name),
        ),
        span,
      );
    return value;
  }

  /** The images matching a tag query, in catalog order, or one of them drawn from the session random generator. */
  #tagQuery(
    query: TagQueryExpressionPlan,
    operands: readonly SerializableRuntimeValue[],
  ): SerializableRuntimeValue {
    const bounds = new Map<TagQueryStepPlan, number>();
    const lists = new Map<TagQueryStepPlan, readonly string[]>();
    let next = 0;
    for (const step of query.steps) {
      if (step.kind !== "tagCompare" && step.kind !== "tagList") continue;
      const value = operands[next]!;
      const span = query.operands[next++]!.span;
      if (step.kind === "tagCompare") bounds.set(step, this.#tagBound(value, span));
      else lists.set(step, tagNames(value, step.option, span));
    }
    const matches = (tags: ReadonlyMap<string, number | null>) =>
      evaluateTagSteps(query.steps, (step) => {
        if (step.kind === "tag") return tags.has(step.name);
        if (step.kind === "tagCompare")
          return compareTagValue(tags.get(step.name), step.operator, bounds.get(step)!);
        if (step.kind === "tagList") return passesTagList(step.option, lists.get(step)!, tags);
        return null;
      });
    const found: SerializableRuntimeValue[] = [];
    if (query.catalog === "scripts") {
      // The files that run something, those `from:` names, in path order, each as a reference to its top.
      const named =
        query.from === null
          ? null
          : new Set(
              isPathGlob(query.from)
                ? globMatches(
                    query.from,
                    this.plan.files.map((file) => file.path),
                  )
                : [query.from],
            );
      const paths: string[] = [];
      for (const file of this.plan.files) {
        if (
          file.tags !== null &&
          (named === null || named.has(file.path)) &&
          matches(imageTags(file))
        )
          paths.push(file.path);
      }
      // Plan files start with main.tease; picks and lists see path order, as for images.
      paths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      for (const path of paths) found.push({ kind: "script", path, label: null });
    } else {
      // The package images in path order, then the photos taken with tags in capture order.
      for (const image of this.plan.images) if (matches(imageTags(image))) found.push(image.path);
      for (const image of this.snapshot.capturedImages) {
        if (matches(imageTags(image))) found.push(image.reference);
      }
      // Tagged photos come from accepted captures.
      this.trace?.readState(stateKey("photos"), null, null, null, false);
    }
    if (query.select === "list") return { kind: "list", items: found };
    if (found.length === 0)
      throw fault(
        "TSR082",
        query.catalog === "scripts" ? "No file has these tags." : "No image has these tags.",
        query.span,
      );
    const picked = found[this.#drawIndex(query.span, "tagQuery", found)]!;
    this.trace?.randomResult(picked);
    return picked;
  }

  #tagBound(value: SerializableRuntimeValue, span: SourceSpan): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw fault(
        "TSR080",
        `A tag's number is compared with a number, but this is ${describeRuntimeValue(value)}.`,
        span,
      );
    }
    return value;
  }

  /**
   * One semantic draw for `operation`: `sample` turns the primitive draws it takes into the outcome, and a debug trace
   * records them as one record with the generator state around them. Every random operation of an expression draws
   * through here.
   */
  #draw<T>(
    span: SourceSpan,
    operation: RuntimeDebugRandomOperation,
    choices: number | null,
    range: SerializableRuntimeRange | null,
    sample: (draw: PrimitiveDraw) => T,
  ): T {
    const trace = this.trace;
    const before = trace === null && this.control === null ? null : this.#randomState();
    // A controlled run has no injected source, so the state before is the draw's ID.
    if (this.control !== null) this.#drawId = before!;
    let draws = 0;
    const outcome = sample(() => {
      draws += 1;
      return this.#drawRandom(span);
    });
    if (trace !== null && draws > 0)
      trace.random(operation, span, choices, range, before, this.#randomState(), draws);
    return outcome;
  }

  /**
   * The outcome a controlled draw takes after its natural sampling: the natural one, one the host chose, or none, when
   * the draw pauses.
   */
  #resolve(
    span: SourceSpan,
    operation: RuntimeDebugRandomOperation,
    natural: RandomNatural,
    support: () => RandomSupport,
  ): RandomNatural {
    return this.control!.resolve(
      this.snapshot.nextInstruction,
      span,
      operation,
      this.#drawId,
      natural,
      support,
    );
  }

  /** The index of one of the equally likely `candidates`. */
  #drawIndex(
    span: SourceSpan,
    operation: RuntimeDebugRandomOperation,
    candidates: readonly SerializableRuntimeValue[],
  ): number {
    const count = candidates.length;
    const index = this.#draw(span, operation, count, null, (draw) => sampleIndex(draw, count));
    if (this.control === null) return index;
    return outcomeIndex(
      this.#resolve(span, operation, { kind: "index", index }, () => ({
        kind: "candidates",
        candidates,
      })),
    );
  }

  /** The session generator's state, or `null` when the host injected the random source. */
  #randomState(): number | null {
    return this.capabilities.random === undefined ? this.snapshot.rng.state : null;
  }

  #drawRandom(span: SourceSpan): number {
    if (this.#startValue)
      throw fault(
        "TSR067",
        "A start value cannot select anything at random: it is set up at the start of the session, before the story runs.",
        span,
      );
    const random =
      this.capabilities.random === undefined
        ? nextXorShift32(this.snapshot.rng)
        : this.capabilities.random.next();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw fault(
        "TSR020",
        internalFault(
          `The random source returned ${typeof random === "number" ? String(random) : random === null ? "null" : `a value of type ${typeof random}`}, but it must return a number that is at least 0 and less than 1.`,
        ),
        span,
      );
    }
    return random;
  }

  #randomBuiltin(call: RuntimeCapabilityCall): number {
    this.#expectBuiltinArguments("random", call);
    let random = this.#draw(call.span, "random", null, null, (draw) => draw());
    if (this.control !== null)
      random = outcomeNumber(
        this.#resolve(call.span, "random", { kind: "number", value: random }, () => ({
          kind: "unit",
        })),
      );
    this.trace?.randomResult(random);
    return random;
  }

  #chanceBuiltin(call: RuntimeCapabilityCall): boolean {
    this.#expectBuiltinArguments("chance", call);
    const percent = percentage("chance", call.positional[0]!, call.span);
    let chosen = this.#draw(call.span, "chance", null, null, (draw) => sampleChance(draw, percent));
    if (this.control !== null)
      chosen = outcomeBoolean(
        this.#resolve(call.span, "chance", { kind: "boolean", value: chosen }, () => ({
          kind: "chance",
          percent,
        })),
      );
    this.trace?.randomResult(chosen);
    return chosen;
  }

  #randomIntegerBuiltin(call: RuntimeCapabilityCall): number {
    this.#expectBuiltinArguments("randomInteger", call);
    const range = call.positional[0]!;
    if (!isRange(range)) {
      throw fault(
        "TSR040",
        `randomInteger(range) needs a range such as '1..=6', but this is ${describeShownValue(range)}.`,
        call.span,
      );
    }
    return this.randomIntegerInRange(range, call.span, "randomInteger(range)", "randomInteger");
  }

  /** Draws one whole number from a non-empty integer range with the session RNG. */
  public randomIntegerInRange(
    range: SerializableRuntimeRange,
    span: SourceSpan,
    subject: string,
    operation: RuntimeDebugRandomOperation,
  ): number {
    assertIntegerRange(range, subject, span);
    const empty = emptyRangeProblem(subject, range);
    if (empty !== null) throw fault("TSR041", empty, span);
    const length = rangeLength(range);
    let drawn = this.#draw(span, operation, length, range, (draw) =>
      sampleRangeInteger(draw, range, length),
    );
    if (this.control !== null)
      drawn = outcomeNumber(
        this.#resolve(span, operation, { kind: "number", value: drawn }, () => ({
          kind: "integer",
          min: range.start,
          max: range.start + length - 1,
        })),
      );
    this.trace?.randomResult(drawn);
    return drawn;
  }

  /**
   * A conversion (see `CONVERSIONS`), run by its `CONVERSION_RUNS` entry: its result, or for a value it cannot use
   * `USE_DEFAULT` when the call has a `default:`, which `named` leaves out (`defaulted`), and otherwise a failure that
   * names the fix.
   */
  #conversion(
    name: ConversionName,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    defaulted: boolean,
    argument: ExpressionPlan | undefined,
    span: SourceSpan,
  ): SerializableRuntimeValue | typeof USE_DEFAULT {
    const conversion: Conversion = CONVERSIONS[name];
    // Only a call with a written `files: false` is an ordinary call; with files it is a file store.
    if (conversion.files && named.files !== undefined && named.files !== false)
      throw fault(
        "TSR028",
        internalFault(`${name}(...) with files reached an ordinary call instead of a file store.`),
        span,
      );
    const pair = positional.length === 2 ? conversion.pair : undefined;
    if (
      (positional.length !== 1 && pair === undefined) ||
      Object.keys(named).some((key) => !conversion.files || key !== "files") ||
      (conversion.fallback !== null && conversion.fallback.required !== null && !defaulted)
    )
      throw fault("TSR028", callShapeFailure(name, conversion), span);
    const converted = CONVERSION_RUNS[name](positional, {
      span,
      text: (value) => visibleText(value, span, currentTemporalContext(this.snapshot)),
      speakerProperties: (speaker) => this.speakerById(speaker.speakerId, span).properties,
    });
    if (converted !== undefined) return converted;
    if (defaulted) return USE_DEFAULT;
    // A conversion of a value fails; any other conversion gives its default or fails as it runs.
    if (conversion.takes !== "value")
      throw fault(
        "TSR028",
        internalFault(`${name}(...) gave no result and has no default:.`),
        span,
      );
    if (pair !== undefined)
      throw fault(
        "TSR058",
        `${name}(${pair.join(", ")}) combines a ${pair[0]} and a ${pair[1]}, not ${describeRuntimeValue(positional[0]!)} and ${describeRuntimeValue(positional[1]!)}.`,
        span,
      );
    throw fault(
      "TSR058",
      conversionFailure(name, conversion, positional[0]!, argument, this.plan),
      span,
    );
  }

  /**
   * `min` or `max` of two or more values that are all numbers, all durations, all angles, or all date or time values of
   * one kind.
   */
  #minMaxBuiltin(
    name: string,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    span: SourceSpan,
  ): SerializableRuntimeValue {
    // One list, optionally with by:, chooses among its values (V30 §16), as the compiler checks one argument that may be
    // a list.
    const list = positional.length === 1;
    const names = Object.keys(named);
    const problem = list
      ? argumentShapeProblem(name, LIST_FUNCTION_SHAPES.get(name)!, 1, names)?.message
      : names.length > 0
        ? unknownNamedArgumentMessage(name, names[0]!, [])
        : positional.length < 2
          ? argumentCountMessage(name, MIN_MAX_TAKES, positional.length)
          : undefined;
    if (problem !== undefined) throw fault("TSR028", problem, span);
    if (list) {
      const values = listValues(name, positional[0]!, named.by, span);
      if (values.length === 0)
        throw fault(
          "TSR018",
          `${name}(...) of an empty list has no result. Check that the list's length is above 0 first.`,
          span,
        );
      positional = values;
    }
    const numbers = positional.every((value) => typeof value === "number");
    const first = positional[0]!;
    const temporals = positional.filter(
      (value): value is SerializableRuntimeTemporal =>
        isTemporal(value) && isTemporal(first) && value.kind === first.kind,
    );
    const durations = positional.every(isDuration) || positional.every(isCalendarDuration);
    const angles = positional.every(isAngle);
    if (!numbers && !durations && !angles && temporals.length !== positional.length) {
      const other = positional.find(
        (value) =>
          typeof value !== "number" &&
          !isAnyDuration(value) &&
          !isAngle(value) &&
          !isTemporal(value),
      );
      throw fault(
        "TSR059",
        other === undefined
          ? `${name}(...) needs values of one kind: all numbers, all durations, all calendar durations, all angles, or all dates, times, datetimes, or absolute dates and times.`
          : `${name}(...) needs numbers, durations, angles, or date and time values, not ${describeRuntimeValue(other)}.`,
        span,
      );
    }
    if (angles) {
      const values = positional.filter(isAngle);
      let best = values[0]!;
      for (const candidate of values) {
        const order = compareAngles(candidate, best);
        if (name === "min" ? order < 0 : order > 0) best = candidate;
      }
      return { ...best };
    }
    if (temporals.length === positional.length) {
      let best = temporals[0]!;
      for (const candidate of temporals) {
        const order = compareTemporal(candidate, best);
        if (name === "min" ? order < 0 : order > 0) best = candidate;
      }
      return cloneSerializableValue(best);
    }
    // A loop, not a spread into Math.min/Math.max, so a call with very many arguments cannot overflow the native stack.
    if (numbers) {
      const values = positional.filter((item): item is number => typeof item === "number");
      let best = values[0]!;
      for (const candidate of values)
        if (name === "min" ? candidate < best : candidate > best) best = candidate;
      return withoutNegativeZero(best);
    }
    // Calendar durations order only within one family (ADR 0026), also those that do not win; zero belongs to every
    // family. The result keeps its own parts.
    const values = positional.filter(isAnyDuration);
    const families = new Set(values.map((item) => durationFamily(durationParts(item))));
    families.delete("zero");
    if (values.some(isCalendar) && (families.size > 1 || families.has("mixed")))
      throw fault(
        "TSR059",
        `${name}(...) compares calendar durations of one kind only: months, days, or exact time.`,
        span,
      );
    let best = values[0]!;
    for (const candidate of values) {
      const order = compareDurations(candidate, best);
      if (typeof order === "string")
        throw fault("TSR059", `${name}(...) cannot compare these durations: ${order}.`, span);
      if (name === "min" ? order < 0 : order > 0) best = candidate;
    }
    return cloneSerializableValue(best);
  }

  /** One key of a dict, or element of a list, chosen with one draw, with the chance of its share of the weight. */
  #randomWeighted(
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    span: SourceSpan,
  ): SerializableRuntimeValue {
    const { choices, weights } = weightedChoices(positional, named, span);
    let index = this.#draw(span, "randomWeighted", choices.length, null, (draw) =>
      weightedIndex(weights, draw()),
    );
    if (this.control !== null)
      index = outcomeIndex(
        this.#resolve(span, "randomWeighted", { kind: "index", index }, () => ({
          kind: "weighted",
          candidates: choices,
          weights,
        })),
      );
    const chosen = cloneSerializableValue(choices[index]!);
    this.trace?.randomResult(chosen);
    return chosen;
  }

  /** A numeric function of numbers (V30 §13); a call without a result fails. */
  #numericFunction(
    name: string,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    span: SourceSpan,
  ): number {
    const { parameters, named: names = [], apply, random } = NUMERIC_FUNCTIONS.get(name)!;
    const problem = argumentShapeProblem(
      name,
      { ...positionalShape(parameters), names },
      positional.length,
      Object.keys(named),
    );
    if (problem !== undefined) throw fault("TSR028", problem.message, span);
    const number = (value: SerializableRuntimeValue, place: string): number => {
      if (typeof value === "number") return value;
      throw fault(
        "TSR059",
        `${name}(...) needs a number${place}, not ${describeRuntimeValue(value)}.${typeof value === "string" ? " Convert text with toNumber(...) first." : isAngle(value) ? " Convert it to a number of degrees with toDeg(...) first." : ""}`,
        span,
      );
    };
    const numbers = positional.map((value) => number(value, ""));
    const options = Object.fromEntries(
      Object.entries(named).map(([key, value]) => [key, number(value, ` as its ${key}:`)]),
    );
    const invalid = random?.(numbers);
    if (invalid !== undefined) throw fault(invalid.code, invalid.failure, span);
    // A trace records a random function's draws as one record, like a shuffle.
    // EVIDENCE: invariant: each random numeric function is named like its trace operation, such as randomNormal.
    const operation = name as RuntimeDebugRandomOperation;
    let result =
      random === undefined
        ? apply(numbers, options, NO_DRAWS)
        : this.#draw(span, operation, null, null, (draw) => apply(numbers, options, draw));
    if (random !== undefined && this.control !== null) {
      const resolved = this.#resolve(
        span,
        operation,
        typeof result === "number"
          ? { kind: "number", value: result }
          : { kind: "failure", code: result.code, message: result.failure },
        () => distributionSupport(name, numbers),
      );
      // A natural failure stays the draw's failure; a chosen outcome replaces it.
      if (resolved.kind !== "failure") result = outcomeNumber(resolved);
    }
    if (typeof result !== "number") throw fault(result.code, result.failure, span);
    if (random !== undefined) this.trace?.randomResult(result);
    return result;
  }

  #escapeMarkupBuiltin(call: RuntimeCapabilityCall): string {
    this.#expectBuiltinArguments("escapeMarkup", call);
    const text = call.positional[0]!;
    if (typeof text !== "string")
      throw fault(
        "TSR059",
        `escapeMarkup(...) needs text, not ${describeRuntimeValue(text)}.${text !== null && isVisibleScalar(text) ? " Convert it with toString(...) first." : isList(text) && text.items.every(isVisibleScalar) ? " Use .join() to combine its elements as text." : ""}`,
        call.span,
      );
    // Escaping puts a backslash before some characters, so only a text that could get too long is measured first.
    if (text.length * 2 > MAX_TEXT_LENGTH)
      checkTextLength(escapedMarkupLength(text), "escapeMarkup", call.span);
    return escapeMarkup(text);
  }

  #expectBuiltinArguments(name: string, call: RuntimeCapabilityCall): void {
    const parameters = FIXED_PARAMETERS.get(name)!;
    const problem = argumentShapeProblem(
      name,
      positionalShape(parameters),
      call.positional.length,
      Object.keys(call.named),
      parameters.length > 0,
    );
    if (problem !== undefined) throw fault("TSR028", problem.message, call.span);
  }

  /** Removes one list element, rebasing or freezing prepared references into the list, and returns it. */
  /** The items of a set operation's argument, which may be a list or a set whatever the receiver is. */
  #setOperationArgument(
    name: string,
    argument: SerializableRuntimeValue,
    span: SourceSpan,
  ): readonly SerializableRuntimeValue[] {
    if (!isList(argument) && !isSet(argument))
      throw fault("TSR060", setOperationArgumentMessage(name, argument), span);
    return argument.items;
  }

  /** A uniform random order of the list's items, as their old indexes; a trace records it as one record of its draws. */
  #shuffleOrder(list: SerializableRuntimeList, span: SourceSpan): readonly number[] {
    const length = list.items.length;
    const order = this.#draw(span, "shuffle", length, null, (draw) => sampleOrder(draw, length));
    // Fewer than two items draw nothing, so nothing pauses.
    if (this.control === null || length < 2) return order;
    return outcomeOrder(
      this.#resolve(span, "shuffle", { kind: "order", order }, () => ({
        kind: "order",
        items: list.items,
      })),
    );
  }

  /** Puts the items in `order` (old indexes), moving prepared references into items along with them. */
  #reorderList(list: SerializableRuntimeList, order: readonly number[]): void {
    const newIndexOf: number[] = [];
    for (const [index, old] of order.entries()) newIndexOf[old] = index;
    const rebased = preparePreparedReferencesForListReorder(this.snapshot, list, newIndexOf);
    const items = order.map((old) => list.items[old]!);
    for (const [index, item] of items.entries()) list.items[index] = item;
    refreshPreparedReferenceFallbacks(this.snapshot, rebased);
  }

  #removeListItem(list: SerializableRuntimeList, index: number): SerializableRuntimeValue {
    const rebased = preparePreparedReferencesForListRemoval(this.snapshot, list, index);
    const removed = list.items.splice(index, 1)[0]!;
    refreshPreparedReferenceFallbacks(this.snapshot, rebased);
    return removed;
  }

  /** The index of the first element equal to `value`, or with `last` of the last one; -1 when there is none. */
  #findValue(
    items: readonly SerializableRuntimeValue[],
    value: SerializableRuntimeValue,
    last = false,
  ): number {
    // A scalar equals only the same scalar, as strict equality compares it; runtime numbers are never NaN.
    if (value === null || typeof value !== "object")
      return last ? items.lastIndexOf(value) : items.indexOf(value);
    for (let step = 0; step < items.length; step += 1) {
      const index = last ? items.length - 1 - step : step;
      if (serializableEquals(items[index]!, value)) return index;
    }
    return -1;
  }

  #randomItem(
    items: readonly SerializableRuntimeValue[],
    span: SourceSpan,
    operation: RuntimeDebugRandomOperation,
  ): SerializableRuntimeValue {
    if (items.length === 0)
      throw fault(
        "TSR019",
        "Cannot select '.random' from an empty collection. Check its length first.",
        span,
      );
    const item = items[this.#drawIndex(span, operation, items)]!;
    this.trace?.randomResult(item);
    return item;
  }

  /** `name` of `value`, which `object` gives where the plan has it, to name it in a failure. */
  #getProperty(
    value: SerializableRuntimeValue,
    name: string,
    span: SourceSpan,
    object: ExpressionPlan | null = null,
  ): SerializableRuntimeValue {
    if (isObject(value)) return this.#getObjectProperty(value, name, span, object);
    if (isSpeakerReference(value)) {
      const speaker = this.speakerById(value.speakerId, span);
      // A value that a speaker reads through another property, such as a term its gender gives, comes from that one.
      if (this.trace !== null)
        this.#readState(
          value,
          speakerPropertySource(
            (own) => speaker.properties.some((property) => property.name === own),
            name,
          ),
        );
      return this.#getSpeakerProperty(speaker, name, span);
    }
    if (this.trace !== null) this.#readState(value, name);
    if (isList(value) || isSet(value))
      return this.#getCollectionProperty(value, name, span, object);
    if (typeof value === "string") {
      if (name === "length") return stringLength(value);
      throw fault("TSR017", unknownTextMemberMessage(name, "property"), span);
    }
    if (isDict(value)) {
      const property = dictProperty(value, name);
      if (property === undefined)
        throw fault(
          "TSR017",
          `Dicts have no property '${name}'. Use length, keys, or values. To read a value by its key, write '${this.#optionalLabel(object) ?? "dict"}[${JSON.stringify(name)}]'.`,
          span,
        );
      return property;
    }
    if (isCameraView(value)) {
      if (name !== "placement")
        throw fault("TSR017", handleMemberMessage("camera", name, "read"), span);
      return this.#cameraView().placement;
    }
    if (isMediaHandle(value)) {
      const property = mediaProperty(
        this.#media(value, span),
        name,
        this.snapshot.currentSessionTimeMs,
      );
      if (property === undefined)
        throw fault("TSR017", handleMemberMessage("media", name, "read"), span);
      return property;
    }
    if (isCalendarDuration(value)) {
      const property = calendarDurationProperty(value, name);
      if (property === undefined)
        throw fault(
          "TSR017",
          `A calendar duration has no property '${name}'. Use months, days, or exactOffset.`,
          span,
        );
      return property;
    }
    if (isDuration(value)) throw fault("TSR017", durationPropertyMessage(name), span);
    if (isAngle(value)) throw fault("TSR017", anglePropertyMessage(name), span);
    if (isTemporal(value)) {
      const property = temporalProperty(value, name);
      if (property === undefined)
        throw fault(
          "TSR017",
          value.kind === "absoluteDateTime"
            ? `An absolute date and time has no property '${name}'. Convert it with toDateTime() to read local fields.`
            : `This ${value.kind} has no property '${name}'.`,
          span,
        );
      return property;
    }
    if (isTimerHandle(value)) {
      const property = timerProperty(
        this.#timer(value, span),
        name,
        this.snapshot.currentSessionTimeMs,
      );
      if (property === undefined)
        throw fault("TSR017", handleMemberMessage("timer", name, "read"), span);
      return property;
    }
    if (isMessageHandle(value)) {
      if (name !== "text")
        throw fault("TSR017", handleMemberMessage("messageHandle", name, "read"), span);
      return this.snapshot.liveMessages[this.#liveMessage(value, span)]!.sourceText;
    }
    throw fault("TSR017", missingMemberMessage(value, name, "property"), span);
  }

  /** Only lists and dicts are indexed. */
  #assertIndexable(value: SerializableRuntimeValue, plan: ExpressionPlan, span: SourceSpan): void {
    if (isSet(value)) throw this.#notIndexable("TSR004", plan, value, span);
    if (!isList(value) && !isDict(value)) throw this.#notIndexable("TSR008", plan, value, span);
  }

  #dictKey(value: SerializableRuntimeValue, span: SourceSpan): string {
    if (typeof value !== "string")
      throw fault(
        "TSR062",
        `A dict key is text (string), but this is ${describeTypedValue(value)}.${typeof value === "number" ? ' Write a number key as text, as in "${id}".' : ""}`,
        span,
      );
    return value;
  }

  /** The value of `dict[key]`; a missing key is an error that names the check. */
  #dictValue(
    dict: SerializableRuntimeDict,
    key: string,
    expression: Extract<ExpressionPlan, { kind: "index" }>,
  ): SerializableRuntimeValue {
    const entry = getSerializableDictEntry(dict, key);
    if (entry === undefined)
      throw missingKey(
        key,
        this.#receiverLabel(expression.object),
        expression.index,
        expression.span,
        this.plan,
      );
    return entry.value;
  }

  /** How the source spells the value `plan` gives, where there is a plan, or `null`. */
  #optionalLabel(plan: ExpressionPlan | null): string | null {
    return plan === null ? null : this.#receiverLabel(plan);
  }

  /** How the source spells a dict receiver, also one prepared before the rest of its statement, or `null`. */
  #receiverLabel(plan: ExpressionPlan): string | null {
    if (plan.kind !== "preparedReference") return planLabel(plan, this.plan);
    const descriptor = readPreparedReference(
      readTemporary(this.snapshot.temporaries, plan.temporaryId, plan.span),
      plan.span,
    );
    const names: string[] = [];
    for (const step of descriptor.path) {
      if (step.kind !== "property") return null;
      names.push(step.name);
    }
    return descriptor.rootName === null ? null : [descriptor.rootName, ...names].join(".");
  }

  /**
   * The position `value` gives in `list`, which `receiver` gives: `TSR024` unless it is a whole number and `TSR025` unless
   * the list has it. `indexPlan` is the index as written, or `null` for an argument such as of `removeAt(...)`.
   */
  #listPosition(
    list: SerializableRuntimeList,
    receiver: ExpressionPlan,
    indexPlan: ExpressionPlan | null,
    value: SerializableRuntimeValue,
    use: "read" | "assign" | "remove",
    span: SourceSpan = indexPlan!.span,
  ): number {
    const whole = typeof value === "number" && Number.isInteger(value);
    if (whole && value >= 0 && value < list.items.length) return value;
    // A label is only written for the failure.
    const index = indexPlan === null ? null : loweredOperand(this.plan, indexPlan);
    const indexLabel =
      index === null
        ? null
        : index.kind === "literal"
          ? typeof index.value === "number"
            ? String(index.value)
            : null
          : planLabel(index, this.plan);
    if (!whole) {
      const subject = indexLabel === null ? "this" : `'${indexLabel}'`;
      const fix =
        typeof value === "number"
          ? " Round it with floor(...), round(...), or ceil(...) first."
          : value === null
            ? ` Check that ${indexLabel === null ? "the index" : `'${indexLabel}'`} is not null first.`
            : typeof value === "string" && numberFromText(value) !== undefined
              ? " Convert the text with toInteger(...) first."
              : "";
      throw fault(
        "TSR024",
        `A list index must be a whole number (integer), but ${subject} is ${describeShownValue(value)}.${fix}`,
        span,
      );
    }
    const length = list.items.length;
    const owner = this.#receiverLabel(receiver);
    const named = owner === null ? "the list" : `'${owner}'`;
    const action = `Cannot ${use === "assign" ? "assign to" : use} ${owner === null || indexLabel === null ? `index ${value}` : `'${owner}[${indexLabel}]'`}`;
    const given =
      owner === null || indexLabel === null || indexLabel === String(value)
        ? ""
        : `'${indexLabel}' is ${value}, and `;
    throw fault(
      "TSR025",
      length === 0
        ? `${action}: ${given}${named} is empty. Check ${owner === null ? "its length" : `'${owner}.length'`} first.`
        : `${action}: ${given}${named} has ${length === 1 ? "1 element, so its only index is 0" : `${length} elements, so its indexes run from 0 through ${length - 1}`}. Check the index against ${owner === null ? "the list's length" : `'${owner}.length'`} first.`,
      span,
    );
  }

  /** `TSR004` for a set, and `code` for any other value, which `plan` gives, that is not a list or dict to index. */
  #notIndexable(
    code: "TSR004" | "TSR005" | "TSR008",
    plan: ExpressionPlan,
    value: SerializableRuntimeValue,
    span: SourceSpan,
  ): RuntimeFault {
    const label = this.#receiverLabel(plan);
    const subject = label === null ? "this" : `'${label}'`;
    return isSet(value)
      ? fault(
          "TSR004",
          `Only a list or a dict can be indexed, but ${subject} is a set. Copy it into a list with toList() first.`,
          span,
        )
      : fault(
          code,
          `Only a list or a dict can be indexed, but ${subject} is ${describeShownValue(value)}.`,
          span,
        );
  }

  /** `TSR003` for a property assignment on a value, which `plan` gives, that has no properties to assign. */
  #noAssignableProperties(
    plan: ExpressionPlan,
    value: SerializableRuntimeValue,
    span: SourceSpan,
  ): RuntimeFault {
    const label = this.#receiverLabel(plan);
    return fault(
      "TSR003",
      `Only objects, speakers, camera views, and handles for timers, media, and messages have assignable properties, but ${label === null ? "this" : `'${label}'`} is ${describeShownValue(value)}.`,
      span,
    );
  }

  #translateValueError(error: unknown, span: SourceSpan): RuntimeFault {
    if (error instanceof SerializableValueError) {
      return fault("TSR031", internalFault(error.message), span);
    }
    throw error;
  }
}

const DICT_METHODS: ReadonlySet<string> = new Set(["contains", "remove", "clear", "get"]);

/** The support of a random distribution function's draw, from its checked arguments. */
function distributionSupport(name: string, numbers: readonly number[]): RandomSupport {
  if (name === "randomNormal") return { kind: "normal", mean: numbers[0]!, spread: numbers[1]! };
  if (name === "randomBeta") return { kind: "beta", alpha: numbers[0]!, beta: numbers[1]! };
  return { kind: "pert", min: numbers[0]!, mostLikely: numbers[1]!, max: numbers[2]! };
}

/*
 * A resolved draw has the kind of outcome its support admits: control checks every chosen outcome against the support
 * before it is used, and a natural one has its sampler's kind.
 */
function outcomeIndex(outcome: RandomNatural): number {
  if (outcome.kind !== "index")
    throw new Error("A random draw resolved to another kind of outcome.");
  return outcome.index;
}

function outcomeNumber(outcome: RandomNatural): number {
  if (outcome.kind !== "number")
    throw new Error("A random draw resolved to another kind of outcome.");
  return outcome.value;
}

function outcomeBoolean(outcome: RandomNatural): boolean {
  if (outcome.kind !== "boolean")
    throw new Error("A random draw resolved to another kind of outcome.");
  return outcome.value;
}

function outcomeOrder(outcome: RandomNatural): readonly number[] {
  if (outcome.kind !== "order")
    throw new Error("A random draw resolved to another kind of outcome.");
  return outcome.order;
}

/** The draws of a numeric function that is not random: it never takes one. */
const NO_DRAWS: PrimitiveDraw = () => {
  throw new Error("A numeric function that is not random drew a random number.");
};

/** List, set, and dict methods that change their receiver in place. */
const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "add",
  "addAll",
  "remove",
  "removeAt",
  "removeFirst",
  "removeLast",
  "clear",
  "sort",
  "shuffle",
  "reverse",
]);

const DICT_TEXT_MESSAGE =
  '"${...}" cannot show a dict. Select one value with dict[key], or show every value with dict.values.join().';

/**
 * The error for a key a dict does not have, with the check that avoids it, such as `Check toys.contains(name) first.`
 * The key is named as the source spells it where the plan still shows it, and otherwise by its text.
 */
function missingKey(
  key: string,
  owner: string | null,
  keyPlan: ExpressionPlan,
  span: SourceSpan,
  program: InstructionPlan,
): RuntimeFault {
  const shown = quotedText(messageText(key));
  const check = `contains(${planLabel(keyPlan, program) ?? shown})`;
  return fault(
    "TSR061",
    `Dictionary has no key ${shown}. Check ${owner === null ? `it with ${check}` : `${owner}.${check}`} first.`,
    span,
  );
}

/**
 * How the source spells an arithmetic operand: a variable, a property path, or a number, or `null` for anything else. An
 * operand that the lowering kept in a temporary is spelled as written.
 */
function operandLabel(plan: ExpressionPlan, program: InstructionPlan): string | null {
  let current = loweredOperand(program, plan);
  while (current.kind === "group") current = current.expression;
  if (current.kind === "literal")
    return typeof current.value === "number" ? String(current.value) : null;
  return planLabel(current, program);
}

/** How the source spells `left operator right`, when it spells both operands, or `null`. */
function binaryLabel(expression: BinaryExpressionPlan, program: InstructionPlan): string | null {
  const left = operandLabel(expression.left, program);
  const right = operandLabel(expression.right, program);
  return left === null || right === null ? null : `${left} ${expression.operator} ${right}`;
}

/** An operand of `expression` as a number, or `TSR027`, which names the operand where the source spells it. */
function operandNumber(
  expression: BinaryExpressionPlan,
  side: "left" | "right",
  value: SerializableRuntimeValue,
  program: InstructionPlan,
): number {
  if (typeof value === "number") return value;
  const label = binaryLabel(expression, program);
  throw notNumber(
    label === null ? `'${expression.operator}'` : `'${label}'`,
    operandLabel(expression[side], program),
    ` on its ${side} side`,
    value,
    expression[side].span,
  );
}

/** A bound of `range` as a number, or `TSR027` with the compiler's text (`rangeBoundRule`). */
function rangeBound(
  range: RangeExpressionPlan,
  bound: "start" | "end",
  value: SerializableRuntimeValue,
  program: InstructionPlan,
): number {
  if (typeof value === "number") return value;
  const start = operandLabel(range.start, program);
  const end = operandLabel(range.end, program);
  const rule = rangeBoundRule(start, end, range.inclusive, bound);
  throw fault(
    "TSR027",
    `${rule}, but this is ${describeShownValue(value)}. ${notNumberFix(bound === "start" ? start : end, notNumberKind(value))}`,
    range[bound].span,
  );
}

/** `TSR027`: `subject` needs a number for the operand the source spells `operand`, or else `place`, but got `value`. */
function notNumber(
  subject: string,
  operand: string | null,
  place: string,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): RuntimeFault {
  return fault(
    "TSR027",
    `${subject} needs a number${operand === null ? place : ` for '${operand}'`}, but received ${describeShownValue(value)}. ${notNumberFix(operand, notNumberKind(value))}`,
    span,
  );
}

/** What a value that is not a number is, for its fix (`notNumberFix`). */
function notNumberKind(value: SerializableRuntimeValue): "null" | "numeric text" | "other" {
  return value === null
    ? "null"
    : typeof value === "string" && numberFromText(value) !== undefined
      ? "numeric text"
      : "other";
}

/**
 * Why `value` does not convert, and what to do: a comparison for `toBoolean` of a number or text, `join()` for a
 * collection of shown values, and otherwise a `default:` fallback. The compiler gives the first part, `cannotConvert`,
 * for text it can see.
 */
function conversionFailure(
  name: ConversionName,
  conversion: ValueConversion,
  value: SerializableRuntimeValue,
  argument: ExpressionPlan | undefined,
  program: InstructionPlan,
): string {
  const label = (argument === undefined ? null : planLabel(argument, program)) ?? "value";
  const fallback = " Give a fallback with 'default:' if the value may not convert.";
  const shown = describeShownValue(value);
  // `toBoolean` keeps 1, 0, and other texts invalid: an explicit comparison says what the script means.
  if (conversion.result === "boolean" && typeof value !== "string")
    return typeof value === "number"
      ? `${name}(...) converts ${conversion.converts}, not the number ${shown}. Compare the number instead, such as '${label} != 0'.`
      : `${name}(...) converts ${conversion.converts}, not ${shown}.${fallback}`;
  const failed = cannotConvert(name, conversion, value);
  if (typeof value === "string" && conversion.result === "boolean")
    return `${failed} Compare the text instead, such as '${label} == ${quotedText(messageText(value))}'.`;
  if (conversion.kinds === "shown" && (isList(value) || isSet(value) || isDict(value))) {
    const items = isDict(value) ? value.entries.map((entry) => entry.value) : value.items;
    if (items.every(isVisibleScalar))
      return `${failed} Use ${isSet(value) ? ".toList().join()" : isDict(value) ? ".values.join()" : ".join()"} to combine its ${isDict(value) ? "values" : "elements"} as text.`;
  }
  return `${failed}${fallback}`;
}

/** What a conversion reads while it runs, besides its arguments. */
interface ConversionRun {
  readonly span: SourceSpan;
  /** A scalar as `${...}` shows it, dates and times in the player's presentation, which `toString` gives. */
  readonly text: (value: SerializableRuntimeValue) => string;
  /** A speaker's properties, which `toJson` writes. */
  readonly speakerProperties: (
    speaker: SerializableSpeakerReference,
  ) => readonly SerializableRuntimeProperty[];
}

/**
 * How each conversion runs (see `CONVERSIONS`): its result, or `undefined` for a value that it does not convert or text
 * that it does not read, for which the call gives its default or fails.
 */
const CONVERSION_RUNS: {
  readonly [Name in ConversionName]: (
    positional: readonly SerializableRuntimeValue[],
    run: ConversionRun,
  ) => SerializableRuntimeValue | undefined;
} = {
  toString: ([value], run) => (isVisibleScalar(value!) ? run.text(value!) : undefined),
  toNumber: ([value]) => numberOf(value!),
  toInteger: ([value]) => {
    const number = numberOf(value!);
    return number === undefined ? undefined : withoutNegativeZero(Math.trunc(number));
  },
  toBoolean: ([value]) =>
    typeof value === "boolean"
      ? value
      : typeof value === "string"
        ? booleanFromText(value)
        : undefined,
  toDate: ([value]) => temporalConverted("date", value!),
  toTime: ([value]) => temporalConverted("time", value!),
  // A date and a time combine into one date and time (V30 §35).
  toDateTime: ([value, time]) =>
    time === undefined ? temporalConverted("datetime", value!) : combinedDateAndTime(value!, time),
  toAbsoluteDateTime: ([value]) => temporalConverted("absoluteDateTime", value!),
  toRegex: ([text]) => regexFromText(text!),
  toJson: ([value], run) => jsonText(value!, run.speakerProperties, run.span),
  // JSON's null is a value; only text that does not read gives the default.
  fromJson: ([text], run) => (typeof text === "string" ? valueFromJson(text, run.span) : undefined),
  toBase64: ([text], run) => {
    if (typeof text !== "string")
      throw fault(
        "TSR059",
        `toBase64(...) ${CONVERSIONS.toBase64.does}, not ${describeRuntimeValue(text!)}.`,
        run.span,
      );
    return base64Text(text, run.span);
  },
  fromBase64: ([text]) => (typeof text === "string" ? textFromBase64(text) : undefined),
};

/** A number, or the number that number text holds (V30 §13), or `undefined` for any other value. */
function numberOf(value: SerializableRuntimeValue): number | undefined {
  return typeof value === "number"
    ? withoutNegativeZero(value)
    : typeof value === "string"
      ? numberFromText(value)
      : undefined;
}

/** How a call of `shape` is written, for a plan whose call is not (see `CallShape`). */
function callShapeFailure(name: string, shape: CallShape): string {
  if (shape.fallback === null)
    return `${name}(...) takes one ${shape.parameter} and no named arguments.`;
  return shape.fallback.required === null
    ? `${name}(...) takes one ${shape.parameter} and an optional default:, such as ${name}(${shape.parameter}, default: ...).`
    : `${name}(...) takes one ${shape.parameter} and a default:, such as ${name}(${shape.parameter}, default: null).`;
}

/** `hashText(text)` (V30 §13): the SHA-256 of the text's UTF-8 bytes. */
function hashedText(
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): string {
  if (positional.length !== 1 || Object.keys(named).length !== 0)
    throw fault(
      "TSR028",
      callShapeFailure("hashText", { parameter: "text", fallback: null, files: false }),
      span,
    );
  const text = positional[0]!;
  if (typeof text !== "string")
    throw fault(
      "TSR059",
      `hashText(...) hashes text (string), not ${describeRuntimeValue(text)}.`,
      span,
    );
  return textSha256(text);
}

/**
 * `TSR026`: `rule`, such as "A condition must be true or false (boolean)", with the value `plan` gave instead and, where
 * the source spells it, the compiler's fix.
 */
export function notBoolean(
  rule: string,
  plan: ExpressionPlan,
  value: SerializableRuntimeValue,
  span: SourceSpan,
  program: InstructionPlan,
): RuntimeFault {
  const source = loweredOperand(program, plan);
  const label = source.kind === "literal" ? null : planLabel(source, program);
  let fix = "";
  if (value === null || typeof value === "number" || typeof value === "string")
    fix = ` Compare it instead${label === null ? "" : `, such as '${label} ${value === null ? "== true" : typeof value === "number" ? "> 0" : '!= ""'}'`}.`;
  else if (isList(value) || isSet(value) || isDict(value))
    fix = ` Check its length instead${label === null ? "" : `, such as '${label}.length > 0'`}.`;
  return fault(
    "TSR026",
    `${rule}, but ${label === null ? "this" : `'${label}'`} is ${describeShownValue(value)}.${fix}`,
    span,
  );
}

/**
 * `TSR026` for an operand of `operator` that is not true or false. The lazy `and` and `or` and the lowered ones, which
 * keep their operands in a temporary, all report it here.
 */
export function notLogicalOperand(
  operator: "and" | "or" | null,
  plan: ExpressionPlan,
  value: SerializableRuntimeValue,
  program: InstructionPlan,
): RuntimeFault {
  return notBoolean(logicalOperandRule(operator), plan, value, plan.span, program);
}

/**
 * Why an arithmetic step has no finite result: a division or remainder by zero, or a number or duration too large. It
 * names the operands as the source spells them, where the plan still does, and shows their values.
 */
function noArithmeticResult(
  expression: BinaryExpressionPlan,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  program: InstructionPlan,
  code: RuntimeErrorCode = "TSR036",
): RuntimeFault {
  const { operator } = expression;
  const label = binaryLabel(expression, program);
  const values = `${operandText(left)} ${operator} ${operandText(right)}`;
  const subject = label === null ? values : `'${label}'`;
  if ((operator === "/" || operator === "%") && isZero(right)) {
    const divisor = operandLabel(expression.right, program);
    const zero = operandText(right);
    const cause = divisor === null ? "" : ` because '${divisor}' is ${zero}`;
    return fault(
      code,
      `${operator === "/" ? "Division" : "Remainder"} by zero: ${subject} has no result${cause}. Check that ${divisor === null ? "the divisor" : `'${divisor}'`} is not ${zero} first.`,
      expression.span,
    );
  }
  // A duration or an angle divided by one of its kind is a number, and any other step with one gives one of its kind.
  const what =
    operator === "/" &&
    ((isAnyDuration(left) && isAnyDuration(right)) || (isAngle(left) && isAngle(right)))
      ? "a number too large"
      : isAnyDuration(left) || isAnyDuration(right)
        ? "a duration too long"
        : isAngle(left) || isAngle(right)
          ? "an angle too large"
          : "a number too large";
  return fault(
    code,
    `${label === null ? values : `${subject} is ${values}, which`} gives ${what} to represent. Use smaller values.`,
    expression.span,
  );
}

/** The message for a method that a message handle or a permanent button does not have: each has only `remove()`. */
function removableHandleMethodMessage(
  handle: SerializableMessageHandle | SerializablePermanentButtonHandle,
  method: string,
): string {
  return isMessageHandle(handle)
    ? handleMemberMessage("messageHandle", method, "call")
    : `Permanent buttons have no method '${method}'. Use remove().`;
}

/** An operand's kind, with the value of a number, duration, or angle, such as `a duration (1 s)`. */
function kindAndValue(value: SerializableRuntimeValue): string {
  return typeof value === "number" || isAnyDuration(value) || isAngle(value)
    ? `${describeRuntimeValue(value)} (${operandText(value)})`
    : describeRuntimeValue(value);
}

/** A number, duration, or angle operand as a message shows it. */
function operandText(value: SerializableRuntimeValue): string {
  if (typeof value === "number") return String(withoutNegativeZero(value));
  if (isAngle(value)) return formatAngle(value);
  return isAnyDuration(value) ? formatDuration(value) : describeRuntimeValue(value);
}

function isZero(value: SerializableRuntimeValue): boolean {
  return (
    value === 0 ||
    (isAnyDuration(value) && durationFamily(durationParts(value)) === "zero") ||
    (isAngle(value) && value.degrees === 0)
  );
}

/**
 * Angle arithmetic and comparison (V30 §13): angles add, subtract, and compare by size, divide into a number, and
 * multiply or divide by a number. Any other operand or operator is an error that names what works.
 */
function angleBinary(
  expression: BinaryExpressionPlan,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  program: InstructionPlan,
): SerializableRuntimeValue {
  const operator = expression.operator;
  const compares = ["<", "<=", ">", ">="].includes(operator);
  if (compares && isAngle(left) && isAngle(right)) {
    const order = compareAngles(left, right);
    if (operator === "<") return order < 0;
    if (operator === "<=") return order <= 0;
    if (operator === ">") return order > 0;
    return order >= 0;
  }
  const operand = (value: SerializableRuntimeValue): number | StoredAngle | undefined =>
    typeof value === "number" || isAngle(value) ? value : undefined;
  const a = operand(left);
  const b = operand(right);
  const result = a === undefined || b === undefined ? undefined : angleArithmetic(operator, a, b);
  if (result !== undefined) {
    if (!Number.isFinite(typeof result === "number" ? result : result.degrees))
      throw noArithmeticResult(expression, left, right, program);
    return result;
  }
  throw fault(
    "TSR009",
    compares
      ? `'${operator}' cannot compare ${kindAndValue(left)} with ${kindAndValue(right)}. Use an angle on both sides.`
      : `'${operator}' cannot combine ${kindAndValue(left)} and ${kindAndValue(right)}. ${ANGLE_ARITHMETIC_ROUTE}`,
    expression.span,
  );
}

/** A call of an angle function (V30 §13), whose arguments must be of the kinds it takes. */
function angleFunction(
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): number | StoredAngle {
  const { parameters, takes, apply } = ANGLE_FUNCTIONS.get(name)!;
  const problem = argumentShapeProblem(
    name,
    positionalShape(parameters),
    positional.length,
    Object.keys(named),
  );
  if (problem !== undefined) throw fault("TSR028", problem.message, span);
  const values = positional.map((value) => {
    if (takes === "angle" && isAngle(value)) return value;
    if (takes === "number" && typeof value === "number") return value;
    throw fault(
      "TSR059",
      angleArgumentMessage(name, takes, describeRuntimeValue(value), typeof value),
      span,
    );
  });
  const result = apply(values);
  if (typeof result !== "number" && "failure" in result)
    throw fault(result.code, result.failure, span);
  return result;
}

/** `TSR013` or `TSR031`: the host built-in `name` returned a value that a script cannot hold, for `reason`. */
function invalidReturn(name: string, reason: string): string {
  return internalFault(
    `The built-in function '${name}' returned a value that a script cannot hold: ${reason.replace(/[.]$/u, "")}.`,
  );
}

/** A method a list, set, or dict does not have, in the compiler's wording. */
function noCollectionMethod(receiver: SerializableRuntimeValue, name: string): string {
  if (!isDict(receiver)) return `${isSet(receiver) ? "Sets" : "Lists"} have no method '${name}'.`;
  return name === "add"
    ? "Dicts have no method 'add'. Store a value by its key, as in dict[key] = value."
    : `Dicts have no method '${name}'. Use contains, remove, clear, or get.`;
}

/** `TSR018` for `.first` or `.last`, or `TSR019` for `.random`, of an empty list or set the source may spell `label`. */
function emptyCollection(
  name: string,
  collection: SerializableRuntimeList | SerializableRuntimeSet,
  label: string | null,
  span: SourceSpan,
): RuntimeFault {
  return fault(
    name === "random" ? "TSR019" : "TSR018",
    label === null
      ? `Cannot read '.${name}' from an empty ${isSet(collection) ? "set" : "list"}. Check its length first.`
      : `Cannot read '${label}.${name}': '${label}' is empty. Check '${label}.length' first.`,
    span,
  );
}

/**
 * The source spelling of a variable, property path, or text literal plan, also one that the lowering kept in a
 * temporary of `program`, or `null` for anything else.
 */
export function planLabel(plan: ExpressionPlan, program: InstructionPlan): string | null {
  const names: string[] = [];
  let current = loweredOperand(program, plan);
  for (;;) {
    if (current.kind === "group") current = current.expression;
    else if (current.kind === "property") {
      names.push(current.name);
      current = current.object;
    } else break;
  }
  if (current.kind === "literal" && typeof current.value === "string" && names.length === 0)
    return quotedText(messageText(current.value));
  if (current.kind !== "identifier") return null;
  names.push(current.name);
  return names.reverse().join(".");
}

/** A running round must end at a supported session time strictly after a positive remaining time starts. */
function assertRepresentableRound(
  nowMs: number,
  remainingMs: number,
  repeat: boolean,
  span: SourceSpan,
): void {
  // A repeating timer whose remaining time becomes 0 s starts another positive round.
  if (remainingMs > 0 && nowMs === MAX_RUNTIME_SESSION_TIME_MS) {
    throw fault(
      "TSR050",
      `Scene time has reached its limit, so this timer cannot continue. ${repeat ? "Stop it." : "Stop it, or set its remaining time to 0 s."}`,
      span,
    );
  }
  const deadlineMs = nowMs + remainingMs;
  if (!isValidSessionTime(deadlineMs) || (remainingMs > 0 && deadlineMs <= nowMs)) {
    throw fault(
      "TSR050",
      isValidSessionTime(deadlineMs)
        ? unmeasurableLengthMessage("Timer remaining time", remainingMs, nowMs, "duration")
        : `Timer remaining time of ${formatDuration(remainingMs)} is too long for scene time to reach. Use a shorter duration.`,
      span,
    );
  }
}

function timerDisplayValue(
  value: SerializableRuntimeValue,
  span: SourceSpan,
): "visible" | "mystery" | "hidden" {
  if (isTimerDisplay(value)) return value;
  throw fault("TSR050", timerDisplayMessage(shownChoice(value)), span);
}

function optionalSpeakerString(
  speaker: RuntimeSpeakerSnapshot,
  name: string,
  span: SourceSpan,
): string | null {
  const value = speaker.properties.find((property) => property.name === name)?.value;
  if (value === undefined || value === null) return null;
  if (isList(value) && name !== "font" && name !== "avatar")
    throw fault(
      "TSR030",
      `A list cannot be the speaker's ${name}. Select one element with "\${list}" or list.random.`,
      span,
    );
  if (typeof value !== "string")
    throw fault(
      "TSR030",
      `Speaker property '${name}' must be text (string), but this is ${describeShownValue(value)}.`,
      span,
    );
  return value;
}

function setSpeakerProperty(
  speaker: RuntimeSpeakerSnapshot,
  name: string,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): void {
  if (name === "defaultSaySkippable" && typeof value !== "boolean") {
    throw fault(
      "TSR050",
      `Speaker property 'defaultSaySkippable' must be true or false (boolean), but this is ${describeShownValue(value)}.`,
      span,
    );
  }
  const property = speaker.properties.find((item) => item.name === name);
  if (property === undefined)
    speaker.properties.push({ name, value: cloneCapturedSerializableValue(value) });
  else property.value = cloneCapturedSerializableValue(value);
}

/** Whether a `let` in the outer scope of a file's root region declares the name. */
function declaresTopLevel(plan: InstructionPlan, file: number, name: string): boolean {
  const { startInstruction, rootEndInstruction } = plan.files[file]!;
  let depth = 0;
  for (let index = startInstruction; index < rootEndInstruction; index += 1) {
    const instruction = plan.instructions[index]!;
    if (instruction.kind === "enterScope") depth += 1;
    else if (instruction.kind === "leaveScope") depth -= 1;
    else if (depth === 0 && instruction.kind === "declareBinding" && instruction.name === name)
      return true;
  }
  return false;
}

/** `script(path, label:)`: a reference to a file or one of its labels, which a transfer checks when it uses it. */
function scriptReference(
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): SerializableScriptReference {
  // The number first, then a name, as the compiler reports them.
  if (positional.length !== 1)
    throw fault("TSR028", scriptArgumentCountMessage(positional.length), span);
  const unknown = Object.keys(named).find((name) => name !== "label");
  if (unknown !== undefined)
    throw fault("TSR028", unknownNamedArgumentMessage("script", unknown, ["label"]), span);
  const text = (value: SerializableRuntimeValue, part: string): string => {
    if (typeof value === "string") return value;
    throw fault(
      "TSR058",
      `script(...) takes ${part} as text (string), not ${describeRuntimeValue(value)}.`,
      span,
    );
  };
  return {
    kind: "script",
    path: text(positional[0]!, "the file path"),
    label: Object.hasOwn(named, "label") ? text(named.label!, "the label") : null,
  };
}

/**
 * The binding `name` refers to: in the scopes of the running function, or of the root; then for a timer, media, or
 * button block, among the variables it shares with the code that created it (V30 §14); then for a function that is not
 * global, in the root scope of its file; then among the session's globals (ADR 0022 §3, §6).
 */
export function findBinding(
  snapshot: RuntimeSnapshot,
  plan: InstructionPlan,
  name: string,
): RuntimeBindingSnapshot | undefined {
  return findBindingLocation(snapshot, plan, name)?.binding;
}

/** The ID of the scope that `name` refers to, as `findBinding` finds it; `GLOBAL_SCOPE_ID` for a global. */
export function bindingScopeId(
  snapshot: RuntimeSnapshot,
  plan: InstructionPlan,
  name: string,
): number | undefined {
  return findBindingLocation(snapshot, plan, name)?.frame.id;
}

function findBindingLocation(
  snapshot: RuntimeSnapshot,
  plan: InstructionPlan,
  name: string,
):
  | {
      readonly frame: { readonly id: number; readonly bindings: readonly RuntimeBindingSnapshot[] };
      readonly binding: RuntimeBindingSnapshot;
    }
  | undefined {
  // Code at a file's top level sees its blocks down to its activation's root; a function or block sees its own
  // scopes, then the root of the activation it runs for (ADR 0022 §5).
  const top = snapshot.callFrames.at(-1);
  const minimum = top === undefined ? 0 : top.scopeBaseDepth;
  for (let index = snapshot.frames.length - 1; index >= minimum; index -= 1) {
    const frame = snapshot.frames[index]!;
    const binding = frameBinding(frame.bindings, name);
    if (binding !== undefined) return { frame, binding };
  }
  if (top?.kind === "function" && top.captures.length > 0) {
    const capture = top.captures.find((candidate) => candidate.name === name);
    if (capture !== undefined) {
      const frame = findScope(snapshot, capture.scopeId)!;
      return { frame, binding: frameBinding(frame.bindings, name)! };
    }
  }
  // A function sees the root of the activation it runs for; a global function sees only globals (ADR 0022 §5, §6).
  if (top?.kind === "function" && plan.functions[top.functionId - 1]?.global !== true) {
    const frame = findRoot(snapshot, top.rootScopeId)!;
    const binding = frameBinding(frame.bindings, name);
    if (binding !== undefined) return { frame, binding };
  }
  const binding = frameBinding(snapshot.globals, name);
  return binding === undefined
    ? undefined
    : { frame: { id: GLOBAL_SCOPE_ID, bindings: snapshot.globals }, binding };
}

/** Frames up to this size are scanned; larger frames are looked up through a name index. */
const INDEXED_FRAME_MIN_BINDINGS = 16;

/**
 * Name indexes of large frames, keyed by the frame's bindings array. A frame's bindings are only ever appended and
 * their names never change, so an index extends itself when its frame has grown. A captured or deeply staged
 * snapshot has new arrays and builds its own index. The index is derived data: it finds the same first binding as a
 * scan.
 */
const frameBindingIndexes = new WeakMap<
  readonly RuntimeBindingSnapshot[],
  { indexed: number; readonly byName: Map<string, RuntimeBindingSnapshot> }
>();

function frameBinding(
  bindings: readonly RuntimeBindingSnapshot[],
  name: string,
): RuntimeBindingSnapshot | undefined {
  if (bindings.length <= INDEXED_FRAME_MIN_BINDINGS) {
    return bindings.find((item) => item.name === name);
  }
  let index = frameBindingIndexes.get(bindings);
  if (index === undefined) {
    index = { indexed: 0, byName: new Map() };
    frameBindingIndexes.set(bindings, index);
  }
  for (; index.indexed < bindings.length; index.indexed += 1) {
    const binding = bindings[index.indexed]!;
    if (!index.byName.has(binding.name)) index.byName.set(binding.name, binding);
  }
  return index.byName.get(name);
}

function readTemporary(
  temporaries: readonly RuntimeTemporarySnapshot[],
  temporaryId: number,
  span: SourceSpan,
): SerializableRuntimeValue {
  const temporary = temporaries.find((item) => item.id === temporaryId);
  if (temporary === undefined) {
    throw fault(
      "TSR046",
      internalFault(
        `An internal value (temporary ${temporaryId}) is missing from the session's state.`,
      ),
      span,
    );
  }
  return temporary.value;
}

/** `TSR045` unless `range` has whole-number bounds and a length that a number counts exactly. */
export function assertIntegerRange(
  range: SerializableRuntimeRange,
  subject: string,
  span: SourceSpan,
): void {
  const length = rangeLength(range);
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    !Number.isSafeInteger(length)
  ) {
    throw fault(
      "TSR045",
      !Number.isInteger(range.start) || !Number.isInteger(range.end)
        ? wholeRangeMessage(subject, `this range is ${rangeText(range)}`)
        : Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
          ? `${subject} needs a range it can count, but ${rangeText(range)} holds too many numbers. Use a smaller range.`
          : `${subject} needs a range of whole numbers, but the bounds of ${rangeText(range)} are too large. Use bounds closer to 0.`,
      span,
    );
  }
}

/**
 * `range.toList()` (V30 §6): the whole numbers of the range as a new list, in order, as `for` goes through them, and at
 * most `MAX_COLLECTION_LENGTH` of them, checked before any is added. The list is new and nothing else holds its
 * numbers, so it takes them without a copy.
 */
function rangeList(range: SerializableRuntimeRange, span: SourceSpan): SerializableRuntimeList {
  assertIntegerRange(range, "toList()", span);
  const tooLong = rangeListLengthProblem(range.start, range.end, range.inclusive);
  if (tooLong !== null) throw fault("TSR045", tooLong, span);
  const items: number[] = [];
  for (let position = 0, length = rangeLength(range); position < length; position += 1)
    items.push(range.start + position);
  return { kind: "list", items };
}

/**
 * `TSR009`: `<`, `<=`, `>`, or `>=` with operands that are not two numbers or two texts, with the values and, for null or
 * numeric text, the fix.
 */
function notComparable(
  expression: BinaryExpressionPlan,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  program: InstructionPlan,
): RuntimeFault {
  let fix = "";
  if (left === null || right === null) {
    const label = planLabel(left === null ? expression.left : expression.right, program);
    fix = ` Check that ${label === null ? "the value" : `'${label}'`} is not null first.`;
  } else if (
    (typeof left === "number" &&
      typeof right === "string" &&
      numberFromText(right) !== undefined) ||
    (typeof right === "number" && typeof left === "string" && numberFromText(left) !== undefined)
  )
    fix = " Convert the text with toNumber(...) first.";
  return fault(
    "TSR009",
    `'${expression.operator}' compares two numbers, two texts, or two durations, but these are ${describeShownValue(left)} and ${describeShownValue(right)}.${fix}`,
    expression.span,
  );
}

function fault(code: RuntimeErrorCode, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}

/** `speaker` in a message that names no speaker with `as` while no default speaker is set (V30 §37). */
function noSpeaker(span: SourceSpan): RuntimeFault {
  return fault(
    "TSR071",
    "This message has no speaker, so 'speaker' has no value: it names none with 'as', and no default speaker is set. Give it one with 'as name', or set a default speaker with 'speaker name' before it.",
    span,
  );
}

const speakerTemporaryIds = new WeakMap<InstructionPlan, ReadonlySet<number>>();

/** The temporaries that hold the speaker of a prepared message for its `speaker` reads, collected once per plan. */
function speakerTemporaries(plan: InstructionPlan): ReadonlySet<number> {
  let ids = speakerTemporaryIds.get(plan);
  if (ids === undefined) {
    ids = new Set(
      plan.instructions.flatMap((instruction) =>
        instruction.kind === "prepareSayContextualSpeaker" ||
        instruction.kind === "prepareInteractionSpeaker"
          ? [instruction.destinationTemporary]
          : [],
      ),
    );
    speakerTemporaryIds.set(plan, ids);
  }
  return ids;
}

interface EvaluatedExpression {
  value: SerializableRuntimeValue;
  owned: boolean;
  descriptor: PreparedReferenceDescriptor | null;
  epoch: number;
}
interface EvaluationFrame {
  expression: ExpressionPlan;
  reference: boolean;
  stage: number;
  index: number;
  value: SerializableRuntimeValue;
  results: SerializableRuntimeValue[] | null;
  descriptor: PreparedReferenceDescriptor | null;
  epoch: number;
  text: string;
  set: SerializableRuntimeSet | null;
  /** A dict literal's entries so far, and the key of the entry whose value is being evaluated. */
  dict: SerializableRuntimeDict | null;
  key: string | null;
  positional: SerializableRuntimeValue[] | null;
  named: Record<string, SerializableRuntimeValue> | null;
  /** A call's `default:` that runs only when the call needs it, by its position, or -1. */
  lazy: number;
  /** The root of `evaluateWithoutDefault`, whose default runs as the instructions after it. */
  probe: boolean;
  /** With a debug trace, the causes collected for this frame's value. */
  deps: DebugDependencies | null;
}
const callingExpressions = new WeakMap<ExpressionPlan, boolean>();

/**
 * Whether evaluating an expression can run a call that may change a value: any call but a conversion, which only reads
 * (see `Conversion`). Results are cached per plan node, so nested checks stay linear.
 */
function mayRunCall(expression: ExpressionPlan): boolean {
  // A node is decided after its children, which are pushed above it.
  const work: { expression: ExpressionPlan; children: readonly ExpressionPlan[] | null }[] = [
    { expression, children: null },
  ];
  while (work.length > 0) {
    const current = work.pop()!;
    if (callingExpressions.has(current.expression)) continue;
    if (
      current.expression.kind === "call" &&
      (current.expression.callee.kind !== "identifier" ||
        !isConversion(current.expression.callee.name))
    ) {
      callingExpressions.set(current.expression, true);
    } else if (current.children !== null) {
      callingExpressions.set(
        current.expression,
        current.children.some((child) => callingExpressions.get(child) === true),
      );
    } else {
      const children = expressionPlanChildren(current.expression);
      work.push({ expression: current.expression, children });
      for (const child of children) work.push({ expression: child, children: null });
    }
  }
  return callingExpressions.get(expression)!;
}

const imageTagMaps = new WeakMap<object, ReadonlyMap<string, number | null>>();

/** An image's tags by name, built once per catalog entry: a plan image or a photo taken with tags. */
function imageTags(image: {
  readonly tags: readonly PlanTag[] | null;
}): ReadonlyMap<string, number | null> {
  let tags = imageTagMaps.get(image);
  if (tags === undefined) {
    tags = new Map((image.tags ?? []).map((tag) => [tag.name, tag.value]));
    imageTagMaps.set(image, tags);
  }
  return tags;
}

/** The tag names of an `all:`, `none:`, or `any:` list or set, normalized as authors write them. */
function tagNames(
  value: SerializableRuntimeValue,
  option: string,
  span: SourceSpan,
): readonly string[] {
  if (!isList(value) && !isSet(value)) {
    throw fault(
      "TSR081",
      `'${option}:' takes a list of tag names, but this is ${describeRuntimeValue(value)}.`,
      span,
    );
  }
  return value.items.map((item) => {
    const name = typeof item === "string" ? normalizeTagName(item) : null;
    if (name === null) {
      throw fault(
        "TSR081",
        `'${option}:' takes tag names, which use lowercase letters a–z, digits, and hyphens, but it holds ${typeof item === "string" ? `'${item}'` : describeRuntimeValue(item)}.`,
        span,
      );
    }
    return name;
  });
}

function evaluationFrame(
  expression: ExpressionPlan,
  reference = false,
  probe = false,
): EvaluationFrame {
  return {
    expression,
    reference,
    stage: 0,
    index: 0,
    value: null,
    results:
      expression.kind === "list" || expression.kind === "object" || expression.kind === "tagQuery"
        ? []
        : null,
    descriptor: null,
    epoch: 0,
    text: "",
    set: expression.kind === "set" ? createCapturedSerializableSet([]) : null,
    dict: expression.kind === "dict" ? { kind: "dict", entries: [] } : null,
    key: null,
    positional: expression.kind === "call" ? [] : null,
    named: expression.kind === "call" ? Object.create(null) : null,
    lazy: expression.kind === "call" ? lazyDefaultArgumentIndex(expression) : -1,
    probe,
    deps: null,
  };
}

/**
 * What a call gives when it needs its `default:`, which runs only then (owner decision, 2026-10-16), or a call or `load`
 * of `evaluateWithoutDefault` that needs the default that the instructions after it run.
 */
export const USE_DEFAULT: unique symbol = Symbol("use the default");

/**
 * The default that a call uses, checked as the call checks it: a `get` default that decided the element or value type
 * of an empty list or dict must fit it also in the parts the compiler could not know (ADR 0021 rule 1.7), and a
 * conversion's must be what its `CONVERSIONS` entry takes. `fileFromBase64`, `decryptText`, and `decryptFile` take any
 * default.
 */
export function acceptedDefault(
  operation: LazyDefaultOperation,
  value: SerializableRuntimeValue,
  typeCheck: TypeCheckPlan | undefined,
  span: SourceSpan,
): SerializableRuntimeValue {
  if (typeCheck !== undefined) assertValueType(value, typeCheck, span);
  if (isConversion(operation)) {
    const conversion: Conversion = CONVERSIONS[operation];
    const description = defaultDescription(conversion);
    if (description !== undefined && !fitsDefault(conversion, value))
      throw fault(
        "TSR058",
        `${operation}(...) needs ${description} as its default:, not ${describeRuntimeValue(value)}.`,
        span,
      );
  }
  return value;
}

/** What to write instead of `+` on text or a list and a value of another kind; the left operand names what was meant. */
function joinFix(left: SerializableRuntimeValue, right: SerializableRuntimeValue): string {
  if (isSet(left) || isSet(right))
    return " Join sets with union(), or copy a set into a list with toList() first.";
  if (isList(left) && isRange(right))
    return " To add the numbers of a range, write list + range.toList().";
  if (isList(left))
    return " To add one element, use add(value), or write list + [value] for a new list.";
  if (isRange(left) && isList(right))
    return " To add the numbers of a range, write range.toList() + list.";
  if (typeof left !== "string" && isList(right)) return " Write [value] + list for a new list.";
  return isVisibleScalar(typeof left === "string" ? right : left)
    ? ' Put the value in the text instead, as in "${first}${second}".'
    : "";
}
