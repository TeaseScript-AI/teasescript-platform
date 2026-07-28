import type { FunctionDeclaration, Program } from "../ast.js";
import {
  AST_VALIDATION_CODES,
  captureProgramAst,
  findNonFiniteNumericLiteralDiagnostics,
} from "../ast-validation.js";
import { createSourceSpan, type SourceSpan } from "../source.js";
import {
  INSTRUCTION_PLAN_FORMAT,
  INSTRUCTION_PLAN_VERSION,
  type InstructionPlan,
} from "../plan/model.js";
import { InstructionCompiler } from "./lowering/compiler.js";

export type { InstructionPlan } from "../plan/model.js";

export class InstructionCompilationError extends Error {
  readonly span: SourceSpan;

  public constructor(
    readonly code: "TSC001" | "TSC003" | "TSC005",
    message: string,
    span: SourceSpan,
  ) {
    super(message);
    this.name = "InstructionCompilationError";
    this.span = copySpan(span);
  }
}

export function compileProgram(program: Program): InstructionPlan {
  const capture = captureProgramAst(program);
  if (capture.program === null) {
    throw new InstructionCompilationError(
      AST_VALIDATION_CODES.invalidExternalAst,
      capture.diagnostic!.message,
      capture.diagnostic!.span,
    );
  }
  const capturedProgram = capture.program;
  const nonFiniteDiagnostic = findNonFiniteNumericLiteralDiagnostics(capturedProgram)[0];
  if (nonFiniteDiagnostic !== undefined) {
    throw new InstructionCompilationError(
      AST_VALIDATION_CODES.nonFiniteNumericLiteral,
      nonFiniteDiagnostic.message,
      nonFiniteDiagnostic.span,
    );
  }
  const declarations = capturedProgram.statements.filter(
    (statement): statement is FunctionDeclaration =>
      statement.kind === "functionDeclaration",
  );
  const compiler = new InstructionCompiler(declarations);
  compiler.compileStatements(
    capturedProgram.statements.filter(
      (statement) => statement.kind !== "functionDeclaration",
    ),
  );
  const rootEndInstruction = compiler.instructions.length;
  compiler.compileFunctions();
  return deepFreeze({
    format: INSTRUCTION_PLAN_FORMAT,
    version: INSTRUCTION_PLAN_VERSION,
    sourceSpan: copySpan(capturedProgram.span),
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
