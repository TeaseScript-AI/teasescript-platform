import type { Program } from "./ast.js";
import {
  createDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from "./diagnostics.js";
import { compileProgram, type InstructionPlan } from "./instructions.js";
import { parse } from "./parser.js";
import { CORE_RUNTIME_BUILTINS } from "./protected-names.js";
import {
  validateSemantics,
  type SemanticValidationOptions,
} from "./semantic.js";
import type { SourceSpan } from "./source.js";

export interface CompileOptions extends SemanticValidationOptions {}

export interface CompilationResult {
  readonly program: Program;
  readonly parserDiagnostics: readonly Diagnostic[];
  readonly semanticDiagnostics: readonly Diagnostic[];
  readonly diagnostics: readonly Diagnostic[];
  readonly plan: InstructionPlan | null;
}

export { CORE_RUNTIME_BUILTINS } from "./protected-names.js";

const compilerDiagnosticCode = {
  nonFiniteNumericLiteral: "TSC001",
} as const;

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

function findNonFiniteNumericLiteralDiagnostics(
  program: Program,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  visit(program);
  return Object.freeze(diagnostics);

  function visit(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const nested of value) visit(nested);
      return;
    }

    const node = value as {
      readonly kind?: unknown;
      readonly value?: unknown;
      readonly span?: unknown;
    };
    if (
      node.kind === "numberLiteral" &&
      typeof node.value === "number" &&
      !Number.isFinite(node.value)
    ) {
      diagnostics.push(
        createDiagnostic(
          DiagnosticSeverity.Error,
          compilerDiagnosticCode.nonFiniteNumericLiteral,
          "Numeric literal must evaluate to a finite number.",
          node.span as SourceSpan,
        ),
      );
      return;
    }

    for (const nested of Object.values(value)) visit(nested);
  }
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic) => diagnostic.severity === DiagnosticSeverity.Error,
  );
}
