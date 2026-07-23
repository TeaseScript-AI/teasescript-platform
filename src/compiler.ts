import type { Program } from "./ast.js";
import { DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { compileProgram, type InstructionPlan } from "./instructions.js";
import { parse } from "./parser.js";
import {
  validateSemantics,
  type SemanticValidationOptions,
} from "./semantic.js";

export interface CompileOptions extends SemanticValidationOptions {}

export interface CompilationResult {
  readonly program: Program;
  readonly parserDiagnostics: readonly Diagnostic[];
  readonly semanticDiagnostics: readonly Diagnostic[];
  readonly diagnostics: readonly Diagnostic[];
  readonly plan: InstructionPlan | null;
}

/** Parses, validates, and compiles source without executing it. */
export function compileSource(
  source: string,
  options: CompileOptions = {},
): CompilationResult {
  const parsed = parse(source);
  const hasParserErrors = hasErrors(parsed.diagnostics);
  const semantic = hasParserErrors
    ? Object.freeze({ diagnostics: Object.freeze([]) })
    : validateSemantics(parsed.program, options);
  const diagnostics = Object.freeze([
    ...parsed.diagnostics,
    ...semantic.diagnostics,
  ]);
  return Object.freeze({
    program: parsed.program,
    parserDiagnostics: parsed.diagnostics,
    semanticDiagnostics: semantic.diagnostics,
    diagnostics,
    plan: hasErrors(diagnostics) ? null : compileProgram(parsed.program),
  });
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic) => diagnostic.severity === DiagnosticSeverity.Error,
  );
}
