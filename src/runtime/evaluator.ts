import {
  argumentShapeProblem,
  callShapeProblem,
  FIXED_PARAMETERS,
  NO_ARGUMENTS,
  positionalShape,
  scriptArgumentCountMessage,
  unknownNamedArgumentMessage,
} from "../argument-rules.js";
import { changesEntries } from "../dict-operations.js";
import { isListFunction } from "../list-function-rules.js";
import { listMethod } from "../list-methods.js";
import type { StartValueOwner } from "../start-value-rules.js";
import type { DeveloperWarningCode } from "../diagnostic-codes.js";
import { temporalCaptureAt } from "./host-data/temporal-captures.js";
import { isClockFunction } from "../temporal-builtins.js";
import { temporalNow, temporalMethod } from "./values/temporal-operations.js";
import type {
  AssignmentTargetPlan,
  ExpressionPlan,
  InstructionPlan,
  RangeExpressionPlan,
  TypeCheckPlan,
  TypePlan,
} from "../plan/model.js";
import { escapedMarkupLength, escapeMarkup } from "../message-markup.js";
import { lazyDefaultArgumentIndex, lazyDefaultCallOperation } from "../plan/expression-children.js";
import type { LazyDefaultOperation } from "../lazy-defaults.js";
import { isNumericFunction } from "../numeric-functions.js";
import { isRandomFunction } from "../random-functions.js";
import { angleDegrees, angleValue } from "../angle.js";
import { playerProfileFieldValue } from "./host-data/player-profile.js";
import { listFunctionValue } from "./values/list-statistics.js";
import { CORE_RUNTIME_BUILTINS, type ConversionName } from "../language-facts.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { internalFault, RuntimeFault } from "./errors.js";
import type {
  InstructionTraceCollector,
  RuntimeInstructionObserver,
} from "./debug/instruction-trace.js";
import type { DeveloperWarningEvent, InterpreterEvent, OutputSpeaker } from "./events.js";
import { takeSequence } from "./operations/support.js";
import {
  preparedReferenceChangeTarget,
  readPreparedReference,
  scopeBindings,
  type PreparedReferenceDescriptor,
} from "./scopes/prepared-references.js";
import type { RandomSource } from "./random/random.js";
import { RandomControlSignal, type RandomControl } from "./random/random-control.js";
import { mayChangeValue } from "./evaluation/effect-facts.js";
import { isVisibleScalar, quotedText, visibleText } from "./values/value-text.js";
import {
  checkTextLength,
  MAX_TEXT_LENGTH,
  messageText,
  textTooLong,
} from "./values/text-length.js";
import { textSha256 } from "./values/sha256.js";
import { conversionResult, numericFunction } from "./values/pure-operations.js";
import { rangeBoundRule, rangeLength } from "../range-checks.js";
import { notNumberFix, UNIT_AMOUNT_RULE, unitAmountFix } from "../operand-rules.js";
import { rangeListLengthProblem } from "./values/collection-operations.js";
import {
  calendarDuration,
  durationParts,
  exactDuration,
  negateDuration,
  unitValue,
} from "../duration.js";
import { callStringMethod } from "./values/string-operations.js";
import { findScriptStorageEntry, storageKey, storageKeyPlace } from "./host-data/script-storage.js";
import {
  addOwnedSerializableSetValue,
  addSerializableSetValue,
  cloneCapturedSerializableValue,
  cloneSerializableValue,
  findRuntimeIdentity,
  createCapturedSerializableSet,
  SerializableValueError,
  setOwnedSerializableDictValue,
  type SerializableRuntimeDict,
  type SerializableRuntimeList,
  type SerializableRuntimeObject,
  type SerializableRuntimeRange,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
  type SerializableScriptReference,
} from "./values/serializable-values.js";
import {
  currentTemporalContext,
  type RuntimeBindingSnapshot,
  type RuntimeSnapshot,
  type RuntimeSpeakerSnapshot,
} from "./snapshot/state.js";
import {
  isAngle,
  isAnyDuration,
  isDict,
  isList,
  isObject,
  isRange,
  isSet,
  isSpeakerReference,
  isTemporal,
  isTimerHandle,
  isMediaHandle,
  isMessageHandle,
  isCameraView,
  isPermanentButton,
} from "./values/value-predicates.js";
import {
  assertFallbackType,
  assertValueType,
  cannotConvert,
  describeShownValue,
  jsonFieldMismatch,
  jsonKindMismatch,
  matchesValueType,
  storedFieldMismatch,
  storedValueMismatch,
} from "./values/value-types.js";
import { readExpected, repairedRecord, takesEveryValue } from "./values/expected-reading.js";
import { contextRootId, findRoot } from "./scopes/activations.js";
import {
  bindingKey,
  emptyDependencies,
  stateKey,
  type DebugDependencies,
  type StatePart,
  type RuntimeDebugRandomOperation,
  type TraceStore,
} from "./debug/debug-trace.js";
import {
  CONVERSIONS,
  defaultDescription,
  FILE_TEXT_FUNCTIONS,
  fitsDefault,
  isConversion,
  type Conversion,
  type ValueConversion,
} from "../conversions.js";
import { escapeMarkupFix, textOperandMessage } from "../text-operand-rules.js";
import { describeValue, valueKindOf } from "../value-kinds.js";
import {
  callPermanentButton,
  callTimer,
  callMedia,
  callMessage,
  handleMethodName,
} from "./evaluation/handles.js";
import { callCollection, callDict } from "./evaluation/collections.js";
import { tagQuery, randomFunction, randomIntegerInRange } from "./evaluation/draws.js";
import {
  type SourceSpan,
  fault,
  USE_DEFAULT,
  assertIntegerRange,
  receiverLabel,
  readTemporary,
  planLabel,
} from "./evaluation/support.js";
import {
  getProperty,
  elementIndex,
  assertIndexable,
  dictKey,
  dictValue,
  listPosition,
  elementProperty,
  emptyCollection,
  notWholeIndex,
} from "./evaluation/access.js";
import {
  assign,
  appendAssigned,
  prepareReference,
  validateAssignmentTarget,
  validateCallReceiver,
  resolvePreparedReference,
  resolveDescriptor,
} from "./evaluation/assignment.js";
import {
  speakerByName,
  speakerById,
  copyPlayerProfile,
  outputSpeaker,
  interpolationText,
  sayText,
} from "./evaluation/speakers.js";
import {
  binary,
  operandLabel,
  notNumber,
  notNumberKind,
  notBoolean,
  notLogicalOperand,
  operandText,
} from "./evaluation/operators.js";
import { findBindingLocation } from "./evaluation/bindings.js";
import { copySpan } from "../plan/source-location.js";

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

/** The public members serve the engine and the modules in `evaluation/`, and are internal to the runtime. */
export class Evaluator {
  readonly #builtins: Record<string, RuntimeBuiltinFunction> = Object.create(null);

  /** The builtin record `#builtins` was last filled from. */
  #registered: RuntimeCapabilities["builtins"] = undefined;

  public referenceEpoch = 0;

  /** Whether the reference being prepared keeps a copy of its root (`preparedReferenceTemporaries`). */
  public keepPreparedRoot = false;

  /** The global or speaker whose start value is being evaluated, which may not select at random (ADR 0022 §6). */
  #startValue: StartValueOwner | null = null;

  public get startValue(): StartValueOwner | null {
    return this.#startValue;
  }

  /** With controlled randomness, the generator state before the last draw: its ID. */
  public drawId = 0;

  /** Whether the call or `load` of `evaluateWithoutDefault` needs its default. */
  #defaultNeeded = false;
  /** The JSON record a `fromJson` that needs its default leaves for it to repair (see `readJson`), until its call takes it. */
  #retained: SerializableRuntimeValue | undefined;

  public constructor(
    public readonly snapshot: RuntimeSnapshot,
    public readonly capabilities: RuntimeCapabilities,
    public readonly events: InterpreterEvent[],
    public readonly plan: InstructionPlan,
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
    return this.evaluateMachine(expression, false).value;
  }

  /**
   * Evaluates a call or `load` whose `default:` runs as the instructions after it (see
   * `StoreTemporaryInstruction.defaultTemporary`), and whether it needs the default.
   */
  public evaluateWithoutDefault(expression: ExpressionPlan): {
    readonly needed: boolean;
    /** The value, or where the default is needed the record it repairs (see `StoreTemporaryInstruction.repair`) or `null`. */
    readonly value: SerializableRuntimeValue;
  } {
    this.#defaultNeeded = false;
    const { value } = this.evaluateMachine(expression, false, true);
    return { needed: this.#defaultNeeded, value };
  }

  /** Evaluates the start value of a global or a speaker property. */
  public evaluateStartValue(
    owner: StartValueOwner,
    expression: ExpressionPlan,
  ): SerializableRuntimeValue {
    this.#startValue = owner;
    try {
      return this.evaluate(expression);
    } finally {
      this.#startValue = null;
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
          | "playerProfileField"
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
      case "playerProfileField": {
        const value = playerProfileFieldValue(
          this.snapshot.playerProfile,
          expression.name,
          expression.span,
          currentTemporalContext(this.snapshot),
        );
        if (value === undefined)
          throw fault(
            "TSR017",
            `'playerProfile' has no '${expression.name}': the player's profile does not give one. Give 'player.${expression.name}' a value and read 'player.${expression.name}' instead.`,
            expression.span,
          );
        // The host gave the player profile, so a read has no recorded origin.
        this.trace?.readState(
          stateKey("playerProfile", expression.name),
          null,
          `playerProfile.${expression.name}`,
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
          const speaker = speakerById(this, this.snapshot.contextualSpeaker, expression.span);
          const reference: SerializableRuntimeValue = {
            kind: "speakerReference",
            speakerId: speaker.id,
            identifier: speaker.identifier,
          };
          if (this.trace !== null) this.readState(reference, null);
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
        const value = resolvePreparedReference(this, serialized, expression.span);
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
  public readState(value: SerializableRuntimeValue, property: string | null): void {
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
  public writeState(
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

  /** A collection method changed what its receiver names; the call's value comes from that change. */
  #traceMutation(descriptor: PreparedReferenceDescriptor | null, span: SourceSpan): void {
    this.trace!.replace(this.traceVariableChange("mutation", descriptor, span));
  }

  /**
   * Records the new version of the variable a change inside it reached, with the causes collected so far, unless the
   * change reached a copy or a value derived at each read. A change inside a speaker's property changes that property,
   * which every name for the speaker reads, and keeps the rest of its earlier version.
   */
  public traceVariableChange(
    kind: "mutation" | "assignment",
    descriptor: PreparedReferenceDescriptor | null,
    span: SourceSpan,
  ): number | null {
    if (descriptor === null) return null;
    const target = preparedReferenceChangeTarget(this.snapshot, descriptor);
    if (target === null) return null;
    if (target !== "variable") {
      const speaker = this.snapshot.speakers.find((candidate) => candidate.id === target.speakerId);
      if (speaker === undefined) return null;
      return this.trace!.writeState(
        kind,
        stateKey("speaker", speaker.id),
        { property: target.property },
        `${speaker.identifier}.${target.property}`,
        speaker.properties.find((candidate) => candidate.name === target.property)?.value ?? null,
        span,
        true,
      );
    }
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

  public evaluateMachine(
    root: ExpressionPlan,
    reference: boolean,
    probe = false,
  ): EvaluatedExpression {
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
    this.referenceEpoch = 0;
    const pending: EvaluationFrame[] = [rootFrame];
    // With a trace, the frame that finished last, whose causes its parent takes over.
    let previous: EvaluationFrame | null = null;
    let previousDepth = 0;
    let finished: EvaluationFrame | null = null;
    let result: EvaluatedExpression = {
      value: null,
      owned: false,
      descriptor: null,
      epoch: this.referenceEpoch,
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
              result.epoch === this.referenceEpoch
                ? result.value
                : resolveDescriptor(this, frame.descriptor, expression.object.span);
            if (expression.kind === "property") {
              const base = frame.value;
              const element = elementProperty(expression.name);
              if ((isList(base) || isSet(base)) && element !== undefined) {
                if (base.items.length === 0)
                  throw emptyCollection(
                    element,
                    base,
                    receiverLabel(this, expression.object),
                    expression.span,
                  );
                const index = elementIndex(this, element, base.items, expression.span);
                if (element === "random") trace?.randomResult(base.items[index]!);
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
                const text = getProperty(
                  this,
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
                frame.value = getProperty(
                  this,
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
                epoch: this.referenceEpoch,
              };
              pending.pop();
              continue;
            }
            assertIndexable(this, frame.value, expression.object, expression.span);
            frame.epoch = this.referenceEpoch;
            frame.stage = 2;
            pending.push(evaluationFrame(expression.index));
            continue;
          }
          if (expression.kind !== "index") throw new TypeError("Invalid reference continuation.");
          if (isDict(frame.value)) {
            const key = dictKey(this, result.value, expression.index);
            frame.descriptor!.path.push({ kind: "key", key });
            result = {
              value: dictValue(this, frame.value, key, expression),
              owned: false,
              descriptor: frame.descriptor,
              epoch: frame.epoch,
            };
            pending.pop();
            continue;
          }
          // EVIDENCE: invariant: index reference stage 1 validates and retains the list or dict receiver.
          const object = frame.value as SerializableRuntimeList;
          const index = listPosition(
            this,
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
                : this.keepPreparedRoot
                  ? cloneCapturedSerializableValue(location.binding.value)
                  : undefined,
              detached: false,
            },
            epoch: this.referenceEpoch,
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
            value = resolvePreparedReference(this, serialized, expression.span);
            descriptor = readPreparedReference(serialized, expression.span);
            epoch = this.referenceEpoch;
          }
          if (trace !== null)
            this.#tracePreparedReference(
              serialized,
              expression.temporaryId,
              descriptor.capturedRoot ??
                resolveDescriptor(this, { ...descriptor, path: [] }, expression.span),
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
          epoch: this.referenceEpoch,
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
        case "playerProfileField":
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
            if (expression.kind === "set") {
              // An owned child moves in, a borrowed one is copied; the first of equal members stays.
              if (result.owned) addOwnedSerializableSetValue(frame.set!, result.value);
              else addSerializableSetValue(frame.set!, result.value);
            } else
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
            frame.key = dictKey(this, result.value, expression.entries[frame.index]!.key);
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
                  interpolationText(this, result.value, part.expression),
                  expression.span,
                );
              else {
                // A list's selection draw belongs to the placeholder, whose text the string then depends on.
                const placeholder = finished?.deps ?? emptyDependencies();
                trace.focus(placeholder, null, false);
                const text = interpolationText(this, result.value, part.expression);
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
          value = getProperty(
            this,
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
            assertIndexable(this, frame.value, expression.object, expression.span);
            frame.stage = 2;
            pending.push(evaluationFrame(expression.index));
            continue;
          }
          if (isDict(frame.value)) {
            value = dictValue(
              this,
              frame.value,
              dictKey(this, result.value, expression.index),
              expression,
            );
            break;
          }
          {
            // EVIDENCE: invariant: stage 1 validates and retains the index receiver.
            const object = frame.value as SerializableRuntimeList;
            const index = listPosition(
              this,
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
            // An operand is read when it is evaluated: copy a shared list, set, or object before the right operand can
            // change it. The current value that `+=` reads through a reference before a call was read then.
            if (
              (expression.operator === "==" ||
                expression.operator === "!=" ||
                expression.left.kind === "preparedReference") &&
              !result.owned &&
              (isList(frame.value) ||
                isSet(frame.value) ||
                isObject(frame.value) ||
                isDict(frame.value)) &&
              mayChangeValue(expression.right)
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
          value = binary(this, expression, frame.value, result.value);
          if (expression.fallbackCheck !== undefined)
            assertFallbackType(value, expression.fallbackCheck, expression.right.span);
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
              result.epoch === this.referenceEpoch
                ? result.value
                : resolveDescriptor(this, result.descriptor!, expression.callee.object.span);
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
              expression.fallbackCheck,
            );
            if (frame.candidate !== undefined && expression.expected !== undefined)
              value = repairedRecord(frame.candidate, value, expression.expected, true);
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
              frame.candidate = this.#retained;
              this.#retained = undefined;
              if (frame.probe) {
                // the record left to repair waits for the default's instructions in the result's temporary
                this.#defaultNeeded = true;
                value = frame.candidate ?? null;
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
            (isDict(frame.value)
              ? changesEntries(expression.callee.name)
              : (isList(frame.value) || isSet(frame.value)) &&
                listMethod(expression.callee.name)?.changes !== undefined)
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
          value = tagQuery(this, expression, frame.results!);
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
            const fits =
              entry === undefined
                ? false
                : expression.repair === true && expression.type !== null
                  ? this.#storedRecordFits(key, entry.value, expression.type, expression.span)
                  : this.#storedValueFits(key, entry.value, expression.type, expression.span);
            if (fits === true) {
              value = entry!.value;
              if (trace !== null) {
                trace.readStorage(key);
                trace.load(key, true, false, value, expression.span);
              }
              break;
            }
            // a stored record with fields to take from the default is repaired from it (ADR 0021 rule 6.5)
            if (fits === "fields") frame.candidate = entry!.value;
            if (expression.default === null) {
              // A probe's default runs as the instructions after it, which repair the record it leaves.
              value = frame.probe ? (frame.candidate ?? null) : null;
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
          if (frame.candidate !== undefined)
            value = repairedRecord(frame.candidate, value, expression.type!, false);
          trace?.load(frame.key!, false, true, value, expression.span);
          break;
      }
      result = { value, owned, descriptor: null, epoch: this.referenceEpoch };
      pending.pop();
    }
    return result;
  }

  #unknownName(name: string, span: SourceSpan): RuntimeFault {
    // `speaker` is no variable: a message with a speaker reads it before any lookup, so this message has none.
    if (name === "speaker") return noSpeaker(span);
    return (
      this.unsetVariable(name, span) ??
      fault(
        "TSR006",
        internalFault(`The plan uses the name '${name}' but does not declare it.`),
        span,
      )
    );
  }

  /**
   * The compiler resolves every name, so a top-level variable of the file that the running code cannot find has a `let`
   * that has not run in this activation: code runs before it, such as a function called earlier (ADR 0022 §3.4).
   * Another name, such as a configured global the host did not supply, gives `null`.
   */
  public unsetVariable(name: string, span: SourceSpan): RuntimeFault | null {
    const root = findRoot(this.snapshot, contextRootId(this.snapshot));
    if (root?.file === null || root === undefined || !declaresTopLevel(this.plan, root.file, name))
      return null;
    return fault(
      "TSR070",
      `'${name}' has no value yet: its 'let ${name}' has not run. Give ${name} a value before it is used.`,
      span,
    );
  }

  public assign(
    target: AssignmentTargetPlan,
    value: SerializableRuntimeValue,
    requireExisting = false,
  ): void {
    return assign(this, target, value, requireExisting);
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
    requireExisting: boolean,
  ): boolean {
    return appendAssigned(this, target, value, typeCheck, requireExisting);
  }

  /**
   * `keepsRoot`: whether an attached reference keeps a copy of its root, as the plan decides for its temporary. Gives
   * the reference to store and the value it selects, which the debug trace shows instead of the reference.
   */
  public prepareReference(
    expression: ExpressionPlan,
    keepsRoot: boolean,
    currentValue: boolean,
  ): { readonly reference: SerializableRuntimeObject; readonly value: SerializableRuntimeValue } {
    return prepareReference(this, expression, keepsRoot, currentValue);
  }

  public validateAssignmentTarget(target: AssignmentTargetPlan): void {
    return validateAssignmentTarget(this, target);
  }

  public validateCallReceiver(
    receiver: SerializableRuntimeValue,
    method: string,
    span: SourceSpan,
  ): void {
    return validateCallReceiver(receiver, method, span);
  }

  public speakerByName(name: string, span: SourceSpan): RuntimeSpeakerSnapshot {
    return speakerByName(this, name, span);
  }

  public speakerById(id: number, span: SourceSpan): RuntimeSpeakerSnapshot {
    return speakerById(this, id, span);
  }

  /**
   * `player.copyFrom(playerProfile)` (V30 §37): the player gets a copy of each person field of the player profile and
   * loses each one the player profile lacks, in place, so its other properties keep their order.
   */
  public copyPlayerProfile(span: SourceSpan): void {
    return copyPlayerProfile(this, span);
  }

  public outputSpeaker(
    speaker: RuntimeSpeakerSnapshot,
    span: SourceSpan,
    events: InterpreterEvent[],
  ): OutputSpeaker {
    return outputSpeaker(this, speaker, span, events);
  }

  /**
   * `say` text. A value shown as text (`shown`) shows as its text, and any other in code-like notation, escaped so that
   * markup leaves it literal: a script reference shows as the call that makes it, and a regex as its literal.
   */
  public sayText(value: SerializableRuntimeValue, span: SourceSpan): string {
    return sayText(this, value, span);
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
      if (isConversion(name)) {
        const converted = this.#conversion(
          name,
          positional,
          named,
          defaulted,
          expression.arguments[0]?.value,
          expression.span,
        );
        // the JSON read as the call's expected type (ADR 0021 rule 2.6)
        if (name !== "fromJson" || expression.expected === undefined || converted === USE_DEFAULT)
          return converted;
        const read = this.readJson(converted, expression.expected, expression.span);
        if (!read.needed) return read.value;
        if (read.value !== null) this.#retained = read.value;
        return USE_DEFAULT;
      }
      if (name === "hashText") return hashedText(positional, named, expression.span);
      if (isRandomFunction(name))
        return randomFunction(this, name, positional, named, expression.span);
      if (isNumericFunction(name)) return numericFunction(name, positional, named, expression.span);
      if (isListFunction(name)) return listFunctionValue(name, positional, named, expression.span);
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
      if (isClockFunction(name)) {
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
        const kind = describeValue(identity);
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
      const called = callTimer(
        this,
        receiver,
        expression.callee.name,
        positional,
        named,
        expression.span,
      );
      if (this.trace !== null)
        this.writeState(receiver, `${expression.callee.name}()`, null, expression.span, "timed");
      return called;
    }
    if (expression.callee.kind === "property" && isMediaHandle(receiver)) {
      const called = callMedia(
        this,
        receiver,
        expression.callee.name,
        positional,
        named,
        expression.span,
      );
      if (this.trace !== null)
        this.writeState(receiver, `${expression.callee.name}()`, null, expression.span, "timed");
      return called;
    }
    if (expression.callee.kind === "property" && isPermanentButton(receiver)) {
      const called = callPermanentButton(
        this,
        receiver,
        expression.callee.name,
        positional,
        named,
        expression.span,
      );
      if (this.trace !== null) this.writeState(receiver, "removed", null, expression.span, "whole");
      return called;
    }
    if (expression.callee.kind === "property" && isMessageHandle(receiver))
      return callMessage(
        this,
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
    if (expression.callee.kind === "property" && isCameraView(receiver)) {
      const method = handleMethodName(
        "camera",
        expression.callee.name,
        positional,
        named,
        expression.span,
      );
      const unhandled: never = method;
      throw new Error(`Camera view method '${String(unhandled)}' has no implementation.`);
    }
    if (expression.callee.kind === "property" && isDict(receiver)) {
      this.referenceEpoch++;
      return callDict(this, receiver, expression, positional, named, defaulted);
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
      // a list `get` that checks its index rejects one that is no whole number before it selects anything; without an
      // index, the call's own argument check reports it
      const indexPlan = expression.arguments.find((argument) => argument.kind === "positional");
      if (expression.indexCheck === true && isList(receiver) && indexPlan !== undefined) {
        const index = positional[0];
        if (!(typeof index === "number" && Number.isInteger(index)))
          throw notWholeIndex(this, indexPlan.value, index ?? null, indexPlan.value.span);
      }
      return callCollection(
        this,
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
    this.warn("TSW016", warning, span);
    return false;
  }

  /**
   * `fromJson`'s JSON read as its expected type (`CallExpressionPlan.expected`, ADR 0021 rule 2.6): its value, or that
   * the call needs its default, with the record the default repairs or `null`; each fallback with `TSW020`.
   */
  public readJson(
    parsed: SerializableRuntimeValue,
    expected: TypePlan,
    span: SourceSpan,
  ): { readonly needed: boolean; readonly value: SerializableRuntimeValue } {
    const reading = readExpected(parsed, expected, true);
    if (reading.kind === "whole") return { needed: false, value: reading.value };
    if (reading.kind === "none") {
      this.warn("TSW020", jsonKindMismatch(parsed, expected), span);
      return { needed: true, value: null };
    }
    // a property nothing settles takes the default's without a warning when the JSON lacks it
    for (const field of reading.fields)
      if (!takesEveryValue(field.type)) this.warn("TSW020", jsonFieldMismatch(field), span);
    return { needed: true, value: parsed };
  }

  /**
   * Whether a stored value fits a load's object type field by field (`StorageLoadExpressionPlan.repair`, V30 §25):
   * `true`; `"fields"` for a record whose missing or wrong fields its default supplies, each with a warning naming it;
   * or `false` for a value of another kind, with the load's warning.
   */
  #storedRecordFits(
    key: string,
    value: SerializableRuntimeValue,
    type: TypePlan,
    span: SourceSpan,
  ): boolean | "fields" {
    const reading = readExpected(value, type, false);
    if (reading.kind === "whole") return true;
    if (reading.kind === "none") return this.#storedValueFits(key, value, type, span);
    for (const field of reading.fields) this.warn("TSW016", storedFieldMismatch(key, field), span);
    return "fields";
  }

  public warn(code: DeveloperWarningCode, message: string, span: SourceSpan): void {
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

  /** Draws one whole number from a non-empty integer range with the session RNG. */
  public randomIntegerInRange(
    range: SerializableRuntimeRange,
    span: SourceSpan,
    subject: string,
    operation: RuntimeDebugRandomOperation,
  ): number {
    return randomIntegerInRange(this, range, span, subject, operation);
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
    const converted = conversionResult(name, positional, named, defaulted, {
      span,
      text: (value) => visibleText(value, span, currentTemporalContext(this.snapshot)),
      speakerProperties: (speaker) => speakerById(this, speaker.speakerId, span).properties,
    });
    if (converted !== undefined) return converted;
    const pair = positional.length === 2 ? conversion.pair : undefined;
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
        `${name}(${pair.join(", ")}) combines a ${pair[0]} and a ${pair[1]}, not ${describeValue(positional[0]!)} and ${describeValue(positional[1]!)}.`,
        span,
      );
    throw fault(
      "TSR058",
      conversionFailure(name, conversion, positional[0]!, argument, this.plan),
      span,
    );
  }

  #escapeMarkupBuiltin(call: RuntimeCapabilityCall): string {
    this.#expectBuiltinArguments("escapeMarkup", call);
    const text = call.positional[0]!;
    if (typeof text !== "string")
      throw fault(
        "TSV043",
        textOperandMessage(
          "escapeMarkup",
          describeValue(text),
          escapeMarkupFix(valueKindOf(text), isList(text) && text.items.every(isVisibleScalar)),
        ),
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
  // The code of a fix names the argument as the source writes it, a name or a member, and replaces the call: a comparison
  // in parentheses, as it may stand next to another operator, as in `toBoolean(n) == true`. Without a name, the fix is
  // in words.
  const label = argument === undefined ? null : planLabel(argument, program);
  const fallback = " Give a fallback with 'default:' if the value may not convert.";
  const shown = describeShownValue(value);
  // `toBoolean` keeps 1, 0, and other texts invalid: an explicit comparison says what the script means.
  if (conversion.result === "boolean" && typeof value !== "string")
    return typeof value === "number"
      ? `${name}(...) converts ${conversion.converts}, not the number ${shown}. ${label === null ? "Compare the number with 0 instead." : `Compare the number instead, such as '(${label} != 0)'.`}`
      : `${name}(...) converts ${conversion.converts}, not ${shown}.${fallback}`;
  const failed = cannotConvert(name, conversion, value);
  if (typeof value === "string" && conversion.result === "boolean")
    return `${failed} ${label === null ? "Compare the text using '==' instead." : `Compare the text instead, such as '(${label} == ${quotedText(messageText(value))})'.`}`;
  if (conversion.kinds === "shown" && (isList(value) || isSet(value) || isDict(value))) {
    const items = isDict(value) ? value.entries.map((entry) => entry.value) : value.items;
    if (items.every(isVisibleScalar)) {
      const join = isSet(value) ? ".toList().join()" : isDict(value) ? ".values.join()" : ".join()";
      return `${failed} ${
        label !== null
          ? `Use '${label}${join}' to combine its ${isDict(value) ? "values" : "elements"} as text.`
          : isSet(value)
            ? "Copy the set into a list with toList(), then call join() on that list to combine its elements as text."
            : isDict(value)
              ? "Call join() on the values of the dict to combine them as text."
              : "Call join() on the list to combine its elements as text."
      }`;
    }
  }
  return `${failed}${fallback}`;
}

/** `hashText(text)` (V30 §13): the SHA-256 of the text's UTF-8 bytes. */
function hashedText(
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): string {
  const problem = callShapeProblem(
    "hashText",
    FILE_TEXT_FUNCTIONS.get("hashText")!,
    positional.length,
    Object.keys(named),
    false,
  );
  if (problem !== undefined) throw fault("TSR028", problem.message, span);
  const text = positional[0]!;
  if (typeof text !== "string")
    throw fault("TSV043", textOperandMessage("hashText", describeValue(text)), span);
  return textSha256(text);
}

/** `TSR013` or `TSR031`: the host built-in `name` returned a value that a script cannot hold, for `reason`. */
function invalidReturn(name: string, reason: string): string {
  return internalFault(
    `The built-in function '${name}' returned a value that a script cannot hold: ${reason.replace(/[.]$/u, "")}.`,
  );
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

/** `script(path)`: a reference to a file, from its top, which a transfer checks when it uses it. */
function scriptReference(
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): SerializableScriptReference {
  // The number first, then a name, as the compiler reports them.
  if (positional.length !== 1)
    throw fault("TSR028", scriptArgumentCountMessage(positional.length), span);
  const unknown = Object.keys(named)[0];
  if (unknown !== undefined)
    throw fault("TSR028", unknownNamedArgumentMessage("script", unknown, []), span);
  const path = positional[0]!;
  if (typeof path !== "string")
    throw fault(
      "TSR058",
      `script(...) takes the file path as text (string), not ${describeValue(path)}.`,
      span,
    );
  return { kind: "script", path };
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
  /**
   * The record a `load` or `fromJson` repairs from its default once that is evaluated (`StorageLoadExpressionPlan.repair`,
   * `CallExpressionPlan.expected`), or `undefined`.
   */
  candidate: SerializableRuntimeValue | undefined;
  /** With a debug trace, the causes collected for this frame's value. */
  deps: DebugDependencies | null;
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
    candidate: undefined,
    deps: null,
  };
}

/**
 * The default that a call uses, checked as the call checks it: a `get` default that decided the element or value type
 * of an empty list or dict must fit it also in the parts the compiler could not know (ADR 0021 rule 1.7), and a
 * conversion's must be what its `CONVERSIONS` entry takes. `fileFromBase64`, `decryptText`, and `decryptFile` take any
 * default. A `fallbackCheck` (`BinaryExpressionPlan.fallbackCheck`) is the default's whole check instead.
 */
export function acceptedDefault(
  operation: LazyDefaultOperation,
  value: SerializableRuntimeValue,
  typeCheck: TypeCheckPlan | undefined,
  span: SourceSpan,
  fallbackCheck?: TypeCheckPlan,
): SerializableRuntimeValue {
  if (fallbackCheck !== undefined) {
    assertFallbackType(value, fallbackCheck, span);
    return value;
  }
  if (typeCheck !== undefined) assertValueType(value, typeCheck, span);
  if (isConversion(operation)) {
    const conversion: Conversion = CONVERSIONS[operation];
    const description = defaultDescription(conversion);
    if (description !== undefined && !fitsDefault(conversion, value))
      throw fault(
        "TSR058",
        `${operation}(...) needs ${description} as its default:, not ${describeValue(value)}.`,
        span,
      );
  }
  return value;
}
