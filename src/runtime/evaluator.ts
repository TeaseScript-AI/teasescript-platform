import { temporalCaptureAt } from "./temporal-captures.js";
import {
  combinedDateAndTime,
  hasTemporalMethod,
  TEMPORAL_GETTERS,
  temporalBinary,
  temporalConverted,
  temporalNow,
  temporalMethod,
  temporalProperty,
} from "./temporal-operations.js";
import { normalizeColor } from "../color.js";
import type {
  AssignmentTargetPlan,
  BinaryExpressionPlan,
  ExpressionPlan,
  PlanSourceLocation,
  TypeCheckPlan,
} from "../plan/model.js";
import { escapeMarkup } from "../message-markup.js";
import { expressionPlanChildren } from "../plan/expression-children.js";
import { CORE_RUNTIME_BUILTINS } from "../protected-names.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import type { DeveloperWarningEvent, InterpreterEvent, OutputSpeaker } from "./events.js";
import { copySpan, takeSequence } from "./operations/support.js";
import {
  detachPreparedReferencesForMutation,
  freezePreparedReferenceDescendants,
  preparePreparedReferencesForListRemoval,
  preparePreparedReferencesForListReorder,
  preparedReferenceSpeakerPath,
  readPreparedReference,
  refreshPreparedReferenceFallbacks,
  serializePreparedReference,
  type PreparedReferenceDescriptor,
  type PreparedReferenceStep,
} from "./prepared-references.js";
import { nextXorShift32, type RandomSource } from "./random.js";
import { isVisibleScalar, quotedText, valueNotation, visibleText } from "./value-text.js";
import {
  SET_OPERATIONS,
  setOperationArgumentMessage,
  setOperationItems,
  sortOrder,
} from "./collection-operations.js";
import { formatDuration } from "../duration.js";
import {
  callStringMethod,
  checkTextArguments,
  missingMemberMessage,
  STRING_METHODS,
  stringLength,
} from "./string-operations.js";
import { LIST_JOIN, unknownTextMemberMessage } from "../text-operations.js";
import { LOAD_KEY_MESSAGE, findScriptStorageEntry, storageKey } from "./script-storage.js";
import {
  addSerializableSetValue,
  cloneCapturedSerializableValue,
  cloneSerializableValue,
  containsRuntimeIdentity,
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
  type SerializableRuntimeDict,
  type SerializableRuntimeDuration,
  type SerializableRuntimeList,
  type SerializableRuntimeObject,
  type SerializableRuntimeRange,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
  type SerializableTimerHandle,
  type SerializableMediaHandle,
} from "./serializable-values.js";
import {
  currentTemporalContext,
  type RuntimeBindingSnapshot,
  type RuntimeSnapshot,
  type RuntimeSpeakerSnapshot,
  type RuntimeTemporarySnapshot,
} from "./state.js";
import {
  describeRuntimeValue,
  isDict,
  isDuration,
  isList,
  isObject,
  isRange,
  isSet,
  isSpeakerReference,
  isTemporal,
  isTimerHandle,
  isMediaHandle,
} from "./value-predicates.js";
import {
  assertValueType,
  describeValue as describeTypedValue,
  matchesValueType,
} from "./value-types.js";
import {
  mediaEndMs,
  mediaProperty,
  pauseMedia,
  resumeMedia,
  seekMedia,
  setMediaVolume,
  type MediaWarning,
  type RuntimeMediaSnapshot,
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
  type RuntimeTimerSnapshot,
  type TimerWarning,
} from "./timers.js";
import {
  activeTimerAction,
  expireTimerAction,
  stopTimerAction,
  timerRecord,
} from "./operations/timer-lifecycle.js";
import { isValidSessionTime } from "./actions/delay.js";
import {
  booleanFromText,
  CONVERSION_RESULTS,
  describeConversionResult,
  isConversionName,
  isConversionResult,
  isTemporalConversionResult,
  numberFromText,
  rounded,
  MIN_MAX_BUILTINS,
  ROUNDING_BUILTINS,
  temporalTextProblem,
  withoutNegativeZero,
  type ConversionName,
  type ConversionResult,
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

export class RuntimeExecutionContext {
  public readonly events: InterpreterEvent[] = [];
  #evaluator: Evaluator | null = null;

  public constructor(
    private readonly snapshot: RuntimeSnapshot,
    private readonly capabilities: RuntimeCapabilities,
  ) {}

  public evaluator(): Evaluator {
    if (this.#evaluator !== null) {
      this.#evaluator.refreshBuiltinRegistration();
      return this.#evaluator;
    }
    this.#evaluator = new Evaluator(this.snapshot, this.capabilities, this.events);
    return this.#evaluator;
  }
}

export class Evaluator {
  readonly #builtins: Record<string, RuntimeBuiltinFunction> = Object.create(null);

  #referenceEpoch = 0;

  public constructor(
    private readonly snapshot: RuntimeSnapshot,
    private readonly capabilities: RuntimeCapabilities,
    private readonly events: InterpreterEvent[],
  ) {
    this.refreshBuiltinRegistration();
  }

  public refreshBuiltinRegistration(): void {
    for (const name of Object.keys(this.#builtins)) delete this.#builtins[name];
    Object.assign(this.#builtins, this.capabilities.builtins ?? {});
  }

  public forSnapshot(snapshot: RuntimeSnapshot, events: InterpreterEvent[]): Evaluator {
    return new Evaluator(snapshot, this.capabilities, events);
  }

  public evaluate(expression: ExpressionPlan): SerializableRuntimeValue {
    return this.#evaluateMachine(expression, false).value;
  }

  #evaluateLeaf(
    expression: Extract<
      ExpressionPlan,
      { kind: "literal" | "duration" | "identifier" | "temporary" | "preparedReference" }
    >,
  ): SerializableRuntimeValue {
    switch (expression.kind) {
      case "literal":
        return expression.value;
      case "duration":
        return { kind: "duration", milliseconds: expression.milliseconds };
      case "identifier": {
        if (expression.name === "speaker" && this.snapshot.contextualSpeaker !== null) {
          const speaker = this.speakerById(this.snapshot.contextualSpeaker, expression.span);
          return {
            kind: "speakerReference",
            speakerId: speaker.id,
            identifier: speaker.identifier,
          };
        }
        const binding = findBinding(this.snapshot, expression.name);
        if (binding === undefined) {
          throw fault("TSR006", `Unknown identifier '${expression.name}'.`, expression.span);
        }
        return binding.value;
      }
      case "temporary":
        return readTemporary(this.snapshot.temporaries, expression.temporaryId, expression.span);
      case "preparedReference":
        return this.#resolvePreparedReference(
          readTemporary(this.snapshot.temporaries, expression.temporaryId, expression.span),
          expression.span,
        );
    }
  }

  #evaluateMachine(root: ExpressionPlan, reference: boolean): EvaluatedExpression {
    // Frames are consumed synchronously within one instruction; no continuation escapes
    // into a checkpoint. Collection calls invalidate cached reference cursors.
    this.#referenceEpoch = 0;
    const pending: EvaluationFrame[] = [evaluationFrame(root, reference)];
    let result: EvaluatedExpression = {
      value: null,
      owned: false,
      descriptor: null,
      epoch: this.#referenceEpoch,
    };
    while (pending.length) {
      const frame = pending.at(-1)!;
      const expression = frame.expression;
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
                  throw fault(
                    expression.name === "random" ? "TSR019" : "TSR018",
                    `Cannot read '.${expression.name}' from an empty collection.`,
                    expression.span,
                  );
                const index =
                  expression.name === "first"
                    ? 0
                    : expression.name === "last"
                      ? base.items.length - 1
                      : Math.floor(this.#findRandom(expression.span) * base.items.length);
                frame.descriptor.path.push({ kind: "index", index });
                frame.value = base.items[index]!;
              } else {
                frame.descriptor.path.push({ kind: "property", name: expression.name });
                frame.value = this.#getProperty(base, expression.name, expression.span);
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
            this.#assertIndexable(frame.value, expression.span);
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
          const index = this.#index(result.value, expression.index.span);
          this.#assertIndex(object, index, expression.index.span);
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
        if (expression.kind === "identifier") {
          const location = findBindingLocation(this.snapshot, expression.name);
          if (location === undefined)
            throw fault("TSR006", `Unknown identifier '${expression.name}'.`, expression.span);
          result = {
            value: location.binding.value,
            owned: false,
            descriptor: {
              rootFrameId: location.frame.id,
              rootName: expression.name,
              path: [],
              capturedRoot: cloneCapturedSerializableValue(location.binding.value),
              detached: false,
            },
            epoch: this.#referenceEpoch,
          };
          pending.pop();
          continue;
        }
        if (expression.kind === "preparedReference") {
          const descriptor = readPreparedReference(
            readTemporary(this.snapshot.temporaries, expression.temporaryId, expression.span),
            expression.span,
          );
          result = {
            // A prepared-reference leaf only copies its descriptor. Its parent resolves
            // it at the receiver span; a root prepareReference does not read it.
            value: null,
            owned: false,
            descriptor,
            epoch: -1,
          };
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
        case "duration":
        case "identifier":
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
                    `Duplicate object property '${property.name}'.`,
                    property.span,
                  );
                names.add(property.name);
              }
            }
            frame.stage = 1;
          } else {
            if (expression.kind === "set") {
              try {
                addSerializableSetValue(frame.set!, result.value, frame.membership!);
              } catch (error) {
                throw this.#translateValueError(error, expression.elements[frame.index - 1]!.span);
              }
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
            frame.key = this.#dictKey(result.value, expression.entries[frame.index]!.key.span);
            frame.stage = 2;
            pending.push(evaluationFrame(expression.entries[frame.index]!.value));
            continue;
          }
          if (frame.stage === 2) {
            // A later entry with an equal key replaces the earlier one in its position.
            const entryValue = result.owned
              ? result.value
              : cloneCapturedSerializableValue(result.value);
            const existing = getSerializableDictEntry(frame.dict!, frame.key!);
            if (existing === undefined)
              frame.dict!.entries.push({ key: frame.key!, value: entryValue });
            else existing.value = entryValue;
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
            if (part.kind === "expression")
              frame.text += this.interpolationText(result.value, part.expression.span);
          }
          while (
            frame.index < expression.parts.length &&
            expression.parts[frame.index]!.kind === "text"
          ) {
            const part = expression.parts[frame.index++]!;
            if (part.kind === "text") frame.text += part.value;
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
          value = this.#getProperty(result.value, expression.name, expression.span);
          break;
        case "index":
          if (frame.stage === 0) {
            frame.stage = 1;
            pending.push(evaluationFrame(expression.object));
            continue;
          }
          if (frame.stage === 1) {
            frame.value = result.value;
            this.#assertIndexable(frame.value, expression.span);
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
            const index = this.#index(result.value, expression.index.span);
            // EVIDENCE: invariant: stage 1 validates and retains the index receiver.
            const object = frame.value as SerializableRuntimeList;
            this.#assertIndex(object, index, expression.index.span);
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
              throw fault("TSR026", "Expected a boolean value.", expression.operand.span);
            value = !result.value;
          } else if (isDuration(result.value)) {
            value = {
              kind: "duration",
              milliseconds:
                expression.operator === "+"
                  ? result.value.milliseconds
                  : 0 - result.value.milliseconds,
            };
          } else {
            const number = this.#number(result.value, expression.operand.span);
            value = this.#finite(expression.operator === "+" ? number : -number, expression.span);
          }
          break;
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
                throw fault("TSR026", "Expected a boolean value.", expression.left.span);
              if (expression.operator === "and" ? !frame.value : frame.value) {
                value = frame.value;
                break;
              }
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
            frame.value = this.#number(result.value, expression.start.span);
            frame.stage = 2;
            pending.push(evaluationFrame(expression.end));
            continue;
          }
          // EVIDENCE: invariant: range stage 1 validates the start before evaluating the end.
          value = {
            kind: "range",
            // EVIDENCE: invariant: range stage 1 validates and retains the numeric start.
            start: frame.value as number,
            end: this.#number(result.value, expression.end.span),
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
          } else if (frame.stage === 1 && expression.callee.kind === "property")
            frame.value =
              result.epoch === this.#referenceEpoch
                ? result.value
                : this.#resolveDescriptor(result.descriptor!, expression.callee.object.span);
          else if (frame.stage === 2) {
            const argument = expression.arguments[frame.index - 1]!;
            const captured = cloneCapturedSerializableValue(result.value);
            if (argument.kind === "positional") frame.positional!.push(captured);
            else {
              if (Object.hasOwn(frame.named!, argument.name))
                throw fault(
                  "TSR010",
                  `Duplicate named argument '${argument.name}'.`,
                  argument.span,
                );
              frame.named![argument.name] = captured;
            }
          }
          if (frame.index < expression.arguments.length) {
            frame.stage = 2;
            pending.push(evaluationFrame(expression.arguments[frame.index++]!.value));
            continue;
          }
          value = this.#call(expression, frame.value, frame.positional!, frame.named!);
          break;
        case "storageLoad":
          if (frame.stage === 0) {
            frame.stage = 1;
            pending.push(evaluationFrame(expression.key));
            continue;
          }
          if (frame.stage === 1) {
            const key = storageKey(result.value, LOAD_KEY_MESSAGE, expression.key.span);
            const entry = findScriptStorageEntry(this.snapshot, key);
            if (entry !== undefined) {
              value = entry.value;
              break;
            }
            if (expression.default === null) {
              value = null;
              break;
            }
            // The default is evaluated only for an absent key.
            frame.stage = 2;
            pending.push(evaluationFrame(expression.default));
            continue;
          }
          value = result.value;
          break;
      }
      result = { value, owned, descriptor: null, epoch: this.#referenceEpoch };
      pending.pop();
    }
    return result;
  }

  public assign(target: AssignmentTargetPlan, value: SerializableRuntimeValue): void {
    if (target.kind === "identifier") {
      const location = findBindingLocation(this.snapshot, target.name);
      if (location === undefined) {
        throw fault("TSR002", `Cannot assign to unknown variable '${target.name}'.`, target.span);
      }
      if (isSpeakerReference(location.binding.value)) {
        throw fault("TSR034", `Cannot replace speaker '${target.name}'.`, target.span);
      }
      detachPreparedReferencesForMutation(this.snapshot, {
        rootFrameId: location.frame.id,
        rootName: target.name,
        path: [],
      });
      location.binding.value = cloneCapturedSerializableValue(value);
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
        return;
      }
      if (isSpeakerReference(object)) {
        setSpeakerProperty(
          this.speakerById(object.speakerId, target.span),
          target.name,
          value,
          target.span,
        );
        return;
      }
      if (isTimerHandle(object)) {
        this.#assignTimerProperty(object, target.name, value, target.span);
        return;
      }
      if (isMediaHandle(object)) {
        this.#assignMediaProperty(object, target.name, value, target.span);
        return;
      }
      throw fault(
        "TSR003",
        "Only objects, speakers, timer handles, and media handles have assignable properties.",
        target.span,
      );
    }
    if (isSet(object)) throw fault("TSR004", "Sets are not indexable.", target.span);
    if (isDict(object)) {
      // A new key is added at the end; an existing key keeps its position.
      const key = this.#dictKey(this.evaluate(target.index), target.index.span);
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
      return;
    }
    if (!isList(object))
      throw fault("TSR005", "Only lists and dicts have assignable indexes.", target.span);
    const index = this.#index(this.evaluate(target.index), target.index.span);
    this.#assertIndex(object, index, target.index.span);
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
  }

  public prepareReference(expression: ExpressionPlan): SerializableRuntimeObject {
    const descriptor = this.#buildPreparedReference(expression);
    return serializePreparedReference(descriptor);
  }

  public validateAssignmentTarget(target: AssignmentTargetPlan): void {
    if (target.kind === "identifier") return;
    const object = this.evaluate(target.object);
    if (target.kind === "property") {
      if (
        !isObject(object) &&
        !isSpeakerReference(object) &&
        !isTimerHandle(object) &&
        !isMediaHandle(object)
      ) {
        throw fault(
          "TSR003",
          "Only objects, speakers, timer handles, and media handles have assignable properties.",
          target.span,
        );
      }
      return;
    }
    if (isSet(object)) throw fault("TSR004", "Sets are not indexable.", target.span);
    if (isDict(object)) {
      this.#dictKey(this.evaluate(target.index), target.index.span);
      return;
    }
    if (!isList(object)) {
      throw fault("TSR005", "Only lists and dicts have assignable indexes.", target.span);
    }
    const index = this.#index(this.evaluate(target.index), target.index.span);
    this.#assertIndex(object, index, target.index.span);
  }

  public validateCallReceiver(
    receiver: SerializableRuntimeValue,
    method: string,
    span: SourceSpan,
  ): void {
    if (isTimerHandle(receiver) || isMediaHandle(receiver)) {
      if (!["pause", "resume", "stop"].includes(method)) {
        throw fault(
          "TSR016",
          `${isTimerHandle(receiver) ? "Timer" : "Media"} handles have no method '${method}'.`,
          span,
        );
      }
      return;
    }
    if (typeof receiver === "string") {
      if (!STRING_METHODS.has(method))
        throw fault("TSR016", unknownTextMemberMessage(method, "method"), span);
      return;
    }
    if (isTemporal(receiver)) {
      if (!hasTemporalMethod(receiver, method))
        throw fault("TSR016", `Unsupported method '${method}'.`, span);
      return;
    }
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
            "add",
            "remove",
            "removeAt",
            "removeFirst",
            "removeLast",
            "clear",
            "contains",
            "toSet",
            "join",
          ]);
    if (!supported.has(method)) {
      throw fault("TSR016", `Unsupported method '${method}'.`, span);
    }
  }

  #buildPreparedReference(expression: ExpressionPlan): PreparedReferenceDescriptor {
    return this.#evaluateMachine(expression, true).descriptor!;
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
      if (!(error instanceof RuntimeFault) || !isObject(serialized)) throw error;
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
      const frame = this.snapshot.frames.find(
        (candidate) => candidate.id === descriptor.rootFrameId,
      );
      const binding = frame?.bindings.find((candidate) => candidate.name === descriptor.rootName);
      if (binding === undefined) {
        throw fault("TSR053", "Prepared reference root is no longer available.", span);
      }
      value = binding.value;
    } else {
      value = descriptor.capturedRoot;
    }
    for (const step of descriptor.path) {
      if (step.kind === "property") {
        value = this.#getProperty(value, step.name, span);
        continue;
      }
      if (step.kind === "key") {
        const entry = isDict(value) ? getSerializableDictEntry(value, step.key) : undefined;
        if (entry === undefined)
          throw fault("TSR053", "Prepared reference key no longer addresses a dict entry.", span);
        value = entry.value;
        continue;
      }
      if (isList(value) || isSet(value)) {
        if (step.index < 0 || step.index >= value.items.length) {
          throw fault("TSR025", `Collection index ${step.index} is outside the valid range.`, span);
        }
        value = value.items[step.index]!;
        continue;
      }
      throw fault("TSR008", "Prepared reference index no longer addresses a collection.", span);
    }
    return value;
  }

  public speakerByName(name: string, span: SourceSpan): RuntimeSpeakerSnapshot {
    const binding = findBinding(this.snapshot, name);
    if (binding === undefined || !isSpeakerReference(binding.value)) {
      throw fault("TSR023", `'${name}' is not a declared speaker.`, span);
    }
    return this.speakerById(binding.value.speakerId, span);
  }

  public speakerById(id: number, span: SourceSpan): RuntimeSpeakerSnapshot {
    const speaker = this.snapshot.speakers.find((item) => item.id === id);
    if (speaker === undefined) throw fault("TSR023", `Speaker ID '${id}' is not declared.`, span);
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

  public outputSpeaker(
    speaker: RuntimeSpeakerSnapshot,
    span: SourceSpan,
    events: InterpreterEvent[],
  ): OutputSpeaker {
    const explicit = this.#speakerText(speaker, "displayName", span);
    let displayName: string;
    let fallback = false;
    if (explicit !== null) {
      if (explicit.length === 0) {
        throw fault(
          "TSR022",
          `Speaker '${speaker.identifier}' has no resolvable display name.`,
          span,
        );
      }
      displayName = explicit;
    } else {
      const derived = [
        this.#speakerText(speaker, "title", span) ?? this.#speakerText(speaker, "shortTitle", span),
        this.#speakerText(speaker, "firstName", span),
        this.#speakerText(speaker, "lastName", span),
      ]
        .filter((part): part is string => part !== null && part.length > 0)
        .join(" ");
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
          code: "TSW001",
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
        "An interpolated list must contain at least one element to select from.",
        span,
      );
    if (!value.items.every(isVisibleScalar))
      throw fault(
        "TSR021",
        "An interpolated list may contain only text, numbers, true, false, null, durations, and date and time values, because one element is shown as text.",
        span,
      );
    return visibleText(
      this.#randomItem(value.items, span),
      span,
      currentTemporalContext(this.snapshot),
    );
  }

  /** `say` text. A value other than a scalar shows in code-like notation, escaped so that markup leaves it literal. */
  public sayText(value: SerializableRuntimeValue, span: SourceSpan): string {
    return isVisibleScalar(value)
      ? visibleText(value, span, currentTemporalContext(this.snapshot))
      : escapeMarkup(valueNotation(value, span, (handle) => this.#handleNotation(handle, span)));
  }

  /**
   * A timer or media handle as `say` shows it, from the state the snapshot holds now: `<timer "Beat", 7 s left>`,
   * `<timer, paused, 7 s left>`, `<media "music.mp3", playing at 12 s>`, or a settled `<timer, finished>`.
   */
  #handleNotation(
    handle: SerializableTimerHandle | SerializableMediaHandle,
    span: SourceSpan,
  ): string {
    const now = this.snapshot.currentSessionTimeMs;
    const time = (value: SerializableRuntimeValue | undefined): string =>
      value !== undefined && isDuration(value) ? formatDuration(value.milliseconds) : "";
    if (isTimerHandle(handle)) {
      const timer = this.#timer(handle, span);
      const name = timer.label === null ? "timer" : `timer ${quotedText(timer.label)}`;
      const left = `${time(timerProperty(timer, "remaining", now))} left`;
      return timer.state === "running"
        ? `<${name}, ${left}>`
        : timer.state === "paused"
          ? `<${name}, paused, ${left}>`
          : `<${name}, ${timer.state}>`;
    }
    const media = this.#media(handle, span);
    const at = `at ${time(mediaProperty(media, "position", now))}`;
    const state =
      media.state === "running"
        ? `playing ${at}`
        : media.state === "paused"
          ? `paused ${at}`
          : media.state;
    return `<media ${quotedText(media.source)}, ${state}>`;
  }

  /** One element of `list.join()`: a scalar as visible text, without selecting from nested lists. */
  #joinedText(item: SerializableRuntimeValue, span: SourceSpan): string {
    if (!isVisibleScalar(item))
      throw fault(
        "TSR021",
        "join() can only join text, numbers, true or false, null, durations, and date and time values. Select an element or a property first.",
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
        throw fault("TSR026", "Expected a boolean value.", expression.right.span);
      return right;
    }
    if (expression.operator === "==" || expression.operator === "!=") {
      const equal = serializableEquals(left, right);
      return expression.operator === "==" ? equal : !equal;
    }
    if (expression.operator === "in") {
      if (!isRange(right)) throw fault("TSR035", "Unsupported binary operation.", expression.span);
      return (
        typeof left === "number" &&
        left >= right.start &&
        (right.inclusive ? left <= right.end : left < right.end)
      );
    }
    const temporal = temporalBinary(
      expression.operator,
      left,
      right,
      currentTemporalContext(this.snapshot),
      expression.span,
    );
    if (temporal !== undefined) return temporal;
    if (isDuration(left) || isDuration(right)) return this.#durationBinary(expression, left, right);
    if (["<", "<=", ">", ">="].includes(expression.operator)) {
      if (
        (typeof left !== "number" || typeof right !== "number") &&
        (typeof left !== "string" || typeof right !== "string")
      ) {
        throw fault(
          "TSR009",
          "Comparison operands must both be numbers or both be strings.",
          expression.span,
        );
      }
      if (expression.operator === "<") return left < right;
      if (expression.operator === "<=") return left <= right;
      if (expression.operator === ">") return left > right;
      return left >= right;
    }
    const leftNumber = this.#number(left, expression.left.span);
    const rightNumber = this.#number(right, expression.right.span);
    switch (expression.operator) {
      case "+":
        return this.#finite(leftNumber + rightNumber, expression.span);
      case "-":
        return this.#finite(leftNumber - rightNumber, expression.span);
      case "*":
        return this.#finite(leftNumber * rightNumber, expression.span);
      case "/":
        return this.#finite(leftNumber / rightNumber, expression.span);
      case "%":
        return this.#finite(leftNumber % rightNumber, expression.span);
      default:
        throw fault("TSR035", "Unsupported binary operation.", expression.span);
    }
  }

  /** V30 §35 exact-duration arithmetic and comparison; mixing with plain numbers is explicit only. */
  #durationBinary(
    expression: BinaryExpressionPlan,
    left: SerializableRuntimeValue,
    right: SerializableRuntimeValue,
  ): SerializableRuntimeValue {
    const duration = (milliseconds: number): SerializableRuntimeDuration => ({
      kind: "duration",
      milliseconds: this.#finite(milliseconds, expression.span),
    });
    if (isDuration(left) && isDuration(right)) {
      switch (expression.operator) {
        case "+":
          return duration(left.milliseconds + right.milliseconds);
        case "-":
          return duration(left.milliseconds - right.milliseconds);
        case "/":
          return this.#finite(left.milliseconds / right.milliseconds, expression.span);
        case "<":
          return left.milliseconds < right.milliseconds;
        case "<=":
          return left.milliseconds <= right.milliseconds;
        case ">":
          return left.milliseconds > right.milliseconds;
        case ">=":
          return left.milliseconds >= right.milliseconds;
      }
    } else if (isDuration(left) && typeof right === "number") {
      if (expression.operator === "*") return duration(left.milliseconds * right);
      if (expression.operator === "/") return duration(left.milliseconds / right);
    } else if (typeof left === "number" && isDuration(right) && expression.operator === "*") {
      return duration(left * right.milliseconds);
    }
    throw fault(
      "TSR009",
      `Operator '${expression.operator}' is not supported for these duration operands; add durations to durations and multiply or divide durations by numbers.`,
      expression.span,
    );
  }

  #call(
    expression: Extract<ExpressionPlan, { kind: "call" }>,
    receiver: SerializableRuntimeValue,
    positional: SerializableRuntimeValue[],
    named: Record<string, SerializableRuntimeValue>,
  ): SerializableRuntimeValue {
    if (expression.callee.kind === "identifier") {
      const name = expression.callee.name;
      if (isConversionName(name))
        return this.#conversionBuiltin(name, positional, named, expression.span);
      if (ROUNDING_BUILTINS.has(name))
        return this.#roundingBuiltin(name, positional, named, expression.span);
      if (MIN_MAX_BUILTINS.has(name))
        return this.#minMaxBuiltin(name, positional, named, expression.span);
      const coreBuiltin = CORE_RUNTIME_BUILTINS.some((builtin) => builtin === name);
      const platformPrelude = name === "escapeMarkup";
      const builtin = Object.hasOwn(this.#builtins, name) ? this.#builtins[name] : undefined;
      if (!coreBuiltin && !platformPrelude && builtin === undefined) {
        throw fault(
          "TSR011",
          `Unknown built-in function '${expression.callee.name}'.`,
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
            returned = builtin!(call);
        }
      } catch (error) {
        if (error instanceof SerializableValueError) {
          const code =
            error.code === "cyclic" ? "TSR031" : error.code === "setElement" ? "TSR032" : "TSR013";
          throw fault(code, error.message, expression.span);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw fault(
          "TSR012",
          `Built-in '${expression.callee.name}' failed: ${message}`,
          expression.span,
        );
      }
      let copied: SerializableRuntimeValue;
      try {
        copied = cloneSerializableValue(returned);
      } catch (error) {
        if (error instanceof SerializableValueError) {
          throw fault(
            "TSR013",
            `Built-in '${expression.callee.name}' returned an invalid value: ${error.message}`,
            expression.span,
          );
        }
        throw error;
      }
      // Handles and speaker references name records that only the runtime creates; a host cannot hand one out.
      if (containsRuntimeIdentity(copied)) {
        throw fault(
          "TSR013",
          `Built-in '${expression.callee.name}' returned an invalid value: it contains a timer handle, media handle, or speaker reference, which only the runtime creates.`,
          expression.span,
        );
      }
      return copied;
    }
    if (expression.callee.kind === "property" && isTimerHandle(receiver)) {
      return this.#callTimer(receiver, expression.callee.name, positional, named, expression.span);
    }
    if (expression.callee.kind === "property" && isMediaHandle(receiver)) {
      return this.#callMedia(receiver, expression.callee.name, positional, named, expression.span);
    }
    if (expression.callee.kind === "property" && typeof receiver === "string") {
      const name = Object.keys(named)[0];
      if (name !== undefined)
        throw fault(
          "TSR015",
          `${expression.callee.name}() takes its arguments without names; remove '${name}:'.`,
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
      return this.#callDict(receiver, expression, positional, named);
    }
    if (expression.callee.kind === "property") {
      return this.#callCollection(
        receiver!,
        expression.callee.name,
        positional,
        named,
        expression.span,
        expression.typeCheck === undefined
          ? null
          : // Plan validation accepts a type check only on an `add` call with one argument here.
            { check: expression.typeCheck, span: expression.arguments[0]!.value.span },
      );
    }
    throw fault(
      "TSR014",
      "Only injected built-ins and supported collection methods are callable.",
      expression.callee.span,
    );
  }

  /** `added` is the check of an element that `add` inserts, from the compiler (ADR 0021 rule 1.7). */
  #callCollection(
    receiver: SerializableRuntimeValue,
    name: string,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    span: SourceSpan,
    added: { readonly check: TypeCheckPlan; readonly span: SourceSpan } | null,
  ): SerializableRuntimeValue {
    this.#referenceEpoch++;
    if (!isList(receiver) && !isSet(receiver))
      throw fault("TSR016", missingMemberMessage(receiver, name, "method"), span);
    if (Object.keys(named).length !== 0)
      throw fault("TSR015", "Collection methods accept positional arguments only.", span);
    const expect = (count: number): void => {
      if (positional.length !== count)
        throw fault(
          "TSR028",
          `Expected ${count} positional argument(s), received ${positional.length}.`,
          span,
        );
    };
    try {
      if (isSet(receiver)) {
        switch (name) {
          case "add":
            expect(1);
            if (added !== null) assertValueType(positional[0]!, added.check, added.span);
            addSerializableSetValue(receiver, positional[0]!);
            return null;
          case "remove":
            expect(1);
            removeSerializableSetValue(receiver, positional[0]!);
            return null;
          case "clear":
            expect(0);
            receiver.items.length = 0;
            return null;
          case "contains":
            expect(1);
            return serializableSetContains(receiver, positional[0]!);
          case "toList":
            expect(0);
            return createCapturedSerializableList(receiver.items);
          case "intersection":
          case "union":
          case "difference":
            expect(1);
            return createCapturedSerializableSet(
              setOperationItems(
                name,
                receiver.items,
                this.#setOperationArgument(name, positional[0]!, span),
              ),
            );
          case "sort":
          case "shuffle":
            throw fault(
              "TSR016",
              `A set keeps its insertion order, so it has no ${name}(). Copy it into a list with toList() first.`,
              span,
            );
          default:
            throw fault("TSR016", `Unsupported method '${name}'.`, span);
        }
      }
      switch (name) {
        case "add":
          expect(1);
          if (added !== null) assertValueType(positional[0]!, added.check, added.span);
          receiver.items.push(cloneCapturedSerializableValue(positional[0]!));
          return null;
        case "remove": {
          expect(1);
          const index = this.#findValue(receiver.items, positional[0]!);
          if (index >= 0) this.#removeListItem(receiver, index);
          else {
            this.#warn(
              "TSW002",
              "list.remove(value) found no matching value; the list was left unchanged.",
              span,
            );
          }
          return null;
        }
        case "removeAt": {
          expect(1);
          const index = this.#index(positional[0]!, span);
          this.#assertIndex(receiver, index, span);
          return this.#removeListItem(receiver, index);
        }
        case "removeFirst":
        case "removeLast":
          expect(0);
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
          expect(0);
          if (receiver.items.length > 0) {
            freezePreparedReferenceDescendants(this.snapshot, receiver);
            receiver.items.length = 0;
          }
          return null;
        case "contains":
          expect(1);
          return this.#findValue(receiver.items, positional[0]!) >= 0;
        case "toSet":
          expect(0);
          return createCapturedSerializableSet(receiver.items);
        case "sort":
        case "shuffle":
          expect(0);
          this.#reorderList(
            receiver,
            name === "sort"
              ? sortOrder(receiver.items, span)
              : this.#shuffleOrder(receiver.items.length, span),
          );
          return null;
        case "intersection":
        case "union":
        case "difference":
          expect(1);
          return createCapturedSerializableList(
            setOperationItems(
              name,
              receiver.items,
              this.#setOperationArgument(name, positional[0]!, span),
            ),
          );
        case "join": {
          checkTextArguments(LIST_JOIN, positional, span);
          // EVIDENCE: invariant: checkTextArguments proved that a given separator is text.
          const separator = (positional[0] as string | undefined) ?? ", ";
          return receiver.items.map((item) => this.#joinedText(item, span)).join(separator);
        }
        default:
          throw fault("TSR016", `Unsupported method '${name}'.`, span);
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
  ): SerializableRuntimeValue {
    // EVIDENCE: invariant: #call dispatches here only for a property callee.
    const callee = expression.callee as Extract<ExpressionPlan, { kind: "property" }>;
    const name = callee.name;
    const span = expression.span;
    if (!DICT_METHODS.has(name)) throw fault("TSR016", `Dicts have no method '${name}'.`, span);
    const names = Object.keys(named);
    const expected = name === "clear" ? 0 : 1;
    if (
      positional.length !== expected ||
      (name === "get" ? names.length !== 1 || names[0] !== "default" : names.length !== 0)
    )
      throw fault(
        "TSR028",
        name === "get"
          ? "dict.get(key, default: value) takes a key and a 'default:' value."
          : `dict.${name}(${name === "clear" ? "" : "key"}) takes ${expected === 0 ? "no arguments" : "one key"}.`,
        span,
      );
    if (name === "clear") {
      if (receiver.entries.length > 0) {
        freezePreparedReferenceDescendants(this.snapshot, receiver);
        receiver.entries.length = 0;
      }
      return null;
    }
    const keyPlan = expression.arguments[0]!.value;
    const key = this.#dictKey(positional[0]!, keyPlan.span);
    // A default the compiler could not know must be a value the dict could hold (ADR 0021 rule 1.7).
    if (name === "get" && expression.typeCheck !== undefined)
      assertValueType(named.default!, expression.typeCheck, expression.arguments[1]!.value.span);
    switch (name) {
      case "contains":
        return getSerializableDictEntry(receiver, key) !== undefined;
      case "get": {
        // A stored null is a value, so only a missing entry gives the default.
        const entry = getSerializableDictEntry(receiver, key);
        return entry === undefined ? named.default! : entry.value;
      }
      default: {
        if (getSerializableDictEntry(receiver, key) === undefined)
          throw missingKey(key, this.#receiverLabel(callee.object), keyPlan, span);
        freezePreparedReferenceDescendants(this.snapshot, receiver, key);
        return removeSerializableDictEntry(receiver, key)!.value;
      }
    }
  }

  #timer(handle: SerializableTimerHandle, span: SourceSpan): RuntimeTimerSnapshot {
    const timer = timerRecord(this.snapshot, handle.timerId);
    if (timer === undefined) throw fault("TSR053", "Timer handle refers to no timer.", span);
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
      throw fault("TSR016", `Timer handles have no method '${name}'.`, span);
    }
    if (positional.length !== 0 || Object.keys(named).length !== 0) {
      throw fault("TSR028", `Timer ${name}() takes no arguments.`, span);
    }
    const timer = this.#timer(handle, span);
    const action = activeTimerAction(this.snapshot, handle.timerId);
    const now = this.snapshot.currentSessionTimeMs;
    if (name === "stop") {
      if (action !== undefined) stopTimerAction(this.snapshot, action, span, this.events);
      return null;
    }
    if (name === "resume" && timer.state === "paused") {
      assertRepresentableRound(now, timer.remainingMs!, span);
    }
    const warning = name === "pause" ? pauseTimer(timer, now) : resumeTimer(timer, now);
    if (warning !== null) this.#warn(warning.code, warning.message, span);
    // A round that is already due while its expiry work waits behind a block ends now, like `remaining = 0`.
    if (action !== undefined && timer.state === "paused" && timer.remainingMs === 0) {
      expireTimerAction(this.snapshot, action, now, span, this.events);
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
      if (!isDuration(value)) {
        throw fault("TSR050", `Timer ${name} must be assigned a duration such as 10 s.`, span);
      }
      if (name === "remaining") {
        if (timer.state === "running" || timer.state === "paused") {
          assertRepresentableRound(now, Math.max(0, value.milliseconds), span);
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
            "Timer repeatDuration must be a positive representable duration.",
            span,
          );
        }
        warning = setTimerRepeatDuration(timer, value.milliseconds, now);
      }
    } else {
      throw fault(
        "TSR003",
        `Timer handle property '${name}' cannot be assigned; assign remaining, display, or repeatDuration.`,
        span,
      );
    }
    if (warning === "expired") {
      expireTimerAction(
        this.snapshot,
        activeTimerAction(this.snapshot, handle.timerId)!,
        now,
        span,
        this.events,
      );
    } else if (warning !== null) {
      this.#warn(warning.code, warning.message, span);
    }
  }

  #media(handle: SerializableMediaHandle, span: SourceSpan): RuntimeMediaSnapshot {
    const media = mediaRecord(this.snapshot, handle.mediaId);
    if (media === undefined) throw fault("TSR053", "Media handle refers to no media.", span);
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
      throw fault("TSR016", `Media handles have no method '${name}'.`, span);
    }
    if (positional.length !== 0 || Object.keys(named).length !== 0) {
      throw fault("TSR028", `Media ${name}() takes no arguments.`, span);
    }
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
      if (typeof value !== "number" || !(value >= 0 && value <= 1)) {
        throw fault("TSR050", "Media volume must be a number from 0 through 1.", span);
      }
      this.#mediaWarning(setMediaVolume(media, value), span);
      return;
    }
    if (name !== "position" && name !== "remaining") {
      throw fault(
        "TSR003",
        `Media handle property '${name}' cannot be assigned; assign position, remaining, or volume.`,
        span,
      );
    }
    if (!isDuration(value) || !Number.isFinite(value.milliseconds)) {
      throw fault("TSR050", `Media ${name} must be assigned a duration such as 10 s.`, span);
    }
    const action = activeMediaAction(this.snapshot, handle.mediaId);
    // Playback already reached by now is committed before the seek starts a new segment.
    if (action !== undefined) drainMediaEvents(null, this.snapshot, action, this.events, span);
    const target =
      name === "position" ? value.milliseconds : mediaEndMs(media) - value.milliseconds;
    this.#mediaWarning(seekMedia(media, target, this.snapshot.currentSessionTimeMs, name), span);
    // A seek to the end of the range completes the pass at once, like a timer's `remaining = 0`.
    if (action !== undefined) {
      drainMediaEvents(null, this.snapshot, action, this.events, span, true);
    }
  }

  #mediaWarning(warning: MediaWarning | null, span: SourceSpan): void {
    if (warning !== null) this.#warn(warning.code, warning.message, span);
  }

  #warn(code: string, message: string, span: SourceSpan): void {
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
  ): SerializableRuntimeValue {
    if (name === "length") return value.items.length;
    if (name === "first" || name === "last") {
      if (value.items.length === 0)
        throw fault("TSR018", `Cannot read '.${name}' from an empty collection.`, span);
      return value.items[name === "first" ? 0 : value.items.length - 1]!;
    }
    if (name === "random") return this.#randomItem(value.items, span);
    throw fault("TSR017", `Unknown collection property '${name}'.`, span);
  }

  #getSpeakerProperty(
    speaker: RuntimeSpeakerSnapshot,
    name: string,
    span: SourceSpan,
  ): SerializableRuntimeValue {
    let property = speaker.properties.find((item) => item.name === name)?.value;
    if (property === undefined && name === "title") {
      property = speaker.properties.find((item) => item.name === "shortTitle")?.value;
    } else if (property === undefined && name === "shortTitle") {
      property = speaker.properties.find((item) => item.name === "title")?.value;
    }
    if (property === undefined) throw fault("TSR017", `Unknown property '${name}'.`, span);
    return property;
  }

  #getObjectProperty(
    object: SerializableRuntimeObject,
    name: string,
    span: SourceSpan,
  ): SerializableRuntimeValue {
    const value = getSerializableProperty(object, name);
    if (value === undefined) throw fault("TSR017", `Unknown property '${name}'.`, span);
    return value;
  }

  #findRandom(span: SourceSpan): number {
    const random =
      this.capabilities.random === undefined
        ? nextXorShift32(this.snapshot.rng)
        : this.capabilities.random.next();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw fault("TSR020", "The injected random source must return a number in [0, 1).", span);
    }
    return random;
  }

  #randomBuiltin(call: RuntimeCapabilityCall): number {
    this.#expectBuiltinArguments("random", call, 0);
    return this.#findRandom(call.span);
  }

  #chanceBuiltin(call: RuntimeCapabilityCall): boolean {
    this.#expectBuiltinArguments("chance", call, 1);
    const percent = call.positional[0];
    if (typeof percent !== "number" || percent < 0 || percent > 100) {
      throw fault(
        "TSR039",
        "chance(percent) requires a finite percentage from 0 through 100.",
        call.span,
      );
    }
    return this.#findRandom(call.span) * 100 < percent;
  }

  #randomIntegerBuiltin(call: RuntimeCapabilityCall): number {
    this.#expectBuiltinArguments("randomInteger", call, 1);
    const range = call.positional[0]!;
    if (!isRange(range)) {
      throw fault("TSR040", "randomInteger(range) requires a range value.", call.span);
    }
    return this.randomIntegerInRange(range, call.span, "randomInteger(range)");
  }

  /** Draws one whole number from a non-empty integer range with the session RNG. */
  public randomIntegerInRange(
    range: SerializableRuntimeRange,
    span: SourceSpan,
    subject: string,
  ): number {
    assertIntegerRange(range, span);
    const length = rangeLength(range);
    if (length < 1) {
      throw fault("TSR041", `${subject} requires a non-empty range.`, span);
    }
    return range.start + Math.floor(this.#findRandom(span) * length);
  }

  /** `toString`, `toNumber`, `toInteger`, or `toBoolean` (V30 §13), with the optional `default:` fallback. */
  #conversionBuiltin(
    name: ConversionName,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    span: SourceSpan,
  ): SerializableRuntimeValue {
    const extra = Object.keys(named).find((key) => key !== "default");
    const result = CONVERSION_RESULTS.get(name)!;
    // A date and a time combine into one date and time (V30 §35).
    const parts = result === "datetime" && positional.length === 2;
    if ((positional.length !== 1 && !parts) || extra !== undefined)
      throw fault(
        "TSR028",
        `${name}(...) takes one value and an optional default:, such as ${name}(value, default: ...).`,
        span,
      );
    const fallback = Object.hasOwn(named, "default") ? named.default : undefined;
    if (fallback !== undefined && !isConversionResult(result, fallback))
      throw fault(
        "TSR058",
        `${name}(...) needs ${describeConversionResult(result)} as its default:, not ${describeRuntimeValue(fallback)}.`,
        span,
      );
    const value = positional[0]!;
    const converted = parts
      ? combinedDateAndTime(value, positional[1]!)
      : this.#converted(result, value, span);
    if (converted !== undefined) return converted;
    if (fallback !== undefined) return fallback;
    if (parts)
      throw fault(
        "TSR058",
        `toDateTime(date, time) combines a date and a time, not ${describeRuntimeValue(value)} and ${describeRuntimeValue(positional[1]!)}.`,
        span,
      );
    const shown = typeof value === "string" ? ` ${JSON.stringify(value)}` : "";
    const reason =
      typeof value === "string" && isTemporalConversionResult(result)
        ? (temporalTextProblem(result, value) ?? "")
        : "";
    throw fault(
      "TSR058",
      `${name}(...) cannot convert ${describeRuntimeValue(value)}${shown} to ${describeConversionResult(result)}${reason}. Give a fallback with default: if the value may not convert.`,
      span,
    );
  }

  /** The converted value, or `undefined` when `value` cannot be converted. */
  #converted(
    result: ConversionResult,
    value: SerializableRuntimeValue,
    span: SourceSpan,
  ): SerializableRuntimeValue | undefined {
    if (isTemporalConversionResult(result)) return temporalConverted(result, value);
    if (result === "string")
      return isVisibleScalar(value)
        ? visibleText(value, span, currentTemporalContext(this.snapshot))
        : undefined;
    if (result === "boolean")
      return typeof value === "boolean"
        ? value
        : typeof value === "string"
          ? booleanFromText(value)
          : undefined;
    const number =
      typeof value === "number"
        ? withoutNegativeZero(value)
        : typeof value === "string"
          ? numberFromText(value)
          : undefined;
    return number === undefined || result === "number"
      ? number
      : withoutNegativeZero(Math.trunc(number));
  }

  /** `min` or `max` of two or more values that are all numbers or all durations. */
  #minMaxBuiltin(
    name: string,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    span: SourceSpan,
  ): SerializableRuntimeValue {
    if (positional.length < 2 || Object.keys(named).length !== 0)
      throw fault(
        "TSR028",
        `${name}(...) takes two or more numbers or durations, such as ${name}(20, total).`,
        span,
      );
    const numbers = positional.every((value) => typeof value === "number");
    if (!numbers && !positional.every(isDuration)) {
      const other = positional.find((value) => typeof value !== "number" && !isDuration(value));
      throw fault(
        "TSR059",
        other === undefined
          ? `${name}(...) needs all numbers or all durations, not a mix of both.`
          : `${name}(...) needs numbers or durations, not ${describeRuntimeValue(other)}.`,
        span,
      );
    }
    // A loop, not a spread into Math.min/Math.max, so a call with very many arguments cannot overflow the native stack.
    const value = (item: SerializableRuntimeValue): number =>
      typeof item === "number" ? item : isDuration(item) ? item.milliseconds : Number.NaN;
    let best = value(positional[0]!);
    for (const item of positional) {
      const candidate = value(item);
      if (name === "min" ? candidate < best : candidate > best) best = candidate;
    }
    return numbers
      ? withoutNegativeZero(best)
      : { kind: "duration", milliseconds: withoutNegativeZero(best) };
  }

  #roundingBuiltin(
    name: string,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    span: SourceSpan,
  ): number {
    if (positional.length !== 1 || Object.keys(named).length !== 0)
      throw fault("TSR028", `${name}(...) takes one number, such as ${name}(2.5).`, span);
    const value = positional[0];
    if (typeof value !== "number")
      throw fault(
        "TSR059",
        `${name}(...) needs a number, not ${describeRuntimeValue(value!)}.${typeof value === "string" ? " Convert text with toNumber(...) first." : ""}`,
        span,
      );
    return rounded(name, value);
  }

  #escapeMarkupBuiltin(call: RuntimeCapabilityCall): string {
    this.#expectBuiltinArguments("escapeMarkup", call, 1);
    const text = call.positional[0];
    if (typeof text !== "string") throw new TypeError("escapeMarkup(text) requires a string.");
    return escapeMarkup(text);
  }

  #expectBuiltinArguments(name: string, call: RuntimeCapabilityCall, count: number): void {
    if (call.positional.length !== count || Object.keys(call.named).length !== 0) {
      throw fault(
        "TSR028",
        `${name} expects ${count} positional argument(s) and no named arguments.`,
        call.span,
      );
    }
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

  /**
   * A uniform random order of `length` items as their old indexes (Fisher–Yates), drawing `length - 1` numbers from the
   * session RNG, or none for fewer than two items, so replay and checkpoint resume reproduce it.
   */
  #shuffleOrder(length: number, span: SourceSpan): number[] {
    const order = Array.from({ length }, (_, index) => index);
    for (let index = length - 1; index > 0; index -= 1) {
      const other = Math.floor(this.#findRandom(span) * (index + 1));
      [order[index], order[other]] = [order[other]!, order[index]!];
    }
    return order;
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

  #findValue(items: readonly SerializableRuntimeValue[], value: SerializableRuntimeValue): number {
    for (let index = 0; index < items.length; index += 1) {
      if (serializableEquals(items[index]!, value)) return index;
    }
    return -1;
  }

  #randomItem(
    items: readonly SerializableRuntimeValue[],
    span: SourceSpan,
  ): SerializableRuntimeValue {
    if (items.length === 0)
      throw fault("TSR019", "Cannot select '.random' from an empty collection.", span);
    return items[Math.floor(this.#findRandom(span) * items.length)]!;
  }

  #getProperty(
    value: SerializableRuntimeValue,
    name: string,
    span: SourceSpan,
  ): SerializableRuntimeValue {
    if (isObject(value)) return this.#getObjectProperty(value, name, span);
    if (isSpeakerReference(value)) {
      return this.#getSpeakerProperty(this.speakerById(value.speakerId, span), name, span);
    }
    if (isList(value) || isSet(value)) return this.#getCollectionProperty(value, name, span);
    if (typeof value === "string") {
      if (name === "length") return stringLength(value);
      throw fault("TSR017", unknownTextMemberMessage(name, "property"), span);
    }
    if (isDict(value)) {
      const property = dictProperty(value, name);
      if (property === undefined)
        throw fault(
          "TSR017",
          `Dicts have no property '${name}'; use length, keys, or values, or read a value as dict[key].`,
          span,
        );
      return property;
    }
    if (isMediaHandle(value)) {
      const property = mediaProperty(
        this.#media(value, span),
        name,
        this.snapshot.currentSessionTimeMs,
      );
      if (property === undefined)
        throw fault("TSR017", `Media handles have no property '${name}'.`, span);
      return property;
    }
    if (isTemporal(value)) {
      const property = temporalProperty(value, name);
      if (property === undefined)
        throw fault(
          "TSR017",
          value.kind === "timestamp"
            ? `Timestamps have no property '${name}'; convert with toDateTime() to read local fields.`
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
        throw fault("TSR017", `Timer handles have no property '${name}'.`, span);
      return property;
    }
    throw fault("TSR017", missingMemberMessage(value, name, "property"), span);
  }

  /** Only lists and dicts are indexed. */
  #assertIndexable(value: SerializableRuntimeValue, span: SourceSpan): void {
    if (isSet(value)) throw fault("TSR004", "Sets are not indexable.", span);
    if (!isList(value) && !isDict(value))
      throw fault("TSR008", "Only lists and dicts can be indexed.", span);
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
      );
    return entry.value;
  }

  /** How the source spells a dict receiver, also one prepared before the rest of its statement, or `null`. */
  #receiverLabel(plan: ExpressionPlan): string | null {
    if (plan.kind !== "preparedReference") return planLabel(plan);
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

  #index(value: SerializableRuntimeValue, span: SourceSpan): number {
    if (typeof value !== "number" || !Number.isInteger(value))
      throw fault("TSR024", "A list index must be an integer.", span);
    return value;
  }

  #assertIndex(list: SerializableRuntimeList, index: number, span: SourceSpan): void {
    if (index < 0 || index >= list.items.length)
      throw fault("TSR025", `List index ${index} is outside the valid range.`, span);
  }

  #number(value: SerializableRuntimeValue, span: SourceSpan): number {
    if (typeof value !== "number") throw fault("TSR027", "Expected a numeric value.", span);
    return value;
  }

  #finite(value: number, span: SourceSpan): number {
    if (!Number.isFinite(value))
      throw fault("TSR036", "Numeric operation produced a non-finite result.", span);
    return value;
  }

  #translateValueError(error: unknown, span: SourceSpan): RuntimeFault {
    if (error instanceof SerializableValueError) {
      return fault(error.code === "setElement" ? "TSR032" : "TSR031", error.message, span);
    }
    throw error;
  }
}

const DICT_METHODS: ReadonlySet<string> = new Set(["contains", "remove", "clear", "get"]);

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
): RuntimeFault {
  const check = `contains(${planLabel(keyPlan) ?? quotedText(key)})`;
  return fault(
    "TSR061",
    `Dictionary has no key ${quotedText(key)}. Check ${owner === null ? `it with ${check}` : `${owner}.${check}`} first.`,
    span,
  );
}

/** The source spelling of a variable, property path, or text literal plan, or `null` for anything else. */
function planLabel(plan: ExpressionPlan): string | null {
  const names: string[] = [];
  let current = plan;
  for (;;) {
    if (current.kind === "group") current = current.expression;
    else if (current.kind === "property") {
      names.push(current.name);
      current = current.object;
    } else break;
  }
  if (current.kind === "literal" && typeof current.value === "string" && names.length === 0)
    return quotedText(current.value);
  if (current.kind !== "identifier") return null;
  names.push(current.name);
  return names.reverse().join(".");
}

/** A running round must end at a supported session time strictly after a positive remaining time starts. */
function assertRepresentableRound(nowMs: number, remainingMs: number, span: SourceSpan): void {
  const deadlineMs = nowMs + remainingMs;
  if (!isValidSessionTime(deadlineMs) || (remainingMs > 0 && deadlineMs <= nowMs)) {
    throw fault(
      "TSR050",
      "Timer remaining time is outside the supported session-time range.",
      span,
    );
  }
}

function timerDisplayValue(
  value: SerializableRuntimeValue,
  span: SourceSpan,
): "visible" | "mystery" | "hidden" {
  if (value === "visible" || value === "mystery" || value === "hidden") return value;
  throw fault("TSR050", 'Timer display must be "visible", "mystery", or "hidden".', span);
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
    throw fault("TSR030", `Speaker property '${name}' must be a string for output.`, span);
  return value;
}

function setSpeakerProperty(
  speaker: RuntimeSpeakerSnapshot,
  name: string,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): void {
  if (name === "defaultSaySkippable" && typeof value !== "boolean") {
    throw fault("TSR050", "Speaker property 'defaultSaySkippable' must be a boolean.", span);
  }
  const property = speaker.properties.find((item) => item.name === name);
  if (property === undefined)
    speaker.properties.push({ name, value: cloneCapturedSerializableValue(value) });
  else property.value = cloneCapturedSerializableValue(value);
}

export function findBinding(
  snapshot: RuntimeSnapshot,
  name: string,
): RuntimeBindingSnapshot | undefined {
  return findBindingLocation(snapshot, name)?.binding;
}

function findBindingLocation(
  snapshot: RuntimeSnapshot,
  name: string,
):
  | { readonly frame: RuntimeSnapshot["frames"][number]; readonly binding: RuntimeBindingSnapshot }
  | undefined {
  const functionBase = snapshot.callFrames.at(-1)?.scopeBaseDepth;
  const minimum = functionBase ?? 0;
  for (let index = snapshot.frames.length - 1; index >= minimum; index -= 1) {
    const frame = snapshot.frames[index]!;
    const binding = frame.bindings.find((item) => item.name === name);
    if (binding !== undefined) return { frame, binding };
  }
  if (functionBase !== undefined) {
    const frame = snapshot.frames[0]!;
    const binding = frame.bindings.find((item) => item.name === name);
    return binding === undefined ? undefined : { frame, binding };
  }
  return undefined;
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

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
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
  /** The member keys of `set`, for duplicate checks while its elements are added. */
  membership: Set<string> | null;
  /** A dict literal's entries so far, and the key of the entry whose value is being evaluated. */
  dict: SerializableRuntimeDict | null;
  key: string | null;
  positional: SerializableRuntimeValue[] | null;
  named: Record<string, SerializableRuntimeValue> | null;
}
const callingExpressions = new WeakMap<ExpressionPlan, boolean>();

/** Whether evaluating an expression can run a call. Results are cached per plan node, so nested checks stay linear. */
function mayRunCall(expression: ExpressionPlan): boolean {
  // A node is decided after its children, which are pushed above it.
  const work: { expression: ExpressionPlan; children: readonly ExpressionPlan[] | null }[] = [
    { expression, children: null },
  ];
  while (work.length > 0) {
    const current = work.pop()!;
    if (callingExpressions.has(current.expression)) continue;
    if (current.expression.kind === "call") {
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

function evaluationFrame(expression: ExpressionPlan, reference = false): EvaluationFrame {
  return {
    expression,
    reference,
    stage: 0,
    index: 0,
    value: null,
    results: expression.kind === "list" || expression.kind === "object" ? [] : null,
    descriptor: null,
    epoch: 0,
    text: "",
    set: expression.kind === "set" ? createCapturedSerializableSet([]) : null,
    membership: expression.kind === "set" ? new Set() : null,
    dict: expression.kind === "dict" ? { kind: "dict", entries: [] } : null,
    key: null,
    positional: expression.kind === "call" ? [] : null,
    named: expression.kind === "call" ? Object.create(null) : null,
  };
}
