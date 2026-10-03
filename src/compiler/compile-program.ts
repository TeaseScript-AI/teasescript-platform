import type { FunctionDeclaration, Program, Statement } from "../ast.js";
import type { SourceSpan } from "../source.js";
import {
  INSTRUCTION_PLAN_FORMAT,
  INSTRUCTION_PLAN_VERSION,
  type InstructionPlan,
  type ValueTypePlan,
} from "../plan/model.js";
import { freezeInstructionPlan } from "../plan/freeze.js";
import { sourceSpanToPlanLocation } from "../plan/source-location.js";
import { InstructionCompiler } from "./lowering/compiler.js";

export type { InstructionPlan } from "../plan/model.js";
export { InstructionCompilationError } from "./errors.js";

/** Lowers parser-owned AST data after source parsing and semantic validation. */
export function compileStableProgram(
  program: Program,
  valueChecks: ReadonlyMap<Statement, ValueTypePlan> = new Map(),
): InstructionPlan {
  const declarations = program.statements.filter(
    (statement): statement is FunctionDeclaration => statement.kind === "functionDeclaration",
  );
  const compiler = new InstructionCompiler(declarations, valueChecks);
  compiler.compileStatements(
    program.statements.filter((statement) => statement.kind !== "functionDeclaration"),
  );
  const rootEndInstruction = compiler.instructions.length;
  compiler.compileFunctions();
  return freezeInstructionPlan({
    format: INSTRUCTION_PLAN_FORMAT,
    version: INSTRUCTION_PLAN_VERSION,
    sourceSpan: copySpan(program.span),
    rootEndInstruction,
    temporaryCount: compiler.temporaryCount,
    functions: compiler.functions,
    instructions: compiler.instructions,
  });
}

function copySpan(span: SourceSpan) {
  return sourceSpanToPlanLocation(span);
}
