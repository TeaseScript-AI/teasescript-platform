import type { FunctionDeclaration, Program } from "../ast.js";
import type { SourceSpan } from "../source.js";
import {
  INSTRUCTION_PLAN_FORMAT,
  INSTRUCTION_PLAN_VERSION,
  type InstructionPlan,
  type TypeCheckPlan,
} from "../plan/model.js";
import { freezeInstructionPlan } from "../plan/freeze.js";
import { sourceSpanToPlanLocation } from "../plan/source-location.js";
import type { RuntimeCheckSite } from "../type-checker.js";
import { InstructionCompiler } from "./lowering/compiler.js";

export type { InstructionPlan } from "../plan/model.js";
export { InstructionCompilationError } from "./errors.js";

/**
 * Lowers parser-owned AST data after source parsing and semantic validation. `typeChecks` are the runtime checks the
 * type check recorded for values the compiler cannot know.
 */
export function compileStableProgram(
  program: Program,
  typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan> = new Map(),
): InstructionPlan {
  const declarations = program.statements.filter(
    (statement): statement is FunctionDeclaration => statement.kind === "functionDeclaration",
  );
  const compiler = new InstructionCompiler(declarations, typeChecks);
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
