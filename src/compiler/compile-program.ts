import type { FunctionDeclaration, Program } from "../ast.js";
import {
  AST_VALIDATION_CODES,
  captureProgramAst,
  findNonFiniteNumericLiteralDiagnosticsInStableProgram,
} from "../ast-validation.js";
import { createSourceSpan, type SourceSpan } from "../source.js";
import {
  INSTRUCTION_PLAN_FORMAT,
  INSTRUCTION_PLAN_VERSION,
  type InstructionPlan,
} from "../plan/model.js";
import { InstructionCompiler } from "./lowering/compiler.js";
import { InstructionCompilationError } from "./errors.js";

export type { InstructionPlan } from "../plan/model.js";
export { InstructionCompilationError } from "./errors.js";

export function compileProgram(program: Program): InstructionPlan {
  const capture = captureProgramAst(program);
  if (capture.program === null) {
    throw new InstructionCompilationError(
      AST_VALIDATION_CODES.invalidExternalAst,
      capture.diagnostic!.message,
      capture.diagnostic!.span,
    );
  }
  return compileStableProgram(capture.program);
}

/**
 * Lowers parser-owned or already-captured stable AST data.
 *
 * The canonical source route calls this after parsing and semantic validation so
 * parser-owned AST size is not conflated with the hostile direct-AST capture
 * budget. `compileProgram(...)` remains the guarded internal entry point for
 * caller-constructed AST data.
 */
export function compileStableProgram(program: Program): InstructionPlan {
  const nonFiniteDiagnostic =
    findNonFiniteNumericLiteralDiagnosticsInStableProgram(program)[0];
  if (nonFiniteDiagnostic !== undefined) {
    throw new InstructionCompilationError(
      AST_VALIDATION_CODES.nonFiniteNumericLiteral,
      nonFiniteDiagnostic.message,
      nonFiniteDiagnostic.span,
    );
  }
  const declarations = program.statements.filter(
    (statement): statement is FunctionDeclaration =>
      statement.kind === "functionDeclaration",
  );
  const compiler = new InstructionCompiler(declarations);
  compiler.compileStatements(
    program.statements.filter(
      (statement) => statement.kind !== "functionDeclaration",
    ),
  );
  const rootEndInstruction = compiler.instructions.length;
  compiler.compileFunctions();
  return deepFreeze({
    format: INSTRUCTION_PLAN_FORMAT,
    version: INSTRUCTION_PLAN_VERSION,
    sourceSpan: copySpan(program.span),
    rootEndInstruction,
    temporaryCount: compiler.temporaryCount,
    functions: compiler.functions,
    instructions: compiler.instructions,
  });
}

function copySpan(span: SourceSpan): SourceSpan {
  return createSourceSpan(span.start, span.end);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
