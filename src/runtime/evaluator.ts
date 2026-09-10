import type {
  AssignmentTargetPlan,
  BinaryExpressionPlan,
  ExpressionPlan,
  PlanSourceLocation,
} from "../plan/model.js";
import { escapeMarkup } from "../message-markup.js";
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
import { nextXorShift32, type RandomSource, type XorShift32State } from "./random.js";
import {
  addSerializableSetValue,
  cloneCapturedSerializableValue,
  cloneSerializableValue,
  createCapturedSerializableList,
  createCapturedSerializableSet,
  getSerializableProperty,
  removeSerializableSetValue,
  serializableEquals,
  serializableSetContains,
  SerializableValueError,
  setCapturedSerializableProperty,
  type SerializableRuntimeList,
  type SerializableRuntimeObject,
  type SerializableRuntimeRange,
  type SerializableRuntimeSet,
  type SerializableRuntimeScalar,
  type SerializableRuntimeValue,
} from "./serializable-values.js";
import type {
  RuntimeBindingSnapshot,
  RuntimeSnapshot,
  RuntimeSpeakerSnapshot,
  RuntimeTemporarySnapshot,
} from "./state.js";
import { isList, isObject, isRange, isSet, isSpeakerReference } from "./value-predicates.js";

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
      { kind: "literal" | "identifier" | "temporary" | "preparedReference" }
    >,
  ): SerializableRuntimeValue {
    switch (expression.kind) {
      case "literal":
        return expression.value;
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
            } else frame.results!.push(result);
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
          // Lists/objects capture borrowed children only after all siblings run.
          // Fresh collection children transfer ownership without another deep copy.
          owned = true;
          if (expression.kind === "set") value = frame.set!;
          else if (expression.kind === "list")
            value = {
              kind: "list",
              items: frame.results!.map((item) =>
                item.owned ? item.value : cloneCapturedSerializableValue(item.value),
              ),
            };
          else
            value = {
              kind: "object",
              properties: expression.properties.map((property, i) => ({
                name: property.name,
                value: frame.results![i]!.owned
                  ? frame.results![i]!.value
                  : cloneCapturedSerializableValue(frame.results![i]!.value),
              })),
            };
          break;
        }
        case "template":
          if (frame.stage === 1) {
            const part = expression.parts[frame.index - 1]!;
            if (part.kind === "expression")
              frame.text += this.visibleText(result.value, part.expression.span);
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
      throw fault("TSR003", "Only objects and speakers have assignable properties.", target.span);
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
      if (!isObject(object) && !isSpeakerReference(object)) {
        throw fault("TSR003", "Only objects and speakers have assignable properties.", target.span);
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
    if (!isList(receiver) && !isSet(receiver)) {
      throw fault("TSR016", `Unsupported method '${method}'.`, span);
    }
    const supported = isSet(receiver)
      ? new Set(["add", "remove", "clear", "contains", "toList"])
      : new Set(["add", "remove", "removeFirst", "removeLast", "clear", "contains", "toSet"]);
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
      color: optionalSpeakerString(speaker, "color", span),
      font: optionalSpeakerString(speaker, "font", span),
      avatar: optionalSpeakerString(speaker, "avatar", span),
    });
  }

  public visibleText(value: SerializableRuntimeValue, span: SourceSpan): string {
    return this.visibleTextWithRng(value, span, this.snapshot.rng);
  }

  public visibleTextWithRng(
    value: SerializableRuntimeValue,
    span: SourceSpan,
    rng: XorShift32State,
  ): string {
    if (isList(value)) {
      const selected = this.#randomItem(value.items, span, rng);
      if (typeof selected === "string") return selected;
      if (typeof selected === "number" && Number.isFinite(selected))
        return String(Object.is(selected, -0) ? 0 : selected);
      throw fault("TSR021", "This value cannot be converted implicitly to visible text.", span);
    }
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value))
      return String(Object.is(value, -0) ? 0 : value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (value === null) return "null";
    throw fault("TSR021", "This value cannot be converted implicitly to visible text.", span);
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
      try {
        const equal = serializableEquals(left, right);
        return expression.operator === "==" ? equal : !equal;
      } catch (error) {
        if (error instanceof RuntimeFault) throw error;
        throw this.#translateValueError(error, expression.span);
      }
    }
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

  #call(
    expression: Extract<ExpressionPlan, { kind: "call" }>,
    receiver: SerializableRuntimeValue,
    positional: SerializableRuntimeValue[],
    named: Record<string, SerializableRuntimeValue>,
  ): SerializableRuntimeValue {
    if (expression.callee.kind === "identifier") {
      const name = expression.callee.name;
      const coreBuiltin = name === "random" || name === "chance" || name === "randomInteger";
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
      try {
        return cloneSerializableValue(returned);
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
    }
    if (expression.callee.kind === "property") {
      return this.#callCollection(
        receiver!,
        expression.callee.name,
        positional,
        named,
        expression.span,
      );
    }
    throw fault(
      "TSR014",
      "Only injected built-ins and supported collection methods are callable.",
      expression.callee.span,
    );
  }

  #callCollection(
    receiver: SerializableRuntimeValue,
    name: string,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    span: SourceSpan,
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
          receiver.items.push(cloneCapturedSerializableValue(positional[0]!));
          return null;
        case "remove": {
          expect(1);
          const index = this.#findValue(receiver.items, positional[0]!, span);
          if (index >= 0) {
            const rebased = preparePreparedReferencesForListRemoval(this.snapshot, receiver, index);
            receiver.items.splice(index, 1);
            refreshPreparedReferenceFallbacks(this.snapshot, rebased);
          } else {
            this.#warn(
              "TSW002",
              "list.remove(value) found no matching value; the list was left unchanged.",
              span,
            );
          }
          return null;
        }
        case "removeFirst":
          expect(0);
          if (receiver.items.length > 0) {
            const rebased = preparePreparedReferencesForListRemoval(this.snapshot, receiver, 0);
            receiver.items.shift();
            refreshPreparedReferenceFallbacks(this.snapshot, rebased);
          }
          return null;
        case "removeLast":
          expect(0);
          if (receiver.items.length > 0) {
            const removedIndex = receiver.items.length - 1;
            const rebased = preparePreparedReferencesForListRemoval(
              this.snapshot,
              receiver,
              removedIndex,
            );
            receiver.items.pop();
            refreshPreparedReferenceFallbacks(this.snapshot, rebased);
          }
          return null;
        case "clear":
          expect(0);
          if (receiver.items.length > 0) {
            freezePreparedReferenceListDescendants(this.snapshot, receiver);
            receiver.items.length = 0;
          }
          return null;
        case "contains":
          expect(1);
          return this.#findValue(receiver.items, positional[0]!, span) >= 0;
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

  #findRandom(span: SourceSpan, rng = this.snapshot.rng): number {
    const random =
      this.capabilities.random === undefined
        ? nextXorShift32(rng)
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
    assertIntegerRange(range, call.span);
    const length = rangeLength(range);
    if (length < 1) {
      throw fault("TSR041", "randomInteger(range) requires a non-empty range.", call.span);
    }
    return range.start + Math.floor(this.#findRandom(call.span) * length);
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

  #findValue(
    items: readonly SerializableRuntimeValue[],
    value: SerializableRuntimeValue,
    span: SourceSpan,
  ): number {
    for (let index = 0; index < items.length; index += 1) {
      try {
        if (serializableEquals(items[index]!, value)) return index;
      } catch (error) {
        throw this.#translateValueError(error, span);
      }
    }
    return -1;
  }

  #randomItem(
    items: readonly SerializableRuntimeValue[],
    span: SourceSpan,
    rng = this.snapshot.rng,
  ): SerializableRuntimeValue {
    if (items.length === 0)
      throw fault("TSR019", "Cannot select '.random' from an empty collection.", span);
    return items[Math.floor(this.#findRandom(span, rng) * items.length)]!;
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
      const code =
        error.code === "setElement" ? "TSR032" : error.code === "equality" ? "TSR029" : "TSR031";
      return fault(code, error.message, span);
    }
    throw error;
  }
}

function optionalSpeakerString(
  speaker: RuntimeSpeakerSnapshot,
  name: string,
  span: SourceSpan,
): string | null {
  const value = speaker.properties.find((property) => property.name === name)?.value;
  if (value === undefined || value === null) return null;
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
  results: EvaluatedExpression[] | null;
  descriptor: PreparedReferenceDescriptor | null;
  epoch: number;
  text: string;
  set: SerializableRuntimeSet | null;
  membership: Set<SerializableRuntimeScalar> | null;
  positional: SerializableRuntimeValue[] | null;
  named: Record<string, SerializableRuntimeValue> | null;
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
