import type {
  AssignmentTargetPlan,
  BinaryExpressionPlan,
  ExpressionPlan,
  Instruction,
  InstructionPlan,
} from "../instructions.js";
import { validateInstructionPlan } from "../instructions.js";
import {
  createSourcePosition,
  createSourceSpan,
  type SourceSpan,
} from "../source.js";
import { RuntimeFault, type RuntimeErrorInfo } from "./errors.js";
import type {
  CompleteEvent,
  DeveloperWarningEvent,
  ExitEvent,
  InterpreterEvent,
  OutputSpeaker,
  RuntimeFailureEvent,
  SayEvent,
} from "./events.js";
import { nextXorShift32, type RandomSource } from "./random.js";
import {
  addSerializableSetValue,
  cloneSerializableValue,
  createSerializableList,
  createSerializableObject,
  createSerializableSet,
  getSerializableProperty,
  removeSerializableSetValue,
  serializableSetContains,
  serializableEquals,
  SerializableValueError,
  setSerializableProperty,
  validateSerializableValue,
  type SerializableRuntimeList,
  type SerializableRuntimeObject,
  type SerializableRuntimeRange,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
  type SerializableSpeakerReference,
} from "./serializable-values.js";
import {
  cloneRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeBindingSnapshot,
  type RuntimeSnapshot,
  type RuntimeSpeakerSnapshot,
  type RuntimeLoopFrameSnapshot,
  type RuntimeCallFrameSnapshot,
  type RuntimeTemporarySnapshot,
} from "./state.js";

export interface RuntimeCapabilityCall {
  readonly positional: readonly SerializableRuntimeValue[];
  readonly named: Readonly<Record<string, SerializableRuntimeValue>>;
  readonly span: SourceSpan;
}

export type RuntimeBuiltinFunction = (
  call: RuntimeCapabilityCall,
) => SerializableRuntimeValue;

export interface RuntimeCapabilities {
  readonly builtins?: Readonly<Record<string, RuntimeBuiltinFunction>>;
  /** Compatibility/testing override. Serializable xorshift32 is used otherwise. */
  readonly random?: RandomSource;
}

export interface RuntimeOperationResult {
  readonly snapshot: RuntimeSnapshot;
  readonly events: readonly InterpreterEvent[];
  readonly instructionsExecuted: number;
}

export interface RuntimeRunOptions {
  readonly instructionBudget?: number;
}

export class RuntimeDataError extends Error {
  public constructor(
    readonly code: "TSR100" | "TSR101",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeDataError";
  }

  public toInfo(): Readonly<{ code: string; message: string }> {
    return Object.freeze({ code: this.code, message: this.message });
  }
}

export function executeInstruction(
  plan: InstructionPlan,
  inputSnapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
): RuntimeOperationResult {
  assertExecutableData(plan, inputSnapshot);
  const snapshot = cloneRuntimeSnapshot(inputSnapshot);
  if (snapshot.status === "halted" || snapshot.status === "failed") {
    return result(snapshot, [], 0);
  }
  const instruction = plan.instructions[snapshot.nextInstruction];
  if (instruction === undefined) {
    snapshot.status = "halted";
    return result(snapshot, [], 0);
  }

  snapshot.status = "running";
  const events: InterpreterEvent[] = [];
  const evaluator = new Evaluator(snapshot, capabilities);
  try {
    executePlannedInstruction(plan, instruction, snapshot, evaluator, events);
    if (
      snapshot.status === "running" &&
      snapshot.callFrames.length === 0 &&
      snapshot.nextInstruction === plan.rootEndInstruction
    ) {
      snapshot.status = "halted";
      events.push(createCompleteEvent(snapshot, instruction.span));
    }
  } catch (error) {
    if (!(error instanceof RuntimeFault)) throw error;
    failSnapshot(snapshot, error.toInfo(), events);
  } finally {
    snapshot.contextualSpeaker = null;
  }
  return result(snapshot, events, 1);
}

export function stepToEvent(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: RuntimeRunOptions = {},
): RuntimeOperationResult {
  const budget = instructionBudget(options.instructionBudget);
  let current = cloneRuntimeSnapshot(snapshot);
  const events: InterpreterEvent[] = [];
  let instructionsExecuted = 0;
  while (
    current.status !== "halted" &&
    current.status !== "failed" &&
    events.length === 0
  ) {
    if (instructionsExecuted >= budget) {
      const budgetResult = failForBudget(plan, current);
      events.push(...budgetResult.events);
      current = budgetResult.snapshot;
      break;
    }
    const operation = executeInstruction(plan, current, capabilities);
    current = operation.snapshot;
    instructionsExecuted += operation.instructionsExecuted;
    events.push(...operation.events);
  }
  return result(current, events, instructionsExecuted);
}

export function run(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  capabilities: RuntimeCapabilities = {},
  options: RuntimeRunOptions = {},
): RuntimeOperationResult {
  const budget = instructionBudget(options.instructionBudget);
  let current = cloneRuntimeSnapshot(snapshot);
  const events: InterpreterEvent[] = [];
  let instructionsExecuted = 0;
  while (current.status !== "halted" && current.status !== "failed") {
    if (instructionsExecuted >= budget) {
      const budgetResult = failForBudget(plan, current);
      current = budgetResult.snapshot;
      events.push(...budgetResult.events);
      break;
    }
    const operation = executeInstruction(plan, current, capabilities);
    current = operation.snapshot;
    instructionsExecuted += operation.instructionsExecuted;
    events.push(...operation.events);
  }
  return result(current, events, instructionsExecuted);
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
      if (findBinding(snapshot, instruction.name) !== undefined) {
        throw fault("TSR001", `Speaker '${instruction.name}' is already visible in this scope.`, instruction.span);
      }
      const speaker: RuntimeSpeakerSnapshot = {
        id: snapshot.nextSpeakerId,
        identifier: instruction.name,
        properties: [],
      };
      snapshot.nextSpeakerId += 1;
      snapshot.speakers.push(speaker);
      currentFrame(snapshot).bindings.push({
        name: instruction.name,
        value: {
          kind: "speakerReference",
          speakerId: speaker.id,
          identifier: instruction.name,
        },
      });
      snapshot.contextualSpeaker = speaker.id;
      for (const property of instruction.properties) {
        if (speaker.properties.some((item) => item.name === property.name)) {
          throw fault("TSR007", `Duplicate speaker property '${property.name}'.`, property.span);
        }
        speaker.properties.push({
          name: property.name,
          value: cloneSerializableValue(evaluator.evaluate(property.value)),
        });
      }
      advance(snapshot);
      return;
    }
    case "setDeclaredSpeakerProperty": {
      const speaker = evaluator.speakerByName(instruction.speaker, instruction.span);
      if (speaker.properties.some((property) => property.name === instruction.name)) {
        throw fault("TSR007", `Duplicate speaker property '${instruction.name}'.`, instruction.span);
      }
      snapshot.contextualSpeaker = speaker.id;
      speaker.properties.push({
        name: instruction.name,
        value: cloneSerializableValue(evaluator.evaluate(instruction.value)),
      });
      advance(snapshot);
      return;
    }
    case "setDefaultSpeaker": {
      const speaker = evaluator.speakerByName(instruction.name, instruction.span);
      snapshot.defaultSpeaker = speaker.id;
      advance(snapshot);
      return;
    }
    case "enterScope":
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
        throw fault("TSR001", `Variable '${instruction.name}' is already visible in this scope.`, instruction.span);
      }
      currentFrame(snapshot).bindings.push({
        name: instruction.name,
        value: cloneSerializableValue(evaluator.evaluate(instruction.value)),
      });
      advance(snapshot);
      return;
    }
    case "prepareReference":
      setTemporary(
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
      snapshot.nextInstruction = condition
        ? snapshot.nextInstruction + 1
        : instruction.target;
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
      setTemporary(snapshot.temporaries, instruction.temporaryId, value);
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
    case "callFunction":
      enterFunction(plan, instruction, snapshot);
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
      const speaker =
        instruction.speaker !== null
          ? evaluator.speakerByName(instruction.speaker, instruction.span)
          : snapshot.defaultSpeaker === null
            ? null
            : evaluator.speakerById(snapshot.defaultSpeaker, instruction.span);
      snapshot.contextualSpeaker = speaker?.id ?? null;
      const text = evaluator.visibleText(evaluator.evaluate(instruction.value), instruction.value.span);
      const output = speaker === null ? null : evaluator.outputSpeaker(speaker, instruction.span, events);
      events.push(
        Object.freeze({
          kind: "say",
          sequence: takeSequence(snapshot),
          speaker: output,
          text,
          span: copySpan(instruction.span),
        } satisfies SayEvent),
      );
      advance(snapshot);
      return;
    }
    case "exit":
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
}

function enterFunction(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "callFunction" }>,
  snapshot: RuntimeSnapshot,
): void {
  const definition = functionDefinition(plan, instruction.functionId, instruction.span);
  if (snapshot.callFrames.length >= snapshot.maxCallDepth) {
    throw fault(
      "TSR047",
      `Maximum TeaseScript call depth of ${snapshot.maxCallDepth} exceeded.`,
      instruction.span,
    );
  }
  const supplied = new Map(
    instruction.arguments.map((argument) => [
      argument.parameterName,
      cloneSerializableValue(
        readTemporary(snapshot.temporaries, argument.temporaryId, argument.span),
      ),
    ]),
  );
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
        : {
            parameterName: parameter.name,
            supplied: true as const,
            value,
          };
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
  frame.parameterState = {
    phase: "body",
    parameterIndex: definition.parameters.length,
  };
  advance(snapshot);
}

function returnFromFunction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): void {
  const { frame } = activeFunction(plan, snapshot, span);
  const returned = cloneSerializableValue(value);
  snapshot.frames.splice(frame.scopeBaseDepth);
  snapshot.loopFrames.splice(frame.loopBaseDepth);
  snapshot.callFrames.pop();
  snapshot.temporaries.splice(
    0,
    snapshot.temporaries.length,
    ...frame.callerTemporaries.map(cloneTemporary),
  );
  if (
    snapshot.temporaries.some(
      (temporary) => temporary.id === frame.destinationTemporary,
    )
  ) {
    throw fault("TSR050", "Function result destination is already occupied.", span);
  }
  snapshot.temporaries.push({
    id: frame.destinationTemporary,
    value: returned,
  });
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
  return {
    frame,
    definition: functionDefinition(plan, frame.functionId, span),
  };
}

function functionDefinition(
  plan: InstructionPlan,
  functionId: number,
  span: SourceSpan,
): InstructionPlan["functions"][number] {
  const definition = plan.functions.find((item) => item.id === functionId);
  if (definition === undefined) {
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
  currentFrame(snapshot).bindings.push({
    name,
    value: cloneSerializableValue(value),
  });
}

function executeLoopStart(
  instruction: Extract<Instruction, { kind: "loopStart" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
): void {
  let frame = snapshot.loopFrames.at(-1);
  if (frame?.loopId !== instruction.loopId) {
    if (snapshot.loopFrames.some((item) => item.loopId === instruction.loopId)) {
      throw fault("TSR042", "Loop-frame nesting does not match the instruction plan.", instruction.span);
    }
    const scopeDepth = snapshot.frames.length;
    if (instruction.loopKind === "repeat") {
      const value = evaluator.evaluate(instruction.expression);
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      ) {
        throw fault("TSR043", "repeat requires a non-negative integer count.", instruction.expression.span);
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
        throw fault("TSR044", "for requires a list, set, or range source.", instruction.expression.span);
      }
      if (isRange(source)) assertIntegerRange(source, instruction.expression.span);
      frame = {
        kind: "for",
        loopId: instruction.loopId,
        scopeDepth,
        variable: instruction.variable,
        source: cloneSerializableValue(source) as Extract<RuntimeLoopFrameSnapshot, { kind: "for" }>["source"],
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
    throw fault("TSR042", "Loop scope state does not match the next instruction.", instruction.span);
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
    { name: frame.variable, value: cloneSerializableValue(value) },
  ]);
  advance(snapshot);
}

function executeLoopControl(
  instruction: Extract<Instruction, { kind: "loopControl" }>,
  snapshot: RuntimeSnapshot,
): void {
  const frame = snapshot.loopFrames.at(-1);
  if (frame === undefined || frame.loopId !== instruction.loopId) {
    throw fault("TSR042", "Loop control does not match the active innermost loop.", instruction.span);
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

function pushIterationScope(
  snapshot: RuntimeSnapshot,
  bindings: RuntimeBindingSnapshot[],
): void {
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

class Evaluator {
  readonly #builtins: Readonly<Record<string, RuntimeBuiltinFunction>>;

  public constructor(
    private readonly snapshot: RuntimeSnapshot,
    private readonly capabilities: RuntimeCapabilities,
  ) {
    this.#builtins = {
      ...(capabilities.builtins ?? {}),
      random: (call) => this.#randomBuiltin(call),
      chance: (call) => this.#chanceBuiltin(call),
      randomInteger: (call) => this.#randomIntegerBuiltin(call),
    };
  }

  public evaluate(expression: ExpressionPlan): SerializableRuntimeValue {
    switch (expression.kind) {
      case "literal":
        return expression.value;
      case "identifier": {
        if (expression.name === "speaker" && this.snapshot.contextualSpeaker !== null) {
          const speaker = this.speakerById(
            this.snapshot.contextualSpeaker,
            expression.span,
          );
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
        return readTemporary(
          this.snapshot.temporaries,
          expression.temporaryId,
          expression.span,
        );
      case "preparedReference":
        return this.#resolvePreparedReference(
          readTemporary(
            this.snapshot.temporaries,
            expression.temporaryId,
            expression.span,
          ),
          expression.span,
        );
      case "list":
        return createSerializableList(expression.elements.map((item) => this.evaluate(item)));
      case "set": {
        const set = createSerializableSet([]);
        for (const element of expression.elements) {
          try {
            addSerializableSetValue(set, this.evaluate(element));
          } catch (error) {
            throw this.#translateValueError(error, element.span);
          }
        }
        return set;
      }
      case "object": {
        const names = new Set<string>();
        for (const property of expression.properties) {
          if (names.has(property.name)) {
            throw fault("TSR007", `Duplicate object property '${property.name}'.`, property.span);
          }
          names.add(property.name);
        }
        return createSerializableObject(
          expression.properties.map((property) => ({
            name: property.name,
            value: this.evaluate(property.value),
          })),
        );
      }
      case "group":
        return this.evaluate(expression.expression);
      case "template": {
        let text = "";
        for (const part of expression.parts) {
          text +=
            part.kind === "text"
              ? part.value
              : this.visibleText(this.evaluate(part.expression), part.expression.span);
        }
        return text;
      }
      case "property":
        return this.#getProperty(this.evaluate(expression.object), expression.name, expression.span);
      case "index": {
        const object = this.evaluate(expression.object);
        if (isSet(object)) throw fault("TSR004", "Sets are not indexable.", expression.span);
        if (!isList(object)) {
          throw fault("TSR008", "Only lists support numeric indexing.", expression.span);
        }
        const index = this.#index(this.evaluate(expression.index), expression.index.span);
        this.#assertIndex(object, index, expression.index.span);
        return object.items[index]!;
      }
      case "call":
        return this.#call(expression);
      case "unary": {
        const operand = this.evaluate(expression.operand);
        if (expression.operator === "not") {
          if (typeof operand !== "boolean") throw fault("TSR026", "Expected a boolean value.", expression.operand.span);
          return !operand;
        }
        const number = this.#number(operand, expression.operand.span);
        return this.#finite(expression.operator === "+" ? number : -number, expression.span);
      }
      case "binary":
        return this.#binary(expression);
      case "range": {
        const start = this.#number(this.evaluate(expression.start), expression.start.span);
        const end = this.#number(this.evaluate(expression.end), expression.end.span);
        return { kind: "range", start, end, inclusive: expression.inclusive };
      }
    }
  }

  public assign(target: AssignmentTargetPlan, value: SerializableRuntimeValue): void {
    const copied = cloneSerializableValue(value);
    if (target.kind === "identifier") {
      const location = findBindingLocation(this.snapshot, target.name);
      if (location === undefined) {
        throw fault("TSR002", `Cannot assign to unknown variable '${target.name}'.`, target.span);
      }
      if (isSpeakerReference(location.binding.value)) {
        throw fault("TSR034", `Cannot replace speaker '${target.name}'.`, target.span);
      }
      detachPreparedReferencesForMutation(
        this.snapshot,
        {
          rootFrameId: location.frame.id,
          rootName: target.name,
          path: [],
        },
      );
      location.binding.value = copied;
      return;
    }
    const object = this.evaluate(target.object);
    const receiverDescriptor =
      target.object.kind === "preparedReference"
        ? readPreparedReference(
            readTemporary(
              this.snapshot.temporaries,
              target.object.temporaryId,
              target.object.span,
            ),
            target.object.span,
          )
        : null;
    if (target.kind === "property") {
      if (receiverDescriptor !== null && !receiverDescriptor.detached) {
        const mutationStep: PreparedReferenceStep = {
          kind: "property",
          name: target.name,
        };
        detachPreparedReferencesForMutation(this.snapshot, {
          rootFrameId: receiverDescriptor.rootFrameId,
          rootName: receiverDescriptor.rootName,
          path: [...receiverDescriptor.path, mutationStep],
          speakerPath: preparedReferenceSpeakerPath(
            this.snapshot,
            receiverDescriptor,
            [mutationStep],
          ),
        });
      }
      if (isObject(object)) {
        setSerializableProperty(object, target.name, copied);
        return;
      }
      if (isSpeakerReference(object)) {
        setSpeakerProperty(this.speakerById(object.speakerId, target.span), target.name, copied);
        return;
      }
      throw fault("TSR003", "Only objects and speakers have assignable properties.", target.span);
    }
    if (isSet(object)) throw fault("TSR004", "Sets are not indexable.", target.span);
    if (!isList(object)) throw fault("TSR005", "Only lists have assignable numeric indexes.", target.span);
    const index = this.#index(this.evaluate(target.index), target.index.span);
    this.#assertIndex(object, index, target.index.span);
    if (receiverDescriptor !== null && !receiverDescriptor.detached) {
      const mutationStep: PreparedReferenceStep = { kind: "index", index };
      detachPreparedReferencesForMutation(this.snapshot, {
        rootFrameId: receiverDescriptor.rootFrameId,
        rootName: receiverDescriptor.rootName,
        path: [...receiverDescriptor.path, mutationStep],
        speakerPath: preparedReferenceSpeakerPath(
          this.snapshot,
          receiverDescriptor,
          [mutationStep],
        ),
      });
    }
    object.items[index] = copied;
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
      : new Set([
          "add",
          "remove",
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
    if (expression.kind === "group") {
      return this.#buildPreparedReference(expression.expression);
    }
    if (expression.kind === "identifier") {
      const location = findBindingLocation(this.snapshot, expression.name);
      if (location === undefined) {
        throw fault("TSR006", `Unknown identifier '${expression.name}'.`, expression.span);
      }
      return {
        rootFrameId: location.frame.id,
        rootName: expression.name,
        path: [],
        capturedRoot: cloneSerializableValue(location.binding.value),
        detached: false,
      };
    }
    if (expression.kind === "property") {
      const descriptor = this.#buildPreparedReference(expression.object);
      const base = this.#resolveDescriptor(descriptor, expression.object.span);
      if ((isList(base) || isSet(base)) && ["first", "last", "random"].includes(expression.name)) {
        if (base.items.length === 0) {
          throw fault(
            expression.name === "random" ? "TSR019" : "TSR018",
            `Cannot read '.${expression.name}' from an empty collection.`,
            expression.span,
          );
        }
        const index = expression.name === "first"
          ? 0
          : expression.name === "last"
            ? base.items.length - 1
            : Math.floor(this.#findRandom(expression.span) * base.items.length);
        descriptor.path.push({ kind: "index", index });
      } else {
        descriptor.path.push({ kind: "property", name: expression.name });
      }
      this.#resolveDescriptor(descriptor, expression.span);
      return descriptor;
    }
    if (expression.kind === "index") {
      const descriptor = this.#buildPreparedReference(expression.object);
      const object = this.#resolveDescriptor(descriptor, expression.object.span);
      if (isSet(object)) throw fault("TSR004", "Sets are not indexable.", expression.span);
      if (!isList(object)) {
        throw fault("TSR008", "Only lists support numeric indexing.", expression.span);
      }
      const index = this.#index(this.evaluate(expression.index), expression.index.span);
      this.#assertIndex(object, index, expression.index.span);
      descriptor.path.push({ kind: "index", index });
      return descriptor;
    }
    if (expression.kind === "preparedReference") {
      return readPreparedReference(
        readTemporary(this.snapshot.temporaries, expression.temporaryId, expression.span),
        expression.span,
      );
    }
    const value = this.evaluate(expression);
    return {
      rootFrameId: null,
      rootName: null,
      path: [],
      capturedRoot: cloneSerializableValue(value),
      detached: true,
    };
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
      setSerializableProperty(serialized, "detached", true);
      return this.#resolveDescriptor({ ...descriptor, detached: true }, span);
    }
  }

  #resolveDescriptor(
    descriptor: PreparedReferenceDescriptor,
    span: SourceSpan,
  ): SerializableRuntimeValue {
    let value: SerializableRuntimeValue;
    if (
      !descriptor.detached &&
      descriptor.rootFrameId !== null &&
      descriptor.rootName !== null
    ) {
      const frame = this.snapshot.frames.find(
        (candidate) => candidate.id === descriptor.rootFrameId,
      );
      const binding = frame?.bindings.find(
        (candidate) => candidate.name === descriptor.rootName,
      );
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
        throw fault("TSR022", `Speaker '${speaker.identifier}' has no resolvable display name.`, span);
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
      this.snapshot.warnedSpeakerIds.push(speaker.id);
      events.push(
        Object.freeze({
          kind: "developerWarning",
          sequence: takeSequence(this.snapshot),
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
    if (isList(value)) return this.visibleText(this.#randomItem(value.items, span), span);
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (value === null) return "null";
    throw fault("TSR021", "This value cannot be converted implicitly to visible text.", span);
  }

  #binary(expression: BinaryExpressionPlan): SerializableRuntimeValue {
    const left = this.evaluate(expression.left);
    if (expression.operator === "and") {
      if (typeof left !== "boolean") throw fault("TSR026", "Expected a boolean value.", expression.left.span);
      if (!left) return false;
      const right = this.evaluate(expression.right);
      if (typeof right !== "boolean") throw fault("TSR026", "Expected a boolean value.", expression.right.span);
      return right;
    }
    if (expression.operator === "or") {
      if (typeof left !== "boolean") throw fault("TSR026", "Expected a boolean value.", expression.left.span);
      if (left) return true;
      const right = this.evaluate(expression.right);
      if (typeof right !== "boolean") throw fault("TSR026", "Expected a boolean value.", expression.right.span);
      return right;
    }
    const right = this.evaluate(expression.right);
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
        throw fault("TSR009", "Comparison operands must both be numbers or both be strings.", expression.span);
      }
      if (expression.operator === "<") return left < right;
      if (expression.operator === "<=") return left <= right;
      if (expression.operator === ">") return left > right;
      return left >= right;
    }
    const leftNumber = this.#number(left, expression.left.span);
    const rightNumber = this.#number(right, expression.right.span);
    switch (expression.operator) {
      case "+": return this.#finite(leftNumber + rightNumber, expression.span);
      case "-": return this.#finite(leftNumber - rightNumber, expression.span);
      case "*": return this.#finite(leftNumber * rightNumber, expression.span);
      case "/": return this.#finite(leftNumber / rightNumber, expression.span);
      case "%": return this.#finite(leftNumber % rightNumber, expression.span);
      default: throw fault("TSR035", "Unsupported binary operation.", expression.span);
    }
  }

  #call(expression: Extract<ExpressionPlan, { kind: "call" }>): SerializableRuntimeValue {
    const propertyCallee = expression.callee.kind === "property"
      ? expression.callee
      : null;
    const receiverDescriptor = propertyCallee === null
      ? null
      : this.#buildPreparedReference(propertyCallee.object);
    const receiver = receiverDescriptor === null || propertyCallee === null
      ? null
      : this.#resolveDescriptor(receiverDescriptor, propertyCallee.object.span);
    const positional: SerializableRuntimeValue[] = [];
    const named: Record<string, SerializableRuntimeValue> = {};
    for (const argument of expression.arguments) {
      const value = cloneSerializableValue(this.evaluate(argument.value));
      if (argument.kind === "positional") positional.push(value);
      else {
        if (Object.hasOwn(named, argument.name)) {
          throw fault("TSR010", `Duplicate named argument '${argument.name}'.`, argument.span);
        }
        named[argument.name] = value;
      }
    }
    if (expression.callee.kind === "identifier") {
      const builtin = this.#builtins[expression.callee.name];
      if (builtin === undefined) {
        throw fault("TSR011", `Unknown built-in function '${expression.callee.name}'.`, expression.callee.span);
      }
      let returned: SerializableRuntimeValue;
      try {
        returned = builtin(Object.freeze({
          positional: Object.freeze(positional),
          named: Object.freeze(named),
          span: copySpan(expression.span),
        }));
      } catch (error) {
        if (error instanceof SerializableValueError) {
          const code =
            error.code === "cyclic"
              ? "TSR031"
              : error.code === "setElement"
                ? "TSR032"
                : "TSR013";
          throw fault(code, error.message, expression.span);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw fault("TSR012", `Built-in '${expression.callee.name}' failed: ${message}`, expression.span);
      }
      const failure = validateSerializableValue(returned);
      if (failure !== null) {
        throw fault("TSR013", `Built-in '${expression.callee.name}' returned an invalid value: ${failure}`, expression.span);
      }
      return cloneSerializableValue(returned);
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
    throw fault("TSR014", "Only injected built-ins and supported collection methods are callable.", expression.callee.span);
  }

  #callCollection(
    receiver: SerializableRuntimeValue,
    name: string,
    positional: readonly SerializableRuntimeValue[],
    named: Readonly<Record<string, SerializableRuntimeValue>>,
    span: SourceSpan,
  ): SerializableRuntimeValue {
    if (!isList(receiver) && !isSet(receiver)) throw fault("TSR016", `Unsupported method '${name}'.`, span);
    if (Object.keys(named).length !== 0) throw fault("TSR015", "Collection methods accept positional arguments only.", span);
    const expect = (count: number): void => {
      if (positional.length !== count) throw fault("TSR028", `Expected ${count} positional argument(s), received ${positional.length}.`, span);
    };
    try {
      if (isSet(receiver)) {
        switch (name) {
          case "add": expect(1); addSerializableSetValue(receiver, positional[0]!); return null;
          case "remove": expect(1); removeSerializableSetValue(receiver, positional[0]!); return null;
          case "clear": expect(0); receiver.items.length = 0; return null;
          case "contains": expect(1); return serializableSetContains(receiver, positional[0]!);
          case "toList": expect(0); return createSerializableList(receiver.items);
          default: throw fault("TSR016", `Unsupported method '${name}'.`, span);
        }
      }
      switch (name) {
        case "add": expect(1); receiver.items.push(cloneSerializableValue(positional[0]!)); return null;
        case "remove": {
          expect(1);
          const index = this.#findValue(receiver.items, positional[0]!, span);
          if (index >= 0) {
            const rebased = preparePreparedReferencesForListRemoval(
              this.snapshot,
              receiver,
              index,
            );
            receiver.items.splice(index, 1);
            refreshPreparedReferenceFallbacks(this.snapshot, rebased);
          }
          return null;
        }
        case "removeFirst":
          expect(0);
          if (receiver.items.length > 0) {
            const rebased = preparePreparedReferencesForListRemoval(
              this.snapshot,
              receiver,
              0,
            );
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
        case "contains": expect(1); return this.#findValue(receiver.items, positional[0]!, span) >= 0;
        case "toSet": expect(0); return createSerializableSet(receiver.items);
        default: throw fault("TSR016", `Unsupported method '${name}'.`, span);
      }
    } catch (error) {
      if (error instanceof RuntimeFault) throw error;
      throw this.#translateValueError(error, span);
    }
  }

  #getCollectionProperty(
    value: SerializableRuntimeList | SerializableRuntimeSet,
    name: string,
    span: SourceSpan,
  ): SerializableRuntimeValue {
    if (name === "length") return value.items.length;
    if (name === "first" || name === "last") {
      if (value.items.length === 0) throw fault("TSR018", `Cannot read '.${name}' from an empty collection.`, span);
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
    const random = this.capabilities.random?.next() ?? nextXorShift32(this.snapshot.rng);
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
      throw fault(
        "TSR040",
        "randomInteger(range) requires a range value.",
        call.span,
      );
    }
    assertIntegerRange(range, call.span);
    const length = rangeLength(range);
    if (length < 1) {
      throw fault("TSR041", "randomInteger(range) requires a non-empty range.", call.span);
    }
    return range.start + Math.floor(this.#findRandom(call.span) * length);
  }

  #expectBuiltinArguments(
    name: string,
    call: RuntimeCapabilityCall,
    count: number,
  ): void {
    if (
      call.positional.length !== count ||
      Object.keys(call.named).length !== 0
    ) {
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
  ): SerializableRuntimeValue {
    if (items.length === 0) throw fault("TSR019", "Cannot select '.random' from an empty collection.", span);
    return items[Math.floor(this.#findRandom(span) * items.length)]!;
  }

  #getProperty(value: SerializableRuntimeValue, name: string, span: SourceSpan): SerializableRuntimeValue {
    if (isObject(value)) return this.#getObjectProperty(value, name, span);
    if (isSpeakerReference(value)) {
      return this.#getSpeakerProperty(
        this.speakerById(value.speakerId, span),
        name,
        span,
      );
    }
    if (isList(value) || isSet(value)) return this.#getCollectionProperty(value, name, span);
    throw fault("TSR017", `Value has no property '${name}'.`, span);
  }

  #index(value: SerializableRuntimeValue, span: SourceSpan): number {
    if (typeof value !== "number" || !Number.isInteger(value)) throw fault("TSR024", "A list index must be an integer.", span);
    return value;
  }

  #assertIndex(list: SerializableRuntimeList, index: number, span: SourceSpan): void {
    if (index < 0 || index >= list.items.length) throw fault("TSR025", `List index ${index} is outside the valid range.`, span);
  }

  #number(value: SerializableRuntimeValue, span: SourceSpan): number {
    if (typeof value !== "number") throw fault("TSR027", "Expected a numeric value.", span);
    return value;
  }

  #finite(value: number, span: SourceSpan): number {
    if (!Number.isFinite(value)) throw fault("TSR036", "Numeric operation produced a non-finite result.", span);
    return value;
  }

  #translateValueError(error: unknown, span: SourceSpan): RuntimeFault {
    if (error instanceof SerializableValueError) {
      const code = error.code === "setElement" ? "TSR032" : error.code === "equality" ? "TSR029" : "TSR031";
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
  if (typeof value !== "string") throw fault("TSR030", `Speaker property '${name}' must be a string for output.`, span);
  return value;
}

function setSpeakerProperty(
  speaker: RuntimeSpeakerSnapshot,
  name: string,
  value: SerializableRuntimeValue,
): void {
  const property = speaker.properties.find((item) => item.name === name);
  if (property === undefined) speaker.properties.push({ name, value: cloneSerializableValue(value) });
  else property.value = cloneSerializableValue(value);
}

function findBinding(snapshot: RuntimeSnapshot, name: string): RuntimeBindingSnapshot | undefined {
  return findBindingLocation(snapshot, name)?.binding;
}

function findBindingLocation(
  snapshot: RuntimeSnapshot,
  name: string,
): {
  readonly frame: RuntimeSnapshot["frames"][number];
  readonly binding: RuntimeBindingSnapshot;
} | undefined {
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

type PreparedReferenceStep =
  | { readonly kind: "property"; readonly name: string }
  | { readonly kind: "index"; readonly index: number };

interface PreparedReferenceDescriptor {
  readonly rootFrameId: number | null;
  readonly rootName: string | null;
  readonly path: PreparedReferenceStep[];
  readonly capturedRoot: SerializableRuntimeValue;
  readonly detached: boolean;
}

interface PreparedReferenceMutation {
  readonly rootFrameId: number | null;
  readonly rootName: string | null;
  readonly path: readonly PreparedReferenceStep[];
  readonly speakerPath?: PreparedSpeakerPath | null;
}

interface PreparedSpeakerPath {
  readonly speakerId: number;
  readonly path: readonly PreparedReferenceStep[];
}

const INTERNAL_REFERENCE_POSITION = createSourcePosition(0, 0, 0);
const INTERNAL_REFERENCE_SPAN = createSourceSpan(
  INTERNAL_REFERENCE_POSITION,
  INTERNAL_REFERENCE_POSITION,
);

function serializePreparedReference(
  descriptor: PreparedReferenceDescriptor,
): SerializableRuntimeObject {
  return createSerializableObject([
    { name: "marker", value: "preparedReference" },
    { name: "rootFrameId", value: descriptor.rootFrameId },
    { name: "rootName", value: descriptor.rootName },
    {
      name: "path",
      value: serializePreparedReferencePath(descriptor.path),
    },
    { name: "capturedRoot", value: descriptor.capturedRoot },
    { name: "detached", value: descriptor.detached },
  ]);
}

function serializePreparedReferencePath(
  path: readonly PreparedReferenceStep[],
): SerializableRuntimeList {
  return createSerializableList(
    path.map((step) =>
      step.kind === "property"
        ? createSerializableObject([
            { name: "kind", value: "property" },
            { name: "name", value: step.name },
          ])
        : createSerializableObject([
            { name: "kind", value: "index" },
            { name: "index", value: step.index },
          ]),
    ),
  );
}

function readPreparedReference(
  value: SerializableRuntimeValue,
  span: SourceSpan,
): PreparedReferenceDescriptor {
  if (!isObject(value)) {
    throw fault("TSR053", "Prepared reference state is malformed.", span);
  }
  const marker = getSerializableProperty(value, "marker");
  const rootFrameId = getSerializableProperty(value, "rootFrameId");
  const rootName = getSerializableProperty(value, "rootName");
  const pathValue = getSerializableProperty(value, "path");
  const capturedRoot = getSerializableProperty(value, "capturedRoot");
  const detached = getSerializableProperty(value, "detached");
  if (
    marker !== "preparedReference" ||
    (rootFrameId !== null &&
      (typeof rootFrameId !== "number" || !Number.isInteger(rootFrameId))) ||
    (rootName !== null && (typeof rootName !== "string" || rootName.length === 0)) ||
    (rootFrameId === null) !== (rootName === null) ||
    pathValue === undefined ||
    !isList(pathValue) ||
    capturedRoot === undefined ||
    typeof detached !== "boolean"
  ) {
    throw fault("TSR053", "Prepared reference state is malformed.", span);
  }
  const captured = capturedRoot as SerializableRuntimeValue;
  const path: PreparedReferenceStep[] = [];
  for (const item of pathValue.items) {
    if (!isObject(item)) {
      throw fault("TSR053", "Prepared reference path is malformed.", span);
    }
    const kind = getSerializableProperty(item, "kind");
    if (kind === "property") {
      const name = getSerializableProperty(item, "name");
      if (typeof name !== "string" || name.length === 0) {
        throw fault("TSR053", "Prepared reference property path is malformed.", span);
      }
      path.push({ kind, name });
      continue;
    }
    if (kind === "index") {
      const index = getSerializableProperty(item, "index");
      if (typeof index !== "number" || !Number.isInteger(index)) {
        throw fault("TSR053", "Prepared reference index path is malformed.", span);
      }
      path.push({ kind, index });
      continue;
    }
    throw fault("TSR053", "Prepared reference path kind is malformed.", span);
  }
  return {
    rootFrameId,
    rootName,
    path,
    capturedRoot: captured,
    detached,
  };
}

function detachPreparedReferencesForMutation(
  snapshot: RuntimeSnapshot,
  mutation: PreparedReferenceMutation,
): void {
  if (mutation.rootFrameId === null || mutation.rootName === null) return;
  for (const temporaries of allTemporaryCollections(snapshot)) {
    for (const temporary of temporaries) {
      if (!isObject(temporary.value)) continue;
      let descriptor: PreparedReferenceDescriptor;
      try {
        descriptor = readPreparedReference(temporary.value, INTERNAL_REFERENCE_SPAN);
      } catch {
        continue;
      }
      if (
        descriptor.detached ||
        !preparedReferenceMutationMatches(
          snapshot,
          descriptor,
          mutation,
          false,
        )
      ) {
        continue;
      }
      freezePreparedReference(snapshot, temporary.value, descriptor);
    }
  }
}

function preparePreparedReferencesForListRemoval(
  snapshot: RuntimeSnapshot,
  receiver: SerializableRuntimeList,
  removedIndex: number,
): SerializableRuntimeObject[] {
  const rebased: SerializableRuntimeObject[] = [];
  for (const temporaries of allTemporaryCollections(snapshot)) {
    for (const temporary of temporaries) {
      if (!isObject(temporary.value)) continue;
      let descriptor: PreparedReferenceDescriptor;
      try {
        descriptor = readPreparedReference(temporary.value, INTERNAL_REFERENCE_SPAN);
      } catch {
        continue;
      }
      if (descriptor.detached) continue;
      const pathIndex = preparedReferenceListIndexPosition(
        snapshot,
        descriptor,
        receiver,
      );
      if (pathIndex === null) continue;
      const step = descriptor.path[pathIndex];
      if (step?.kind !== "index") continue;
      if (step.index === removedIndex) {
        freezePreparedReference(snapshot, temporary.value, descriptor);
        continue;
      }
      if (step.index < removedIndex) continue;
      descriptor.path[pathIndex] = { kind: "index", index: step.index - 1 };
      setSerializableProperty(
        temporary.value,
        "path",
        serializePreparedReferencePath(descriptor.path),
      );
      rebased.push(temporary.value);
    }
  }
  return rebased;
}

function refreshPreparedReferenceFallbacks(
  snapshot: RuntimeSnapshot,
  references: readonly SerializableRuntimeObject[],
): void {
  for (const serialized of references) {
    let descriptor: PreparedReferenceDescriptor;
    try {
      descriptor = readPreparedReference(serialized, INTERNAL_REFERENCE_SPAN);
    } catch {
      continue;
    }
    if (descriptor.detached) continue;
    const root = preparedReferenceRoot(snapshot, descriptor);
    if (!root.found) {
      freezePreparedReference(snapshot, serialized, descriptor);
      continue;
    }
    setSerializableProperty(serialized, "capturedRoot", root.value);
  }
}

function freezePreparedReferenceListDescendants(
  snapshot: RuntimeSnapshot,
  receiver: SerializableRuntimeList,
): void {
  for (const temporaries of allTemporaryCollections(snapshot)) {
    for (const temporary of temporaries) {
      if (!isObject(temporary.value)) continue;
      let descriptor: PreparedReferenceDescriptor;
      try {
        descriptor = readPreparedReference(temporary.value, INTERNAL_REFERENCE_SPAN);
      } catch {
        continue;
      }
      if (
        descriptor.detached ||
        preparedReferenceListIndexPosition(snapshot, descriptor, receiver) === null
      ) {
        continue;
      }
      freezePreparedReference(snapshot, temporary.value, descriptor);
    }
  }
}

function preparedReferenceListIndexPosition(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
  receiver: SerializableRuntimeList,
): number | null {
  const root = preparedReferenceRoot(snapshot, descriptor);
  if (!root.found) return null;
  let current = root.value;
  for (let index = 0; index < descriptor.path.length; index += 1) {
    const step = descriptor.path[index]!;
    if (current === receiver) return step.kind === "index" ? index : null;
    const next = resolvePreparedReferenceStep(snapshot, current, step);
    if (!next.found) return null;
    current = next.value;
  }
  return null;
}

function preparedReferenceMutationMatches(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
  mutation: PreparedReferenceMutation,
  descendantsOnly: boolean,
): boolean {
  const rootMatches =
    descriptor.rootFrameId === mutation.rootFrameId &&
    descriptor.rootName === mutation.rootName &&
    (!descendantsOnly || descriptor.path.length > mutation.path.length) &&
    pathStartsWith(descriptor.path, mutation.path);
  if (rootMatches) return true;

  if (mutation.speakerPath === null || mutation.speakerPath === undefined) {
    return false;
  }
  const descriptorSpeakerPath = preparedReferenceSpeakerPath(snapshot, descriptor);
  return descriptorSpeakerPath !== null &&
    descriptorSpeakerPath.speakerId === mutation.speakerPath.speakerId &&
    (!descendantsOnly ||
      descriptorSpeakerPath.path.length > mutation.speakerPath.path.length) &&
    pathStartsWith(descriptorSpeakerPath.path, mutation.speakerPath.path);
}

function freezePreparedReference(
  snapshot: RuntimeSnapshot,
  serialized: SerializableRuntimeObject,
  descriptor: PreparedReferenceDescriptor,
): void {
  const resolution = resolvePreparedReferenceDescriptor(snapshot, descriptor);
  if (!resolution.found) {
    setSerializableProperty(serialized, "detached", true);
    return;
  }
  setSerializableProperty(serialized, "rootFrameId", null);
  setSerializableProperty(serialized, "rootName", null);
  setSerializableProperty(serialized, "path", createSerializableList([]));
  setSerializableProperty(serialized, "capturedRoot", resolution.value);
  setSerializableProperty(serialized, "detached", true);
}

function preparedReferenceSpeakerPath(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
  extension: readonly PreparedReferenceStep[] = [],
): PreparedSpeakerPath | null {
  const root = preparedReferenceRoot(snapshot, descriptor);
  if (!root.found) return null;
  let current = root.value;
  let identity: { speakerId: number; path: PreparedReferenceStep[] } | null = null;
  for (const step of [...descriptor.path, ...extension]) {
    if (isSpeakerReference(current)) {
      identity = { speakerId: current.speakerId, path: [] };
    }
    identity?.path.push(step);
    const next = resolvePreparedReferenceStep(snapshot, current, step);
    if (!next.found) return null;
    current = next.value;
  }
  if (isSpeakerReference(current)) {
    identity = { speakerId: current.speakerId, path: [] };
  }
  return identity;
}

function resolvePreparedReferenceDescriptor(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
): { readonly found: boolean; readonly value: SerializableRuntimeValue } {
  const root = preparedReferenceRoot(snapshot, descriptor);
  if (!root.found) return root;
  let current = root.value;
  for (const step of descriptor.path) {
    const next = resolvePreparedReferenceStep(snapshot, current, step);
    if (!next.found) return next;
    current = next.value;
  }
  return { found: true, value: current };
}

function preparedReferenceRoot(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
): { readonly found: boolean; readonly value: SerializableRuntimeValue } {
  if (
    !descriptor.detached &&
    descriptor.rootFrameId !== null &&
    descriptor.rootName !== null
  ) {
    const frame = snapshot.frames.find(
      (candidate) => candidate.id === descriptor.rootFrameId,
    );
    const binding = frame?.bindings.find(
      (candidate) => candidate.name === descriptor.rootName,
    );
    return binding === undefined
      ? { found: false, value: null }
      : { found: true, value: binding.value };
  }
  return { found: true, value: descriptor.capturedRoot };
}

function resolvePreparedReferenceStep(
  snapshot: RuntimeSnapshot,
  value: SerializableRuntimeValue,
  step: PreparedReferenceStep,
): { readonly found: boolean; readonly value: SerializableRuntimeValue } {
  if (step.kind === "index") {
    if (
      (!isList(value) && !isSet(value)) ||
      step.index < 0 ||
      step.index >= value.items.length
    ) {
      return { found: false, value: null };
    }
    return { found: true, value: value.items[step.index]! };
  }
  if (isObject(value)) {
    const property = getSerializableProperty(value, step.name);
    return property === undefined
      ? { found: false, value: null }
      : { found: true, value: property };
  }
  if (isSpeakerReference(value)) {
    const speaker = snapshot.speakers.find(
      (candidate) => candidate.id === value.speakerId,
    );
    if (speaker === undefined) return { found: false, value: null };
    let property = speaker.properties.find(
      (candidate) => candidate.name === step.name,
    )?.value;
    if (property === undefined && step.name === "title") {
      property = speaker.properties.find(
        (candidate) => candidate.name === "shortTitle",
      )?.value;
    } else if (property === undefined && step.name === "shortTitle") {
      property = speaker.properties.find(
        (candidate) => candidate.name === "title",
      )?.value;
    }
    return property === undefined
      ? { found: false, value: null }
      : { found: true, value: property };
  }
  if ((isList(value) || isSet(value)) && step.name === "length") {
    return { found: true, value: value.items.length };
  }
  return { found: false, value: null };
}

function pathStartsWith(
  path: readonly PreparedReferenceStep[],
  prefix: readonly PreparedReferenceStep[],
): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((step, index) => {
    const candidate = path[index];
    return candidate?.kind === step.kind &&
      (step.kind === "property"
        ? candidate.kind === "property" && candidate.name === step.name
        : candidate.kind === "index" && candidate.index === step.index);
  });
}

function allTemporaryCollections(
  snapshot: RuntimeSnapshot,
): RuntimeTemporarySnapshot[][] {
  return [
    snapshot.temporaries,
    ...snapshot.callFrames.map((frame) => frame.callerTemporaries),
  ];
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

function setTemporary(
  temporaries: RuntimeTemporarySnapshot[],
  temporaryId: number,
  value: SerializableRuntimeValue,
): void {
  const existing = temporaries.find((item) => item.id === temporaryId);
  if (existing === undefined) {
    temporaries.push({ id: temporaryId, value: cloneSerializableValue(value) });
  } else {
    existing.value = cloneSerializableValue(value);
  }
}

function cloneTemporary(
  temporary: RuntimeTemporarySnapshot,
): RuntimeTemporarySnapshot {
  return {
    id: temporary.id,
    value: cloneSerializableValue(temporary.value),
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

function takeSequence(snapshot: RuntimeSnapshot): number {
  const sequence = snapshot.nextEventSequence;
  snapshot.nextEventSequence += 1;
  return sequence;
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
  snapshot.status = "failed";
  snapshot.failure = {
    code: failure.code,
    message: failure.message,
    span: copySpan(failure.span),
  };
  events.push(
    Object.freeze({
      kind: "runtimeFailure",
      sequence: takeSequence(snapshot),
      code: failure.code,
      message: failure.message,
      span: copySpan(failure.span),
    } satisfies RuntimeFailureEvent),
  );
}

function failForBudget(plan: InstructionPlan, snapshot: RuntimeSnapshot): RuntimeOperationResult {
  assertExecutableData(plan, snapshot);
  const copy = cloneRuntimeSnapshot(snapshot);
  const span = plan.instructions[copy.nextInstruction]?.span ?? plan.sourceSpan;
  const events: InterpreterEvent[] = [];
  failSnapshot(copy, { code: "TSR037", message: "Runtime instruction budget exceeded.", span }, events);
  return result(copy, events, 0);
}

function assertExecutableData(plan: InstructionPlan, snapshot: RuntimeSnapshot): void {
  const planValidation = validateInstructionPlan(plan);
  if (!planValidation.valid) {
    throw new RuntimeDataError("TSR100", planValidation.errors[0]?.message ?? "Malformed instruction plan.");
  }
  const snapshotValidation = validateRuntimeSnapshot(snapshot, plan);
  if (!snapshotValidation.valid) {
    throw new RuntimeDataError("TSR101", snapshotValidation.errors[0] ?? "Malformed runtime snapshot.");
  }
}

function instructionBudget(value: number | undefined): number {
  const budget = value ?? 10_000;
  if (!Number.isInteger(budget) || budget < 1) throw new RangeError("Instruction budget must be a positive integer.");
  return budget;
}

function result(
  snapshot: RuntimeSnapshot,
  events: readonly InterpreterEvent[],
  instructionsExecuted: number,
): RuntimeOperationResult {
  return Object.freeze({
    snapshot,
    events: Object.freeze([...events]),
    instructionsExecuted,
  });
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, span);
}

function copySpan(span: SourceSpan): SourceSpan {
  return createSourceSpan(span.start, span.end);
}

function isList(value: SerializableRuntimeValue): value is SerializableRuntimeList {
  return typeof value === "object" && value !== null && value.kind === "list";
}

function isSet(value: SerializableRuntimeValue): value is SerializableRuntimeSet {
  return typeof value === "object" && value !== null && value.kind === "set";
}

function isObject(value: SerializableRuntimeValue): value is SerializableRuntimeObject {
  return typeof value === "object" && value !== null && value.kind === "object";
}

function isRange(value: SerializableRuntimeValue): value is SerializableRuntimeRange {
  return typeof value === "object" && value !== null && value.kind === "range";
}

function isSpeakerReference(value: SerializableRuntimeValue): value is SerializableSpeakerReference {
  return typeof value === "object" && value !== null && value.kind === "speakerReference";
}
