import { leaveScopes } from "../captures.js";
import type { ExpressionPlan, Instruction, InstructionPlan } from "../../plan/model.js";
import { rangeLength } from "../../range-checks.js";
import {
  FOR_SOURCE_RULE,
  isRepeatCount,
  pairLoopRule,
  repeatCountFix,
  repeatCountMessage,
} from "../../loop-rules.js";
import type { Evaluator } from "../evaluator.js";
import { internalFault, RuntimeFault } from "../errors.js";
import { assertCounterCanAdvance } from "../operations/support.js";
import { loopKey } from "../debug-trace.js";
import {
  cloneCapturedSerializableValue,
  createCapturedSerializableList,
  type SerializableRuntimeDict,
  type SerializableRuntimeList,
  type SerializableRuntimeRange,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
} from "../serializable-values.js";
import type {
  RuntimeBindingSnapshot,
  RuntimeSnapshot,
  RuntimeLoopFrameSnapshot,
} from "../state.js";
import { describeShownValue } from "../value-types.js";
import { numberFromText } from "../../conversions.js";
import { isDict, isList, isRange, isSet } from "../value-predicates.js";
import { advance, currentCallFrameId, currentFrame, fault } from "./support.js";
import { notBoolean } from "../evaluation/operators.js";
import { assertIntegerRange, planLabel } from "../evaluation/support.js";

export function executeLoopStart(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "loopStart" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
): void {
  // A loop belongs to the call that runs it: the same loop of a recursive caller is another loop.
  const owner = currentCallFrameId(snapshot);
  let frame = snapshot.loopFrames.at(-1);
  if (frame?.loopId !== instruction.loopId || frame.callFrameId !== owner) {
    // The call's own loops are those since it began, so a deep stack is not searched at each loop.
    const callLoops = snapshot.loopFrames.slice(snapshot.callFrames.at(-1)?.loopBaseDepth ?? 0);
    if (
      callLoops.some((item) => item.loopId === instruction.loopId && item.callFrameId === owner)
    ) {
      throw fault(
        "TSR042",
        internalFault("The nesting of running loops does not match the plan."),
        instruction.span,
      );
    }
    const scopeDepth = snapshot.frames.length;
    if (instruction.loopKind === "repeat") {
      const value = evaluator.evaluate(instruction.expression);
      if (typeof value !== "number" || !isRepeatCount(value))
        throw badRepeatCount(instruction.expression, value, plan);
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
      const evaluated = evaluator.evaluate(instruction.expression);
      const pair = instruction.valueVariable !== undefined;
      if (pair && !isDict(evaluated)) {
        const label = planLabel(instruction.expression, plan);
        throw fault(
          "TSR044",
          `${pairLoopRule(instruction.variable, instruction.valueVariable!)}, but ${label === null ? "this" : `'${label}'`} is ${describeShownValue(evaluated)}.${isList(evaluated) || isSet(evaluated) ? ` Go through a ${isList(evaluated) ? "list" : "set"} with one variable${label === null ? "" : `, such as 'for ${instruction.variable} in ${label}'`}.` : ""}`,
          instruction.expression.span,
        );
      }
      // A loop over a dict goes through its keys, or with a value variable its entries, as they are when it starts.
      const source =
        isDict(evaluated) && !pair
          ? createCapturedSerializableList(evaluated.entries.map((entry) => entry.key))
          : evaluated;
      if (!isList(source) && !isSet(source) && !isRange(source) && !isDict(source)) {
        const label = planLabel(instruction.expression, plan);
        throw fault(
          "TSR044",
          `${FOR_SOURCE_RULE}, but ${label === null ? "this" : `'${label}'`} is ${describeShownValue(source)}.${source === null ? ` Check that ${label === null ? "the value" : `'${label}'`} is not null first.` : typeof source === "number" && label !== null ? ` To count up to it, write a range, such as '1..=${label}'.` : ""}`,
          instruction.expression.span,
        );
      }
      if (isRange(source)) assertIntegerRange(source, "A 'for' loop", instruction.expression.span);
      frame = {
        kind: "for",
        loopId: instruction.loopId,
        scopeDepth,
        variable: instruction.variable,
        ...(pair ? { valueVariable: instruction.valueVariable } : {}),
        // EVIDENCE: the guards above narrow source to the four iterable runtime collection variants.
        source: cloneCapturedSerializableValue(source) as Extract<
          RuntimeLoopFrameSnapshot,
          { kind: "for" }
        >["source"],
        position: 0,
        callFrameId: currentCallFrameId(snapshot),
      };
      evaluator.trace?.write(
        "loopSource",
        loopKey(owner ?? 0, instruction.loopId),
        instruction.variable,
        frame.source,
      );
    }
    snapshot.loopFrames.push(frame);
  }

  if (frame.kind !== instruction.loopKind) {
    throw fault(
      "TSR042",
      internalFault("The kind of a running loop does not match the plan."),
      instruction.span,
    );
  }
  if (snapshot.frames.length !== frame.scopeDepth) {
    throw fault(
      "TSR042",
      internalFault("The scope of a running loop does not match the next instruction."),
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
      throw notBoolean(
        "A condition must be true or false (boolean)",
        instruction.expression,
        condition,
        instruction.expression.span,
        plan,
      );
    }
    if (!condition) {
      snapshot.loopFrames.pop();
      snapshot.nextInstruction = instruction.target;
      return;
    }
    evaluator.trace?.loopRound(instruction.target);
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
  if (isDict(frame.source)) {
    // Each iteration binds the key and its own copy of the value, so changes to either never reach the snapshot.
    const entry = frame.source.entries[frame.position]!;
    frame.position += 1;
    pushIterationScope(snapshot, [
      { name: frame.variable, value: entry.key },
      { name: frame.valueVariable!, value: cloneCapturedSerializableValue(entry.value) },
    ]);
    if (evaluator.trace !== null) {
      const scopeId = currentFrame(snapshot).id;
      const source = loopKey(owner ?? 0, instruction.loopId);
      evaluator.trace.loopValue(source, frame.source, scopeId, frame.variable, entry.key);
      evaluator.trace.loopValue(source, frame.source, scopeId, frame.valueVariable!, entry.value);
    }
    advance(snapshot);
    return;
  }
  const value = iterationValue(frame.source, frame.position);
  frame.position += 1;
  pushIterationScope(snapshot, [
    { name: frame.variable, value: cloneCapturedSerializableValue(value) },
  ]);
  evaluator.trace?.loopValue(
    loopKey(owner ?? 0, instruction.loopId),
    frame.source,
    currentFrame(snapshot).id,
    frame.variable,
    value,
  );
  advance(snapshot);
}

export function executeLoopControl(
  instruction: Extract<Instruction, { kind: "loopControl" }>,
  snapshot: RuntimeSnapshot,
): void {
  const frame = snapshot.loopFrames.at(-1);
  if (frame === undefined || frame.loopId !== instruction.loopId) {
    throw fault(
      "TSR042",
      internalFault("A break or continue does not match the innermost running loop."),
      instruction.span,
    );
  }
  if (frame.callFrameId !== currentCallFrameId(snapshot)) {
    throw fault(
      "TSR042",
      internalFault("A break or continue tried to leave a function."),
      instruction.span,
    );
  }
  if (snapshot.frames.length <= frame.scopeDepth) {
    throw fault(
      "TSR042",
      internalFault("The scope of the running loop round is missing."),
      instruction.span,
    );
  }
  leaveScopes(snapshot, frame.scopeDepth);
  if (instruction.action === "break") snapshot.loopFrames.pop();
  snapshot.nextInstruction = instruction.target;
}

function pushIterationScope(snapshot: RuntimeSnapshot, bindings: RuntimeBindingSnapshot[]): void {
  assertCounterCanAdvance(snapshot.nextScopeId, "nextScopeId");
  snapshot.frames.push({ id: snapshot.nextScopeId, file: null, entry: null, bindings });
  snapshot.nextScopeId += 1;
}

function iterationLength(
  source:
    | SerializableRuntimeList
    | SerializableRuntimeSet
    | SerializableRuntimeRange
    | SerializableRuntimeDict,
): number {
  if (isDict(source)) return source.entries.length;
  return isRange(source) ? rangeLength(source) : source.items.length;
}

function iterationValue(
  source: SerializableRuntimeList | SerializableRuntimeSet | SerializableRuntimeRange,
  position: number,
): SerializableRuntimeValue {
  return isRange(source) ? source.start + position : source.items[position]!;
}

/** `TSR043` for a `repeat` count that is not a whole number of at least 0, with the fix for the value it is. */
function badRepeatCount(
  plan: ExpressionPlan,
  value: SerializableRuntimeValue,
  program: InstructionPlan,
): RuntimeFault {
  const label = planLabel(plan, program);
  let fix = "";
  if (value === null)
    fix = ` Check that ${label === null ? "the value" : `'${label}'`} is not null first.`;
  else if (typeof value === "number") fix = repeatCountFix(value);
  else if (typeof value === "string" && numberFromText(value) !== undefined) {
    // Converting the text gives the count it holds, which may still be too small or too large.
    const count = Math.trunc(numberFromText(value)!);
    fix =
      count < 0
        ? " Convert the text with toInteger(...), and check that it is at least 0 first."
        : Number.isSafeInteger(count)
          ? " Convert the text with toInteger(...) first."
          : " Use a smaller count.";
  }
  return fault(
    "TSR043",
    repeatCountMessage(label === null ? "this" : `'${label}'`, describeShownValue(value), fix),
    plan.span,
  );
}
