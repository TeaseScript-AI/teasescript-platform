import { leaveScopes } from "../scopes/captures.js";
import type { Instruction, InstructionPlan } from "../../plan/model.js";
import type { Evaluator } from "../evaluator.js";
import { internalFault } from "../errors.js";
import { assertCounterCanAdvance } from "../operations/support.js";
import { activeFunctionFrame, contextRootId } from "../scopes/activations.js";
import type { DebugDependencies, TraceStore } from "../debug/debug-trace.js";
import type { InterpreterEvent } from "../events.js";
import {
  cloneCapturedSerializableValue,
  type SerializableRuntimeValue,
} from "../values/serializable-values.js";
import type { RuntimeSnapshot, RuntimeCallFrameSnapshot } from "../snapshot/state.js";
import { returnFromTimerHandler } from "../operations/timer-handlers.js";
import { assertValueType } from "../values/value-types.js";
import { advance, currentCallFrameId, currentFrame, fault, type SourceSpan } from "./support.js";
import { copySpan } from "../../plan/source-location.js";
import { findBinding } from "../evaluation/bindings.js";

// Function calls: a call's frame, its parameters and their defaults, and its return.

export function enterFunction(
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
      `Function calls are nested ${snapshot.maxCallDepth} deep, the most this session allows. End the recursion sooner, or use a loop instead.`,
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
    // Parking moves the caller's temporaries, as a file call or a block does: no assignment, so nothing is copied.
    callerTemporaries: snapshot.temporaries.map((temporary) => ({ ...temporary })),
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

export function bindSuppliedParameter(
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
    throw fault(
      "TSR048",
      internalFault(
        "The progress of filling in a function call's parameters does not match the plan.",
      ),
      instruction.span,
    );
  }
  const parameter = definition.parameters[instruction.parameterIndex];
  const argument = frame.arguments[instruction.parameterIndex];
  if (parameter === undefined || argument === undefined) {
    throw fault(
      "TSR048",
      internalFault("The parameters of a function do not match its call."),
      instruction.span,
    );
  }
  if (argument.supplied) {
    if (!("value" in argument)) {
      throw fault(
        "TSR048",
        internalFault("A supplied parameter of a function call was bound twice."),
        instruction.span,
      );
    }
    // The argument is the call's private copy, so the parameter takes it over instead of copying it again.
    declareFunctionBinding(plan, snapshot, parameter.name, argument.value, instruction.span);
    frame.arguments[instruction.parameterIndex] = {
      parameterName: argument.parameterName,
      supplied: true,
    };
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

export function beginFunctionDefaults(
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
    throw fault(
      "TSR048",
      internalFault("A function call reached its default parameters too early."),
      span,
    );
  }
  frame.parameterState = { phase: "defaults", parameterIndex: 0 };
  advance(snapshot);
}

export function prepareParameterDefault(
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
    throw fault(
      "TSR048",
      internalFault("The default parameters of a function call are in an inconsistent state."),
      instruction.span,
    );
  }
  const parameter = definition.parameters[instruction.parameterIndex];
  const argument = frame.arguments[instruction.parameterIndex];
  if (parameter === undefined || argument === undefined) {
    throw fault(
      "TSR048",
      internalFault("The parameters of a function do not match its call."),
      instruction.span,
    );
  }
  if (argument.supplied) {
    frame.parameterState.parameterIndex += 1;
    snapshot.nextInstruction = instruction.target;
    return;
  }
  if (!parameter.hasDefault) {
    throw fault(
      "TSR049",
      internalFault(`The required parameter '${parameter.name}' was not supplied.`),
      instruction.span,
    );
  }
  advance(snapshot);
}

export function bindDefaultParameter(
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
    throw fault(
      "TSR048",
      internalFault("A default parameter of a function call was bound inconsistently."),
      instruction.span,
    );
  }
  const parameter = definition.parameters[instruction.parameterIndex];
  if (parameter === undefined || !parameter.hasDefault) {
    throw fault(
      "TSR048",
      internalFault("The default parameters of a function do not match its call."),
      instruction.span,
    );
  }
  const value = evaluator.evaluate(instruction.value);
  if (instruction.typeCheck !== undefined)
    assertValueType(value, instruction.typeCheck, instruction.value.span);
  declareFunctionBinding(
    plan,
    snapshot,
    parameter.name,
    cloneCapturedSerializableValue(value),
    instruction.span,
  );
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

export function enterFunctionBody(
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
    throw fault(
      "TSR048",
      internalFault("A function body started before all its parameters were bound."),
      span,
    );
  }
  frame.parameterState = { phase: "body", parameterIndex: definition.parameters.length };
  advance(snapshot);
}

export function returnFromFunction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  value: SerializableRuntimeValue,
  span: SourceSpan,
  events: InterpreterEvent[],
  evaluator: Evaluator,
): void {
  const trace = evaluator.trace;
  const { frame } = activeFunction(plan, snapshot, span);
  if (frame.timerInterruption !== null) {
    returnFromTimerHandler(plan, snapshot, frame, events, trace, evaluator.control);
    return;
  }
  const returned = cloneCapturedSerializableValue(value);
  leaveScopes(snapshot, frame.scopeBaseDepth);
  snapshot.loopFrames.splice(frame.loopBaseDepth);
  snapshot.callFrames.pop();
  // They move back from the discarded frame one by one: a wide caller state must not depend on the host's
  // argument-spread limit.
  snapshot.temporaries.length = 0;
  for (const temporary of frame.callerTemporaries) snapshot.temporaries.push({ ...temporary });
  const destinationTemporary = frame.destinationTemporary!;
  if (snapshot.temporaries.some((temporary) => temporary.id === destinationTemporary)) {
    throw fault(
      "TSR050",
      internalFault("The slot for the result of a function call is already in use."),
      span,
    );
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
    throw fault(
      "TSR051",
      internalFault("A function instruction ran outside a function call."),
      span,
    );
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
    throw fault(
      "TSR052",
      internalFault(`The plan calls a function (ID ${functionId}) that it does not contain.`),
      span,
    );
  }
  return definition;
}

/** Binds parameter `name` to `value`, which nothing else may hold. */
function declareFunctionBinding(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  name: string,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): void {
  if (findBinding(snapshot, plan, name) !== undefined) {
    throw fault(
      "TSR001",
      internalFault(
        `The plan gives parameter '${name}' the name of a variable that is already visible.`,
      ),
      span,
    );
  }
  currentFrame(snapshot).bindings.push({ name, value });
}
