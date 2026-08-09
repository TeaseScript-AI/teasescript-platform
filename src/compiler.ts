import type { Program } from "./ast.js";
import { findNonFiniteNumericLiteralDiagnosticsInStableProgram } from "./ast-validation.js";
import {
  createDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from "./diagnostics.js";
import { compileStableProgram, type InstructionPlan } from "./compiler/compile-program.js";
import { parse } from "./parser.js";
import { findExternalDataFailure } from "./external-data-limits.js";
import { validateInstructionPlan } from "./plan/validation.js";
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
    const diagnostic = planCaptureBudgetDiagnostic(compiled)
      ?? interactionPlanValidationDiagnostic(compiled);
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

function planCaptureBudgetDiagnostic(
  plan: InstructionPlan,
): Diagnostic | null {
  const failure = findExternalDataFailure(plan);
  if (failure === null || (failure.kind !== "work" && failure.kind !== "depth")) {
    return null;
  }

  return createDiagnostic(
    DiagnosticSeverity.Error,
    "TSC006",
    "This source lowers to an instruction plan that exceeds the current plan-validation budget for this source shape.",
    plan.sourceSpan,
  );
}

function interactionPlanValidationDiagnostic(
  plan: InstructionPlan,
): Diagnostic | null {
  if (!plan.instructions.some((instruction) => instruction.kind === "interaction")) {
    return null;
  }
  const validation = validateInstructionPlan(plan);
  const match = validation.errors.flatMap((error) => {
    const instructionMatch = /^\$\.instructions\[(\d+)\]/u.exec(error.path);
    if (instructionMatch === null) return [];
    const instructionIndex = Number(instructionMatch[1]);
    if (!Number.isSafeInteger(instructionIndex) || plan.instructions[instructionIndex]?.kind !== "interaction") {
      return [];
    }
    return [{ error, instructionIndex }];
  })[0];
  if (match === undefined) return null;

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
