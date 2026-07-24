import type { Program } from "./ast.js";
import {
  createDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from "./diagnostics.js";
import type { SourceSpan } from "./source.js";

export const AST_VALIDATION_CODES = {
  nonFiniteNumericLiteral: "TSC001",
} as const;

/** Returns compiler diagnostics for numeric literals that cannot enter JSON-safe plans. */
export function findNonFiniteNumericLiteralDiagnostics(
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
          AST_VALIDATION_CODES.nonFiniteNumericLiteral,
          "Numeric literal must evaluate to a finite number.",
          node.span as SourceSpan,
        ),
      );
      return;
    }

    for (const nested of Object.values(value)) visit(nested);
  }
}
