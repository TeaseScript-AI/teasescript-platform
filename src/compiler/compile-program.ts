import type { FunctionDeclaration, Program } from "../ast.js";
import {
  AST_VALIDATION_CODES,
  findNonFiniteNumericLiteralDiagnosticsInStableProgram,
} from "../ast-validation.js";
import type { SourceSpan } from "../source.js";
import {
  INSTRUCTION_PLAN_FORMAT,
  INSTRUCTION_PLAN_VERSION,
  type InstructionPlan,
} from "../plan/model.js";
import { freezeInstructionPlan } from "../plan/freeze.js";
import { sourceSpanToPlanLocation } from "../plan/source-location.js";
import { InstructionCompiler } from "./lowering/compiler.js";
import { InstructionCompilationError } from "./errors.js";

export type { InstructionPlan } from "../plan/model.js";
export { InstructionCompilationError } from "./errors.js";

/** Lowers parser-owned AST data after source parsing and semantic validation. */
export function compileStableProgram(program: Program): InstructionPlan {
  const nonFiniteDiagnostic = findNonFiniteNumericLiteralDiagnosticsInStableProgram(program)[0];
  if (nonFiniteDiagnostic !== undefined) {
    throw new InstructionCompilationError(
      AST_VALIDATION_CODES.nonFiniteNumericLiteral,
      nonFiniteDiagnostic.message,
      nonFiniteDiagnostic.span,
    );
  }
  const declarations = program.statements.filter(
    (statement): statement is FunctionDeclaration => statement.kind === "functionDeclaration",
  );
  const compiler = new InstructionCompiler(declarations);
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
