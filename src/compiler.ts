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

export class CompilerHostStackExhaustionError extends Error {
  public constructor(cause: Error) {
    super(
      "Host JavaScript stack exhaustion occurred while compiling source. Deep nesting can contribute; this is environment-specific and not a TeaseScript nesting limit.",
      { cause },
    );
    this.name = "CompilerHostStackExhaustionError";
  }
}

/** Parses, validates, and compiles source without executing it. */
export function compileSource(
  source: string,
  options: CompileOptions = {},
): CompilationResult {
  let parsed;
  try {
    parsed = parse(source);
  } catch (error) {
    if (isParserHostStackExhaustion(error)) {
      throw new CompilerHostStackExhaustionError(error);
    }
    throw error;
  }
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

function isParserHostStackExhaustion(error: unknown): error is Error {
  if (!(error instanceof Error) || typeof error.stack !== "string") return false;
  const recognizedRangeError =
    error instanceof RangeError && error.message === "Maximum call stack size exceeded";
  const recognizedSyntaxError =
    error instanceof SyntaxError &&
    error.message === "Invalid regular expression: /[.eE]/u: Stack overflow";
  if (!recognizedRangeError && !recognizedSyntaxError) return false;
  return /\bat #parse[A-Za-z]+ \(.*\/src\/parser\./u.test(error.stack);
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
