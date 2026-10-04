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
  freezePreparedReferenceListDescendants,
  preparePreparedReferencesForListRemoval,
  preparedReferenceSpeakerPath,
  readPreparedReference,
  refreshPreparedReferenceFallbacks,
  serializePreparedReference,
  type PreparedReferenceDescriptor,
  type PreparedReferenceStep,
} from "./prepared-references.js";
import { nextXorShift32, type RandomSource } from "./random.js";
import { isVisibleScalar, quotedText, valueNotation, visibleText } from "./value-text.js";
import { formatDuration } from "../duration.js";
import { LOAD_KEY_MESSAGE, findScriptStorageEntry, storageKey } from "./script-storage.js";
import {
  addSerializableSetValue,
  cloneCapturedSerializableValue,
  cloneSerializableValue,
  containsRuntimeIdentity,
  createCapturedSerializableList,
  createCapturedSerializableSet,
  getSerializableProperty,
  removeSerializableSetValue,
  serializableEquals,
  serializableSetContains,
  SerializableValueError,
  setCapturedSerializableProperty,
  type SerializableRuntimeDuration,
  type SerializableRuntimeList,
  type SerializableRuntimeObject,
  type SerializableRuntimeRange,
  type SerializableRuntimeSet,
  type SerializableRuntimeScalar,
  type SerializableRuntimeValue,
  type SerializableTimerHandle,
  type SerializableMediaHandle,
} from "./serializable-values.js";
import type {
  RuntimeBindingSnapshot,
  RuntimeSnapshot,
  RuntimeSpeakerSnapshot,
  RuntimeTemporarySnapshot,
} from "./state.js";
import {
  isDuration,
  isList,
  isObject,
  isRange,
  isSet,
  isSpeakerReference,
  isTimerHandle,
  isMediaHandle,
} from "./value-predicates.js";
import { assertValueType } from "./value-types.js";
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
            if (isSet(frame.value))
              throw fault("TSR004", "Sets are not indexable.", expression.span);
            if (!isList(frame.value))
              throw fault("TSR008", "Only lists support numeric indexing.", expression.span);
            frame.epoch = this.#referenceEpoch;
            frame.stage = 2;
            pending.push(evaluationFrame(expression.index));
            continue;
          }
          // EVIDENCE: invariant: index reference stage 1 validates and retains the list receiver.
          const object = frame.value as SerializableRuntimeList;
          if (expression.kind !== "index") throw new TypeError("Invalid reference continuation.");
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
            if (isSet(frame.value))
              throw fault("TSR004", "Sets are not indexable.", expression.span);
            if (!isList(frame.value))
              throw fault("TSR008", "Only lists support numeric indexing.", expression.span);
            frame.stage = 2;
            pending.push(evaluationFrame(expression.index));
            continue;
          }
          {
            const index = this.#index(result.value, expression.index.span);
            // EVIDENCE: invariant: stage 1 validates and retains the index receiver.
            const object = frame.value as SerializableRuntimeList;
            this.#assertIndex(object, index, expression.index.span);
            value = object.items[index]!;
          }
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
              (isList(frame.value) || isSet(frame.value) || isObject(frame.value)) &&
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
    if (!isList(object))
      throw fault("TSR005", "Only lists have assignable numeric indexes.", target.span);
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
    if (!isList(object)) {
      throw fault("TSR005", "Only lists have assignable numeric indexes.", target.span);
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
    if (!isList(receiver) && !isSet(receiver)) {
      throw fault("TSR016", `Unsupported method '${method}'.`, span);
    }
    const supported = isSet(receiver)
      ? new Set(["add", "remove", "clear", "contains", "toList"])
      : new Set([
          "add",
          "remove",
          "removeAt",
          "removeFirst",
          "removeLast",
          "clear",
          "contains",
          "toSet",
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

  public outputSpeaker(
    speaker: RuntimeSpeakerSnapshot,
    span: SourceSpan,
    events: InterpreterEvent[],
  ): OutputSpeaker {
    const explicit = optionalSpeakerString(speaker, "displayName", span);
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
        optionalSpeakerString(speaker, "title", span) ??
          optionalSpeakerString(speaker, "shortTitle", span),
        optionalSpeakerString(speaker, "firstName", span),
        optionalSpeakerString(speaker, "lastName", span),
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
    if (!isList(value)) return visibleText(value, span);
    if (value.items.length === 0)
      throw fault(
        "TSR019",
        "An interpolated list must contain at least one element to select from.",
        span,
      );
    if (!value.items.every(isVisibleScalar))
      throw fault(
        "TSR021",
        "An interpolated list may contain only text, numbers, true, false, null, and durations, because one element is shown as text.",
        span,
      );
    return visibleText(this.#randomItem(value.items, span), span);
  }

  /** `say` text. A value other than a scalar shows in code-like notation, escaped so that markup leaves it literal. */
  public sayText(value: SerializableRuntimeValue, span: SourceSpan): string {
    return isVisibleScalar(value)
      ? visibleText(value, span)
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
          case "round":
          case "floor":
          case "ceil":
            returned = this.#roundingBuiltin(name, call);
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
    if (expression.callee.kind === "property") {
      return this.#callCollection(
        receiver!,
        expression.callee.name,
        positional,
        named,
        expression.span,
        expression.typeCheck === undefined
          ? null
          : // Plan validation accepts a type check only on an `add` call with one argument.
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
      throw fault("TSR016", `Unsupported method '${name}'.`, span);
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
            freezePreparedReferenceListDescendants(this.snapshot, receiver);
            receiver.items.length = 0;
          }
          return null;
        case "contains":
          expect(1);
          return this.#findValue(receiver.items, positional[0]!) >= 0;
        case "toSet":
          expect(0);
          return createCapturedSerializableSet(receiver.items);
        default:
          throw fault("TSR016", `Unsupported method '${name}'.`, span);
      }
    } catch (error) {
      if (error instanceof RuntimeFault) throw error;
      throw this.#translateValueError(error, span);
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

  /**
   * `round` gives the nearest whole number, rounding a half away from zero; `floor` and `ceil` round toward negative
   * and positive infinity (V30 §13). A zero result is always `0`, never `-0`.
   */
  #roundingBuiltin(name: "round" | "floor" | "ceil", call: RuntimeCapabilityCall): number {
    this.#expectBuiltinArguments(name, call, 1);
    const value = call.positional[0];
    if (typeof value !== "number") throw new TypeError(`${name}(value) requires a number.`);
    const rounded =
      name === "floor"
        ? Math.floor(value)
        : name === "ceil"
          ? Math.ceil(value)
          : Math.sign(value) * Math.round(Math.abs(value));
    return rounded === 0 ? 0 : rounded;
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
    throw fault("TSR017", `Value has no property '${name}'.`, span);
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
  membership: Set<SerializableRuntimeScalar> | null;
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
    positional: expression.kind === "call" ? [] : null,
    named: expression.kind === "call" ? Object.create(null) : null,
  };
}
