import type { Block, Expression, Statement, SwitchCase, SwitchStatement } from "../../ast.js";
import { createSourceSpan, type SourceSpan } from "../../source.js";
import type {
  ExpressionPlan,
  JumpIfFalseInstruction,
  JumpInstruction,
  LoopControlInstruction,
  LoopStartInstruction,
  TemporaryExpressionPlan,
} from "../../plan/model.js";
import { compileChild, type CompileTask } from "../continuation.js";
import type { InstructionCompiler, LoopStatement, LoweredExpression } from "./compiler.js";
import { unwrapParentheses, copySpan, typeTestPlan } from "./expression-plans.js";

// Branches and loops: `if`, `switch`, loops, and a right side of `and`, `or`, or `otherwise` that runs instructions.

export function* compileIf(
  compiler: InstructionCompiler,
  statement: Extract<Statement, { kind: "ifStatement" }>,
): CompileTask<void> {
  const lowered = compiler.lowerExpression(statement.condition);
  const conditional = compiler.instructions.length;
  const conditionalInstruction: JumpIfFalseInstruction = {
    kind: "jumpIfFalse",
    condition: lowered.plan,
    target: -1,
    span: copySpan(statement.condition.span),
  };
  compiler.instructions.push(conditionalInstruction);
  compiler.originate(conditional, { kind: "if", statement });
  compiler.emitTemporaryCleanup(lowered.temporaryIds, statement.condition.span);
  yield* compileChild(compileBlock(compiler, statement.thenBlock));
  if (statement.elseBlock === null) {
    const falseCleanup = compiler.instructions.length;
    compiler.instructions[conditional] = { ...conditionalInstruction, target: falseCleanup };
    compiler.emitTemporaryCleanup(lowered.temporaryIds, statement.condition.span);
    return;
  }

  const jump = compiler.instructions.length;
  const jumpInstruction: JumpInstruction = {
    kind: "jump",
    target: -1,
    span: copySpan(statement.span),
  };
  compiler.instructions.push(jumpInstruction);
  const falseCleanup = compiler.instructions.length;
  compiler.instructions[conditional] = { ...conditionalInstruction, target: falseCleanup };
  compiler.emitTemporaryCleanup(lowered.temporaryIds, statement.condition.span);
  if (statement.elseBlock.kind === "ifStatement") {
    yield* compileChild(compiler.compileStatement(statement.elseBlock));
  } else {
    yield* compileChild(compileBlock(compiler, statement.elseBlock));
  }
  compiler.instructions[jump] = { ...jumpInstruction, target: compiler.instructions.length };
}

/**
 * Evaluates the switched value once into a temporary, then tests the cases in order. The temporary is cleared before
 * any case block runs, so it never stays live across a pause, `return`, `break`, or `continue` in a block.
 */
export function* compileSwitch(
  compiler: InstructionCompiler,
  statement: SwitchStatement,
): CompileTask<void> {
  const subject = compiler.lowerExpression(statement.subject);
  const subjectTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "storeTemporary",
    temporaryId: subjectTemporary,
    value: subject.plan,
    expectBoolean: false,
    span: copySpan(statement.subject.span),
  });
  compiler.emitTemporaryCleanup(subject.temporaryIds, statement.subject.span);
  const jumpsToEnd: { readonly index: number; readonly instruction: JumpInstruction }[] = [];
  for (const [index, switchCase] of statement.cases.entries()) {
    const valuesSpan =
      switchCase.typeTest?.span ??
      createSourceSpan(switchCase.values[0]!.span.start, switchCase.values.at(-1)!.span.end);
    const conditional = compiler.instructions.length;
    const conditionalInstruction: JumpIfFalseInstruction = {
      kind: "jumpIfFalse",
      condition: caseCondition(compiler, switchCase, subjectTemporary, valuesSpan),
      target: -1,
      span: copySpan(valuesSpan),
    };
    compiler.instructions.push(conditionalInstruction);
    compiler.originate(conditional, { kind: "case", statement, index });
    compiler.emitTemporaryCleanup([subjectTemporary], valuesSpan);
    yield* compileChild(compileBlock(compiler, switchCase.body));
    const jump: JumpInstruction = { kind: "jump", target: -1, span: copySpan(switchCase.span) };
    jumpsToEnd.push({ index: compiler.instructions.length, instruction: jump });
    compiler.instructions.push(jump);
    compiler.instructions[conditional] = {
      ...conditionalInstruction,
      target: compiler.instructions.length,
    };
  }
  compiler.emitTemporaryCleanup([subjectTemporary], statement.subject.span);
  if (statement.defaultBlock !== null) {
    yield* compileChild(compileBlock(compiler, statement.defaultBlock));
  }
  const end = compiler.instructions.length;
  for (const { index, instruction } of jumpsToEnd) {
    compiler.instructions[index] = { ...instruction, target: end };
  }
}

/** `subject == value` for each literal and `subject in range` for each range, or-ed. */
function caseCondition(
  compiler: InstructionCompiler,
  switchCase: SwitchCase,
  subjectTemporary: number,
  valuesSpan: SourceSpan,
): ExpressionPlan {
  if (switchCase.typeTest !== null)
    return typeTestPlan(switchCase.typeTest, {
      kind: "temporary",
      temporaryId: subjectTemporary,
      span: copySpan(valuesSpan),
    });
  const tests = switchCase.values.map((expression): ExpressionPlan => {
    const value = unwrapParentheses(expression);
    const subject = (): ExpressionPlan => ({
      kind: "temporary",
      temporaryId: subjectTemporary,
      span: copySpan(expression.span),
    });
    if (value.kind !== "rangeExpression") {
      return {
        kind: "binary",
        operator: "==",
        left: subject(),
        right: compiler.lowerExpression(value).plan,
        span: copySpan(expression.span),
      };
    }
    return {
      kind: "binary",
      operator: "in",
      left: subject(),
      right: compiler.lowerExpression(value).plan,
      span: copySpan(expression.span),
    };
  });
  return tests.reduce((left, right): ExpressionPlan => ({
    kind: "binary",
    operator: "or",
    left,
    right,
    span: copySpan(valuesSpan),
  }));
}

function* compileBlock(compiler: InstructionCompiler, block: Block): CompileTask<void> {
  compiler.instructions.push({ kind: "enterScope", span: copySpan(block.span) });
  yield* compileChild(compiler.compileStatementsTask(block.statements));
  compiler.instructions.push({ kind: "leaveScope", span: copySpan(block.span) });
}

export function* compileLoop(
  compiler: InstructionCompiler,
  statement: LoopStatement,
  loopKind: "repeat" | "for" | "while",
  expression: Expression,
  body: Block,
  variable: string | null,
  span: SourceSpan,
  valueVariable?: string,
): CompileTask<void> {
  const loopId = compiler.counters.nextLoopId;
  compiler.counters.nextLoopId += 1;
  const continueTarget = compiler.instructions.length;
  const lowered = compiler.lowerExpression(expression);
  const start = compiler.instructions.length;
  const loopContinueTarget = loopKind === "while" ? continueTarget : start;
  const instruction: LoopStartInstruction =
    loopKind === "for"
      ? {
          kind: "loopStart",
          loopKind,
          loopId,
          variable: variable!,
          ...(valueVariable === undefined ? {} : { valueVariable }),
          expression: lowered.plan,
          continueTarget: loopContinueTarget,
          target: -1,
          span: copySpan(span),
        }
      : {
          kind: "loopStart",
          loopKind,
          loopId,
          expression: lowered.plan,
          continueTarget: loopContinueTarget,
          target: -1,
          span: copySpan(span),
        };
  compiler.instructions.push(instruction);
  compiler.originate(start, { kind: "loop", statement });
  compiler.emitTemporaryCleanup(lowered.temporaryIds, expression.span);
  const breaks: number[] = [];
  const context = { loopId, continueTarget: instruction.continueTarget, breaks };
  compiler.loops.push(context);
  yield* compileChild(compiler.compileStatementsTask(body.statements));
  compiler.instructions.push({
    kind: "loopControl",
    action: "continue",
    loopId,
    target: context.continueTarget,
    span: copySpan(body.span),
  });
  compiler.loops.pop();
  const falseCleanup = compiler.instructions.length;
  compiler.instructions[start] = { ...instruction, target: falseCleanup };
  compiler.emitTemporaryCleanup(lowered.temporaryIds, expression.span);
  const exit = compiler.instructions.length;
  for (const index of context.breaks) {
    // EVIDENCE: break indices are recorded only when emitting loopControl instructions above.
    compiler.instructions[index] = {
      ...(compiler.instructions[index] as LoopControlInstruction),
      target: exit,
    };
  }
}

/**
 * `a otherwise b` whose fallback runs as instructions, such as an ask: the value waits in a temporary, and the fallback
 * runs only when it is null and then takes its place, as a `load` default does (V30 §18).
 */
export function* lowerFallbackTask(
  compiler: InstructionCompiler,
  expression: Extract<Expression, { kind: "binaryExpression" }>,
): CompileTask<LoweredExpression> {
  const left = yield* compileChild(compiler.lowerExpressionTask(expression.left));
  const resultTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "storeTemporary",
    temporaryId: resultTemporary,
    value: left.plan,
    expectBoolean: false,
    span: copySpan(expression.left.span),
  });
  const result: TemporaryExpressionPlan = {
    kind: "temporary",
    temporaryId: resultTemporary,
    span: copySpan(expression.span),
  };
  const conditional = compiler.instructions.length;
  const conditionalInstruction: JumpIfFalseInstruction = {
    kind: "jumpIfFalse",
    condition: {
      kind: "binary",
      operator: "==",
      left: result,
      right: { kind: "literal", value: null, span: copySpan(expression.span) },
      span: copySpan(expression.span),
    },
    target: -1,
    span: copySpan(expression.span),
  };
  compiler.instructions.push(conditionalInstruction);
  compiler.originate(conditional, { kind: "operand", expression });
  const right = yield* compileChild(compiler.lowerExpressionTask(expression.right));
  compiler.instructions.push({
    kind: "storeTemporary",
    temporaryId: resultTemporary,
    value: right.plan,
    expectBoolean: false,
    span: copySpan(expression.right.span),
  });
  compiler.instructions[conditional] = {
    ...conditionalInstruction,
    target: compiler.instructions.length,
  };
  return {
    plan: result,
    temporaryIds: [...left.temporaryIds, ...right.temporaryIds, resultTemporary],
  };
}

export function* lowerLogicalExpressionTask(
  compiler: InstructionCompiler,
  expression: Extract<Expression, { kind: "binaryExpression" }>,
): CompileTask<LoweredExpression> {
  const left = yield* compileChild(compiler.lowerExpressionTask(expression.left));
  const resultTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "storeTemporary",
    temporaryId: resultTemporary,
    value: left.plan,
    expectBoolean: true,
    span: copySpan(expression.left.span),
  });
  const condition: TemporaryExpressionPlan = {
    kind: "temporary",
    temporaryId: resultTemporary,
    span: copySpan(expression.left.span),
  };
  if (expression.operator === "and") {
    const conditional = compiler.instructions.length;
    const conditionalInstruction: JumpIfFalseInstruction = {
      kind: "jumpIfFalse",
      condition,
      target: -1,
      span: copySpan(expression.span),
    };
    compiler.instructions.push(conditionalInstruction);
    compiler.originate(conditional, { kind: "operand", expression });
    const right = yield* compileChild(compiler.lowerExpressionTask(expression.right));
    compiler.instructions.push({
      kind: "storeTemporary",
      temporaryId: resultTemporary,
      value: right.plan,
      expectBoolean: true,
      span: copySpan(expression.right.span),
    });
    compiler.instructions[conditional] = {
      ...conditionalInstruction,
      target: compiler.instructions.length,
    };
    return {
      plan: { ...condition, span: copySpan(expression.span) },
      temporaryIds: [...left.temporaryIds, ...right.temporaryIds, resultTemporary],
    };
  }
  const conditional = compiler.instructions.length;
  const conditionalInstruction: JumpIfFalseInstruction = {
    kind: "jumpIfFalse",
    condition,
    target: -1,
    span: copySpan(expression.span),
  };
  compiler.instructions.push(conditionalInstruction);
  compiler.originate(conditional, { kind: "operand", expression });
  const skipRight = compiler.instructions.length;
  const skipRightInstruction: JumpInstruction = {
    kind: "jump",
    target: -1,
    span: copySpan(expression.span),
  };
  compiler.instructions.push(skipRightInstruction);
  compiler.instructions[conditional] = {
    ...conditionalInstruction,
    target: compiler.instructions.length,
  };
  const right = yield* compileChild(compiler.lowerExpressionTask(expression.right));
  compiler.instructions.push({
    kind: "storeTemporary",
    temporaryId: resultTemporary,
    value: right.plan,
    expectBoolean: true,
    span: copySpan(expression.right.span),
  });
  compiler.instructions[skipRight] = {
    ...skipRightInstruction,
    target: compiler.instructions.length,
  };
  return {
    plan: { ...condition, span: copySpan(expression.span) },
    temporaryIds: [...left.temporaryIds, ...right.temporaryIds, resultTemporary],
  };
}
