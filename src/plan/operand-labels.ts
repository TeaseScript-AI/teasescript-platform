import type { ExpressionPlan, InstructionPlan } from "./model.js";
import { instructionKilledTemporaries } from "./temporary-uses.js";
import { quotedText } from "../runtime/values/value-text.js";
import { messageText } from "../runtime/values/text-length.js";

/**
 * What the plan says about the temporaries in which the lowering's instruction path keeps operands, so that a runtime
 * message names an operand and an operator as the lazy path does: one text per rule, whichever path runs.
 */
interface LoweredOperands {
  /** A temporary that one plain `storeTemporary` alone sets: the operand it holds, as the lazy path would have it. */
  readonly stored: ReadonlyMap<number, ExpressionPlan>;
  /** The temporary of a lowered `and` or `or`: its operator. */
  readonly logical: ReadonlyMap<number, "and" | "or">;
}

/** Read only for a message, so each plan is indexed once, on its first message that needs it. */
const loweredOperandsByPlan = new WeakMap<InstructionPlan, LoweredOperands>();

function loweredOperands(program: InstructionPlan): LoweredOperands {
  const cached = loweredOperandsByPlan.get(program);
  if (cached !== undefined) return cached;
  const { instructions } = program;
  const setters = new Map<number, number[]>();
  instructions.forEach((instruction, index) => {
    if (instruction.kind === "clearTemporary" || instruction.kind === "clearTemporaries") return;
    for (const temporaryId of instructionKilledTemporaries(instruction)) {
      const indexes = setters.get(temporaryId);
      if (indexes === undefined) setters.set(temporaryId, [index]);
      else indexes.push(index);
    }
  });
  const stored = new Map<number, ExpressionPlan>();
  const logical = new Map<number, "and" | "or">();
  for (const [temporaryId, indexes] of setters) {
    const first = instructions[indexes[0]!]!;
    if (first.kind !== "storeTemporary" || first.temporaryId !== temporaryId) continue;
    if (indexes.length === 1) {
      // An operand kept before a later operand runs instructions. Only the lowering's own form is followed, which
      // stores a value that is not itself a temporary, so a label is found in one step.
      let value = first.value;
      while (value.kind === "group") value = value.expression;
      if (
        !first.expectBoolean &&
        first.defaultTemporary === undefined &&
        first.defaultOf === undefined &&
        value.kind !== "temporary" &&
        value.kind !== "preparedReference"
      )
        stored.set(temporaryId, first.value);
      continue;
    }
    // A lowered `and` or `or` stores its left operand, branches on it at once, and stores its right operand last. When
    // the left operand is false, `and` has its result and skips the right operand, while `or` goes on to run it.
    const last = indexes[indexes.length - 1]!;
    const right = instructions[last]!;
    const branch = instructions[indexes[0]! + 1];
    if (
      indexes.length === 2 &&
      first.expectBoolean &&
      right.kind === "storeTemporary" &&
      right.expectBoolean &&
      branch?.kind === "jumpIfFalse" &&
      branch.condition.kind === "temporary" &&
      branch.condition.temporaryId === temporaryId
    )
      logical.set(temporaryId, branch.target > last ? "and" : "or");
  }
  const operands = { stored, logical };
  loweredOperandsByPlan.set(program, operands);
  return operands;
}

/**
 * The operand `plan` stands for: for a temporary that the lowering stored an operand in, that operand as written, and
 * otherwise `plan` itself.
 */
export function loweredOperand(program: InstructionPlan, plan: ExpressionPlan): ExpressionPlan {
  let current = plan;
  while (current.kind === "group") current = current.expression;
  if (current.kind !== "temporary") return plan;
  return loweredOperands(program).stored.get(current.temporaryId) ?? plan;
}

/** The operator of the lowered `and` or `or` whose result `temporaryId` holds, or `null` for another temporary. */
export function loweredLogicalOperator(
  program: InstructionPlan,
  temporaryId: number,
): "and" | "or" | null {
  return loweredOperands(program).logical.get(temporaryId) ?? null;
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

/**
 * How the source spells an arithmetic operand: a variable, a property path, or a number, or `null` for anything else. An
 * operand that the lowering kept in a temporary is spelled as written.
 */
export function operandLabel(plan: ExpressionPlan, program: InstructionPlan): string | null {
  let current = loweredOperand(program, plan);
  while (current.kind === "group") current = current.expression;
  if (current.kind === "literal")
    return typeof current.value === "number" ? String(current.value) : null;
  return planLabel(current, program);
}
