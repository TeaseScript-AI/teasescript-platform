import type { ExpressionPlan, Instruction } from "../../../plan/model.js";
import { copySpan } from "../../../plan/source-location.js";
import { rangeLength } from "../../../range-checks.js";
import { haltForExit } from "../../engine.js";
import { dictKey, missingKey, notIndexable } from "../../evaluation/access.js";
import { loweredLogicalOperator } from "../../evaluation/lowered-operands.js";
import { notBoolean, notLogicalOperand } from "../../evaluation/operators.js";
import {
  declaredSpeaker,
  outputSpeaker,
  speakerById,
  textSayText,
} from "../../evaluation/speakers.js";
import { callTooDeep } from "../../instructions/functions.js";
import { forLoopSource } from "../../instructions/loops.js";
import {
  checkedSpeakerProperty,
  contextualSpeakerValue,
  emitEvaluatedSay,
  finishSay,
  preparedSpeakerValue,
  readPreparedSpeaker,
  sayStage,
  type PacingPlace,
} from "../../instructions/say.js";
import { resolveMessagePresentation } from "../../message-presentation.js";
import type { RuntimeSpeakerSnapshot } from "../../snapshot/state.js";
import { endWithoutCall } from "../../operations/transfers.js";
import { assertCounterCanAdvance } from "../../operations/support.js";
import { assertFallbackType, assertValueType } from "../../values/value-types.js";
import { isRange } from "../../values/value-predicates.js";
import {
  newActivation,
  type NativeMachine,
  type NativeReference,
  type NativeReferenceStep,
} from "../execute/machine.js";
import { isNativeReference, readLocation } from "../execute/references.js";
import { assertNativeIndexable, nativeListPosition, shown } from "../operations/access.js";
import { NativeNotImplementedError } from "../operations/not-implemented.js";
import { fromCanonical } from "../values/codec.js";
import { NativeDict, NativeSet, type NativeValue } from "../values/native-value.js";
import { compileExpression, compileOwned, type ExpressionScope } from "./expressions.js";
import { NativePreparationError, type NameLocation, type ScopeTracker } from "./scopes.js";

/** An instruction prepared as a closure over the machine; it sets the machine's next instruction. */
export type NativeStep = (machine: NativeMachine) => void;

/** What compiling an instruction needs: the walk's open scopes, which it updates, and the plan's facts. */
export interface InstructionScope extends ExpressionScope {
  readonly tracker: ScopeTracker;
  /** The index of a global name in a session's global slots. */
  globalIndex(name: string): number;
  /** The scope depth at the `loopStart` of a loop of the region, whose rounds' scopes open above it. */
  loopDepth(loopId: number): number;
  /** Whether a prepared reference's temporary needs what the native engine does not keep: a copy of its root. */
  keepsReferenceRoot(temporaryId: number): boolean;
}

/**
 * Compiles the instruction at `pc` and applies its effect on the open scopes to `scope.tracker`. An instruction or a
 * form outside the native engine's slice refuses the plan at preparation.
 */
export function compileInstruction(
  instruction: Instruction,
  pc: number,
  scope: InstructionScope,
): NativeStep {
  const next = pc + 1;
  const span = instruction.span;
  switch (instruction.kind) {
    case "declareSpeaker": {
      const properties = instruction.properties.map((property) => {
        if (property.value.kind !== "literal")
          throw new NativePreparationError("a speaker property whose value is not a literal");
        return [property.name, property.value.value, property.span] as const;
      });
      if (new Set(properties.map(([name]) => name)).size !== properties.length)
        throw new NativePreparationError("a speaker declaration that gives a property twice");
      const name = instruction.name;
      const index = scope.globalIndex(name);
      return function declareSpeaker(machine) {
        const snapshot = machine.snapshot;
        assertCounterCanAdvance(snapshot.nextSpeakerId, "nextSpeakerId");
        const speaker: RuntimeSpeakerSnapshot = { id: snapshot.nextSpeakerId, identifier: name, properties: [] };
        snapshot.nextSpeakerId += 1;
        snapshot.speakers.push(speaker);
        machine.globals[index] = Object.freeze({ kind: "speakerReference", speakerId: speaker.id, identifier: name });
        for (const [property, value, at] of properties)
          speaker.properties.push({ name: property, value: checkedSpeakerProperty(property, value, at) });
        machine.pc = next;
      };
    }
    case "setDefaultSpeaker": {
      const name = instruction.name;
      const location = scope.resolve(name);
      return function setDefaultSpeaker(machine) {
        machine.snapshot.defaultSpeaker = speakerAt(machine, name, location, span).id;
        machine.pc = next;
      };
    }
    case "enterScope":
      scope.tracker.push();
      return function enterScope(machine) {
        openScope(machine, []);
        machine.pc = next;
      };
    case "leaveScope":
      scope.tracker.pop();
      return function leaveScope(machine) {
        machine.current.scopes.pop();
        machine.pc = next;
      };
    case "declareBinding": {
      if (instruction.partChecks !== undefined)
        throw new NativePreparationError("a declaration with part checks");
      const value = compileOwned(instruction.value, scope);
      const typeCheck = instruction.typeCheck;
      const valueSpan = instruction.value.span;
      const slot = scope.tracker.declare(instruction.name);
      const depth = scope.tracker.depth;
      return function declareBinding(machine) {
        const declared = value(machine);
        if (typeCheck !== undefined) assertValueType(shown(declared), typeCheck, valueSpan);
        machine.current.scopes[depth]![slot] = declared;
        machine.pc = next;
      };
    }
    case "validateAssignmentTarget": {
      const target = instruction.target;
      if (target.kind === "identifier")
        return function validateAssignmentTarget(machine) {
          machine.pc = next;
        };
      const place = compileIndexPlace(target, scope);
      return function validateAssignmentTarget(machine) {
        place(machine);
        machine.pc = next;
      };
    }
    case "assign":
      return compileAssign(instruction, next, scope);
    case "prepareReference": {
      const destination = instruction.destinationTemporary;
      if (scope.keepsReferenceRoot(destination))
        throw new NativePreparationError("a prepared reference that keeps a copy of its root");
      const prepare = compileReference(instruction.expression, scope);
      return function prepareReference(machine) {
        const reference = prepare(machine);
        const temps = machine.current.temps;
        if (!isNativeReference(temps[destination])) machine.liveReferences += 1;
        temps[destination] = reference;
        machine.pc = next;
      };
    }
    case "evaluate": {
      const expression = compileExpression(instruction.expression, scope);
      return function evaluate(machine) {
        expression(machine);
        machine.pc = next;
      };
    }
    case "jumpIfFalse": {
      const condition = compileExpression(instruction.condition, scope);
      const target = instruction.target;
      const plan = instruction.condition;
      return function jumpIfFalse(machine) {
        const value = condition(machine);
        if (typeof value !== "boolean")
          throw notBoolean("A condition must be true or false (boolean)", plan, shown(value), plan.span, scope.plan);
        machine.pc = value ? next : target;
      };
    }
    case "jump": {
      const target = instruction.target;
      return function jump(machine) {
        machine.pc = target;
      };
    }
    case "loopStart":
      return compileLoopStart(instruction, next, scope);
    case "loopControl": {
      const depth = scope.loopDepth(instruction.loopId);
      const target = instruction.target;
      const ends = instruction.action === "break";
      return function loopControl(machine) {
        const activation = machine.current;
        activation.scopes.length = depth + 1;
        if (ends) activation.loops.pop();
        machine.pc = target;
      };
    }
    case "storeTemporary":
      return compileStoreTemporary(instruction, next, scope);
    case "clearTemporary": {
      const id = instruction.temporaryId;
      return function clearTemporary(machine) {
        clearTemp(machine, id);
        machine.pc = next;
      };
    }
    case "clearTemporaries": {
      const ids = [...instruction.temporaryIds];
      return function clearTemporaries(machine) {
        for (const id of ids) clearTemp(machine, id);
        machine.pc = next;
      };
    }
    case "callFunction":
      return compileCallFunction(instruction, scope);
    case "bindSuppliedParameter":
    case "beginFunctionDefaults":
    case "enterFunctionBody":
      // The call put every argument in its parameter's slot (`compileCallFunction`).
      return function bindParameters(machine) {
        machine.pc = next;
      };
    case "prepareParameterDefault": {
      // Every parameter of the slice's functions is supplied, so its default is skipped.
      const target = instruction.target;
      return function skipParameterDefault(machine) {
        machine.pc = target;
      };
    }
    case "returnValue": {
      const value = compileOwned(instruction.value, scope);
      const typeCheck = instruction.typeCheck;
      const valueSpan = instruction.value.span;
      return function returnValue(machine) {
        const returned = value(machine);
        if (typeCheck !== undefined) assertValueType(shown(returned), typeCheck, valueSpan);
        returnFrom(machine, returned);
      };
    }
    case "returnVoid":
      return function returnVoid(machine) {
        returnFrom(machine, null);
      };
    case "prepareSaySpeaker": {
      const name = instruction.speaker;
      const location = name === null ? null : scope.resolve(name);
      const destination = instruction.destinationTemporary;
      return function prepareSaySpeaker(machine) {
        const snapshot = machine.snapshot;
        const speaker =
          name === null
            ? snapshot.defaultSpeaker === null
              ? null
              : speakerById(machine, snapshot.defaultSpeaker, span)
            : speakerAt(machine, name, location!, span);
        const output = speaker === null ? null : outputSpeaker(machine, speaker, span, machine.events);
        setTemp(machine, destination, fromCanonical(preparedSpeakerValue(speaker, output)));
        machine.pc = next;
      };
    }
    case "prepareSayContextualSpeaker": {
      const source = instruction.speakerTemporary;
      const destination = instruction.destinationTemporary;
      return function prepareSayContextualSpeaker(machine) {
        const prepared = shown(tempValue(machine, source));
        setTemp(machine, destination, fromCanonical(contextualSpeakerValue(machine, prepared, span)));
        machine.pc = next;
      };
    }
    case "say":
      return compileSay(instruction, scope);
    case "exit":
      return function exit(machine) {
        for (const activation of machine.activations) activation.temps.length = 0;
        machine.activations.length = 1;
        machine.current = machine.root;
        machine.root.scopes.length = 1;
        machine.root.loops.length = 0;
        machine.liveReferences = 0;
        machine.snapshot.nextInstruction = machine.pc;
        haltForExit(machine.snapshot, span, machine.events);
        machine.pc = machine.snapshot.nextInstruction;
        machine.stop = true;
      };
    case "end":
      // The native engine runs a single-file plan, where no file call is open.
      return function end() {
        throw endWithoutCall(span);
      };
    default:
      throw new NativePreparationError(`the instruction '${instruction.kind}'`);
  }
}

/** The speaker the global `name` at `location` was declared for. */
function speakerAt(machine: NativeMachine, name: string, location: NameLocation, span: Instruction["span"]) {
  const value = readLocation(machine, location);
  return declaredSpeaker(machine, name, value === undefined ? undefined : shown(value), span);
}

/** Opens a scope above the running activation's innermost one, holding `values`, under the session's next scope ID. */
function openScope(machine: NativeMachine, values: NativeValue[]): void {
  const snapshot = machine.snapshot;
  assertCounterCanAdvance(snapshot.nextScopeId, "nextScopeId");
  snapshot.nextScopeId += 1;
  machine.current.scopes.push(values);
}

function tempValue(machine: NativeMachine, id: number): NativeValue {
  const value = machine.current.temps[id];
  if (value === undefined || isNativeReference(value))
    throw new Error(`Temporary ${id} holds no value where the plan reads it.`);
  return value;
}

function setTemp(machine: NativeMachine, id: number, value: NativeValue | NativeReference): void {
  const temps = machine.current.temps;
  if (isNativeReference(temps[id])) machine.liveReferences -= 1;
  temps[id] = value;
}

function clearTemp(machine: NativeMachine, id: number): void {
  const temps = machine.current.temps;
  if (isNativeReference(temps[id])) machine.liveReferences -= 1;
  temps[id] = undefined;
}

/** Fails a change that today's engine makes only after it freezes the prepared references it may reach. */
function refuseWithOtherReferences(machine: NativeMachine, own: number): void {
  if (machine.liveReferences > own)
    throw new NativeNotImplementedError("a change while a prepared reference it may reach is held");
}

function compileStoreTemporary(
  instruction: Extract<Instruction, { kind: "storeTemporary" }>,
  next: number,
  scope: InstructionScope,
): NativeStep {
  if (
    instruction.defaultTemporary !== undefined ||
    instruction.defaultOf !== undefined ||
    instruction.repair !== undefined
  )
    throw new NativePreparationError("a temporary that holds a default or its repair");
  const value = compileOwned(instruction.value, scope);
  const id = instruction.temporaryId;
  const expectBoolean = instruction.expectBoolean;
  const typeCheck = instruction.typeCheck;
  const fallbackCheck = instruction.fallbackCheck;
  const valueSpan = instruction.value.span;
  const plan = scope.plan;
  return function storeTemporary(machine) {
    const stored = value(machine);
    // Only the operands of a lowered 'and' or 'or' expect true or false.
    if (expectBoolean && typeof stored !== "boolean")
      throw notLogicalOperand(loweredLogicalOperator(plan, id), instruction.value, shown(stored), plan);
    if (typeCheck !== undefined) assertValueType(shown(stored), typeCheck, valueSpan);
    if (fallbackCheck !== undefined) assertFallbackType(shown(stored), fallbackCheck, valueSpan);
    setTemp(machine, id, stored);
    machine.pc = next;
  };
}

/**
 * An index assignment's place, checked as today's `validateAssignmentTarget` and `assign` check it: the indexed value
 * is a list and the index one of its positions. Gives the list and the position.
 */
function compileIndexPlace(
  target: Extract<Instruction, { kind: "assign" }>["target"],
  scope: InstructionScope,
): (machine: NativeMachine) => { readonly list: NativeValue[]; readonly position: number } {
  if (target.kind !== "index") throw new NativePreparationError(`an assignment to a ${target.kind}`);
  const object = compileExpression(target.object, scope);
  const index = compileExpression(target.index, scope);
  const receiver = target.object;
  return (machine) => {
    const list = object(machine);
    if (list instanceof NativeSet)
      throw notIndexable(machine, "TSR004", target.object, shown(list), target.span);
    if (list instanceof NativeDict) throw new NativeNotImplementedError("an assignment into a dict");
    if (!Array.isArray(list))
      throw notIndexable(machine, "TSR005", target.object, shown(list), target.span);
    return { list, position: nativeListPosition(machine, list, receiver, target.index, index(machine), "assign") };
  };
}

function compileAssign(
  instruction: Extract<Instruction, { kind: "assign" }>,
  next: number,
  scope: InstructionScope,
): NativeStep {
  if (instruction.partChecks !== undefined)
    throw new NativePreparationError("an assignment with part checks");
  const value = compileOwned(instruction.value, scope);
  const typeCheck = instruction.typeCheck;
  const valueSpan = instruction.value.span;
  const target = instruction.target;
  if (target.kind === "identifier") {
    const name = target.name;
    const location = scope.resolve(name);
    return function assign(machine) {
      const assigned = value(machine);
      if (typeCheck !== undefined) assertValueType(shown(assigned), typeCheck, valueSpan);
      refuseWithOtherReferences(machine, 0);
      writeLocation(machine, location, name, assigned);
      machine.pc = next;
    };
  }
  const place = compileIndexPlace(target, scope);
  const own = target.object.kind === "preparedReference" ? 1 : 0;
  return function assign(machine) {
    const assigned = value(machine);
    if (typeCheck !== undefined) assertValueType(shown(assigned), typeCheck, valueSpan);
    const { list, position } = place(machine);
    refuseWithOtherReferences(machine, own);
    list[position] = assigned;
    machine.pc = next;
  };
}

/** Stores into a variable that has a value; one without one yet is not implemented. */
function writeLocation(machine: NativeMachine, location: NameLocation, name: string, value: NativeValue): void {
  let scope: Array<NativeValue | undefined>;
  let slot: number;
  switch (location.kind) {
    case "local":
      scope = machine.current.scopes[location.depth]!;
      slot = location.slot;
      break;
    case "root":
      scope = machine.root.scopes[0]!;
      slot = location.slot;
      break;
    case "global":
      scope = machine.globals;
      slot = location.index;
      break;
  }
  if (scope[slot] === undefined)
    throw new NativeNotImplementedError(`an assignment to '${name}' before it has a value`);
  scope[slot] = value;
}

/**
 * A prepared reference to `expression`, a variable indexed by lists' positions and dicts' keys: evaluated as a read
 * evaluates it, each index once, with its faults; the reference keeps the positions and keys it took.
 */
function compileReference(
  expression: ExpressionPlan,
  scope: InstructionScope,
): (machine: NativeMachine) => NativeReference {
  const chain: Array<Extract<ExpressionPlan, { kind: "index" }>> = [];
  let root = expression;
  while (root.kind === "index" || root.kind === "group") {
    if (root.kind === "index") chain.unshift(root);
    root = root.kind === "index" ? root.object : root.expression;
  }
  if (root.kind !== "identifier" || root.name === "speaker")
    throw new NativePreparationError("a prepared reference that does not start at a variable");
  const name = root.name;
  const location = scope.resolve(name);
  const steps = chain.map((step) => ({ plan: step, index: compileExpression(step.index, scope) }));
  return (machine) => {
    let value = readLocation(machine, location);
    if (value === undefined)
      throw new NativeNotImplementedError(`a reference to '${name}' before it has a value`);
    const path: NativeReferenceStep[] = [];
    for (const { plan, index } of steps) {
      assertNativeIndexable(machine, plan.object, value, plan.span);
      const at = index(machine);
      if (Array.isArray(value)) {
        const position = nativeListPosition(machine, value, plan.object, plan.index, at, "read");
        path.push({ kind: "index", index: position });
        value = value[position]!;
      } else if (value instanceof NativeDict) {
        const key = dictKey(machine, shown(at), plan.index);
        const held = value.entries.get(key);
        if (held === undefined) throw missingKey(machine, key, plan.object, plan.index, plan.span);
        path.push({ kind: "key", key });
        value = held;
      } else throw new Error("assertNativeIndexable passed a value that is not a list or a dict.");
    }
    return { kind: "reference", rootName: name, root: location, steps: path };
  };
}

function compileLoopStart(
  instruction: Extract<Instruction, { kind: "loopStart" }>,
  next: number,
  scope: InstructionScope,
): NativeStep {
  const loopId = instruction.loopId;
  const depth = scope.tracker.depth;
  const target = instruction.target;
  const expression = compileExpression(instruction.expression, scope);
  const plan = instruction.expression;
  switch (instruction.loopKind) {
    case "while":
      scope.tracker.push();
      return function whileRound(machine) {
        const loops = machine.current.loops;
        if (loops.at(-1)?.loopId !== loopId) loops.push({ kind: "while", loopId, depth });
        const condition = expression(machine);
        if (typeof condition !== "boolean")
          throw notBoolean("A condition must be true or false (boolean)", plan, shown(condition), plan.span, scope.plan);
        if (!condition) {
          loops.pop();
          machine.pc = target;
          return;
        }
        openScope(machine, []);
        machine.pc = next;
      };
    case "for": {
      if (instruction.valueVariable !== undefined)
        throw new NativePreparationError("a 'for' loop with a value variable");
      scope.tracker.push([instruction.variable]);
      return function forRound(machine) {
        const loops = machine.current.loops;
        let loop = loops.at(-1);
        if (loop?.loopId !== loopId) {
          const source = forLoopSource(scope.plan, instruction, shown(expression(machine)));
          if (!isRange(source)) throw new NativeNotImplementedError("a 'for' loop over a list, set or dict");
          loop = { kind: "for", loopId, depth, start: source.start, length: rangeLength(source), position: 0 };
          loops.push(loop);
        }
        if (loop.kind !== "for") throw new Error("A 'for' loop's ID names another loop.");
        if (loop.position >= loop.length) {
          loops.pop();
          machine.pc = target;
          return;
        }
        openScope(machine, [loop.start + loop.position]);
        loop.position += 1;
        machine.pc = next;
      };
    }
    default:
      throw new NativePreparationError(`a '${instruction.loopKind}' loop`);
  }
}

function compileCallFunction(
  instruction: Extract<Instruction, { kind: "callFunction" }>,
  scope: InstructionScope,
): NativeStep {
  const definition = scope.plan.functions[instruction.functionId - 1];
  if (definition === undefined || definition.id !== instruction.functionId)
    throw new NativePreparationError("a call of a function the plan does not contain");
  // The parameter each argument binds, which is also the argument's slot in the call's first scope.
  const slots = instruction.arguments.map((argument) =>
    definition.parameters.findIndex((parameter) => parameter.name === argument.parameterName),
  );
  if (slots.includes(-1) || new Set(slots).size !== definition.parameters.length)
    throw new NativePreparationError("a call that does not supply every parameter");
  const values = instruction.arguments.map((argument) => compileOwned(argument.value, scope));
  const checks = instruction.arguments.map((argument) => [argument.typeCheck, argument.value.span] as const);
  const order = definition.parameters.map((_, slot) => slots.indexOf(slot));
  const entry = definition.entryInstruction;
  const returnInstruction = instruction.returnInstruction;
  const destination = instruction.destinationTemporary;
  const span = instruction.span;
  return function callFunction(machine) {
    refuseWithOtherReferences(machine, 0);
    const supplied: NativeValue[] = [];
    for (const value of values) supplied.push(value(machine));
    // Parameters are bound only after every argument is evaluated, so the arguments are checked then too.
    checks.forEach(([typeCheck, at], index) => {
      if (typeCheck !== undefined) assertValueType(shown(supplied[index]!), typeCheck, at);
    });
    const snapshot = machine.snapshot;
    if (machine.activations.length - 1 >= snapshot.maxCallDepth) throw callTooDeep(snapshot.maxCallDepth, span);
    assertCounterCanAdvance(snapshot.nextCallFrameId, "nextCallFrameId");
    assertCounterCanAdvance(snapshot.nextScopeId, "nextScopeId");
    const parameters: NativeValue[] = [];
    for (const index of order) parameters.push(supplied[index]!);
    const activation = newActivation(parameters, snapshot.nextCallFrameId, returnInstruction, destination);
    snapshot.nextCallFrameId += 1;
    snapshot.nextScopeId += 1;
    machine.activations.push(activation);
    machine.current = activation;
    machine.pc = entry;
  };
}

/** Ends the running call; its result goes to the caller's destination temporary. */
function returnFrom(machine: NativeMachine, value: NativeValue): void {
  const ended = machine.activations.pop();
  const caller = machine.activations.at(-1);
  if (ended === undefined || caller === undefined) throw new Error("A return ran outside a function call.");
  for (const temp of ended.temps) if (isNativeReference(temp)) machine.liveReferences -= 1;
  machine.current = caller;
  if (caller.temps[ended.destinationTemporary] !== undefined)
    throw new Error("The slot for the result of a function call is already in use.");
  caller.temps[ended.destinationTemporary] = value;
  machine.pc = ended.returnInstruction;
}

/** Where a say stands, which its pacing gate records as today's engine counts it: open scopes and loops of every call. */
function pacingPlace(machine: NativeMachine): PacingPlace {
  let scopeDepth = 0;
  let loopDepth = 0;
  for (const activation of machine.activations) {
    scopeDepth += activation.scopes.length;
    loopDepth += activation.loops.length;
  }
  return { ownerCallFrameId: machine.current.callId, scopeDepth, loopDepth };
}

/**
 * A say, as today's `executeSay` runs it on the stage `sayStage` gives, which becomes the session's state only when the
 * say completes; the say's events reach the drive then too.
 */
function compileSay(instruction: Extract<Instruction, { kind: "say" }>, scope: InstructionScope): NativeStep {
  if (instruction.textTemporary !== undefined || instruction.destinationTemporary !== undefined)
    throw new NativePreparationError("a say with prepared text or a result");
  const span = instruction.span;
  const name = instruction.speaker;
  const location = name === null ? null : scope.resolve(name);
  const speakerTemporary = instruction.speakerTemporary;
  const presentation = instruction.presentation === null ? null : compileExpression(instruction.presentation, scope);
  const value = compileExpression(instruction.value, scope);
  const valueSpan = instruction.value.span;
  const pacing = typeof instruction.pacing === "object" ? compileExpression(instruction.pacing, scope) : null;
  const fixedPacing = typeof instruction.pacing === "object" ? null : instruction.pacing;
  return function say(machine) {
    const session = machine.snapshot;
    const drive = machine.events;
    const staged = sayStage(instruction, session);
    const events: typeof drive = [];
    machine.snapshot = staged;
    machine.events = events;
    try {
      let prepared: ReturnType<typeof readPreparedSpeaker>;
      if (speakerTemporary === undefined) {
        const speaker =
          name === null
            ? staged.defaultSpeaker === null
              ? null
              : speakerById(machine, staged.defaultSpeaker, span)
            : speakerAt(machine, name, location!, span);
        prepared = {
          output: speaker === null ? null : outputSpeaker(machine, speaker, span, events),
          speakerId: speaker?.id ?? null,
        };
      } else prepared = readPreparedSpeaker(shown(tempValue(machine, speakerTemporary)), span);
      const speaker = prepared.speakerId === null ? null : speakerById(machine, prepared.speakerId, span);
      const shownPresentation = resolveMessagePresentation(
        presentation === null ? null : shown(presentation(machine)),
        speaker,
        copySpan(span),
      );
      const authoredText = textSayText(machine, shown(value(machine)), valueSpan);
      if (authoredText === undefined) throw new NativeNotImplementedError("a say of a value shown in notation");
      const pacingValue = pacing === null ? fixedPacing! : shown(pacing(machine));
      staged.nextInstruction = machine.pc;
      const said = emitEvaluatedSay(instruction, staged, events, session, {
        output: prepared.output,
        speaker,
        presentation: shownPresentation,
        authoredText,
        pacingValue,
      });
      finishSay(staged, events, span, said, pacingPlace(machine));
    } finally {
      machine.snapshot = session;
      machine.events = drive;
    }
    Object.assign(session, staged);
    session.contextualSpeaker = null;
    for (const event of events) drive.push(event);
    machine.pc = session.nextInstruction;
    machine.stop = true;
  };
}
