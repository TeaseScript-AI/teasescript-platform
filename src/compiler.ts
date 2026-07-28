import type { Program } from "./ast.js";
import { findNonFiniteNumericLiteralDiagnostics } from "./ast-validation.js";
import { DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { compileProgram, type InstructionPlan } from "./compiler/compile-program.js";
import { parse } from "./parser.js";
import { CORE_RUNTIME_BUILTINS } from "./protected-names.js";
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

export { CORE_RUNTIME_BUILTINS } from "./protected-names.js";

/** Parses, validates, and compiles source without executing it. */
export function compileSource(
  source: string,
  options: CompileOptions = {},
): CompilationResult {
  const parsed = parse(source);
  const parserDiagnostics = Object.freeze([
    ...parsed.diagnostics,
    ...findNonFiniteNumericLiteralDiagnostics(parsed.program),
  ]);
  const hasParserErrors = hasErrors(parserDiagnostics);
  const semantic = hasParserErrors
    ? Object.freeze({ diagnostics: Object.freeze([]) })
    : validateSemantics(parsed.program, {
        ...options,
        builtins: Object.freeze([
          ...CORE_RUNTIME_BUILTINS,
          ...(options.builtins ?? []),
        ]),
      });
  const diagnostics = Object.freeze([
    ...parserDiagnostics,
    ...semantic.diagnostics,
  ]);
  return Object.freeze({
    program: parsed.program,
    parserDiagnostics,
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
