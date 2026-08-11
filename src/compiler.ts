import type { Program } from "./ast.js";
import { findNonFiniteNumericLiteralDiagnosticsInStableProgram } from "./ast-validation.js";
import {
  createDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from "./diagnostics.js";
import { compileStableProgram, type InstructionPlan } from "./compiler/compile-program.js";
import { parse } from "./parser.js";
import { validateCapturedInstructionPlan } from "./plan/validation.js";
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
    ...findNonFiniteNumericLiteralDiagnosticsInStableProgram(parsed.program),
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
  let plan: InstructionPlan | null = null;
  const loweringDiagnostics: Diagnostic[] = [];
  if (!hasParserErrors && !hasErrors(semantic.diagnostics)) {
    const compiled = compileStableProgram(parsed.program);
    const diagnostic = compiledPlanValidationDiagnostic(compiled);
    if (diagnostic === null) {
      plan = compiled;
    } else {
      loweringDiagnostics.push(diagnostic);
    }
  }
  const diagnostics = Object.freeze([
    ...parserDiagnostics,
    ...semantic.diagnostics,
    ...loweringDiagnostics,
  ]);
  return Object.freeze({
    program: parsed.program,
    parserDiagnostics,
    semanticDiagnostics: semantic.diagnostics,
    diagnostics,
    plan,
  });
}

function compiledPlanValidationDiagnostic(
  plan: InstructionPlan,
): Diagnostic | null {
  const validation = validateCapturedInstructionPlan(plan);
  if (validation.valid) return null;
  const match = validation.errors.flatMap((error) => {
    const instructionMatch = /^\$\.instructions\[(\d+)\]/u.exec(error.path);
    if (instructionMatch === null) return [];
    const instructionIndex = Number(instructionMatch[1]);
    if (!Number.isSafeInteger(instructionIndex) || plan.instructions[instructionIndex]?.kind !== "interaction") {
      return [];
    }
    return [{ error, instructionIndex }];
  })[0];
  if (match === undefined) {
    return createDiagnostic(
      DiagnosticSeverity.Error,
      "TSC006",
      `Compiled instruction plan is invalid: ${validation.errors[0]!.message}`,
      plan.sourceSpan,
    );
  }

  return createDiagnostic(
    DiagnosticSeverity.Error,
    "TSC006",
    `Compiled interaction data is rejected by the current instruction-plan validation boundary: ${match.error.message}`,
    plan.instructions[match.instructionIndex]!.span,
  );
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic) => diagnostic.severity === DiagnosticSeverity.Error,
  );
}
