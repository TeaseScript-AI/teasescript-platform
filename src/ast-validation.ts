import type { Program } from "./ast.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { createCapturedArray } from "./external-data-capture.js";
import { createSourcePosition, createSourceSpan, type SourceSpan } from "./source.js";

export const AST_VALIDATION_CODES = { nonFiniteNumericLiteral: "TSC001" } as const;

const FALLBACK_SPAN = createSourceSpan(
  createSourcePosition(0, 0, 0),
  createSourcePosition(0, 0, 0),
);

/** Internal traversal for parser-owned AST data. */
export function findNonFiniteNumericLiteralDiagnosticsInStableProgram(
  program: Program,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const work = createCapturedArray(0);
  work.push(program);
  while (work.length > 0) {
    const value = work.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        work.push(value[index]);
      }
      continue;
    }
    // EVIDENCE: invariant: value is an object; these optional fields remain unknown until checked below.
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
          isSourceSpan(node.span) ? node.span : FALLBACK_SPAN,
        ),
      );
      continue;
    }
    for (const nested of Object.values(value)) work.push(nested);
  }
  return Object.freeze(diagnostics);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSourceSpan(value: unknown): value is SourceSpan {
  if (!isPlainRecord(value)) return false;
  return isSourcePosition(value.start) && isSourcePosition(value.end);
}

function isSourcePosition(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    Number.isSafeInteger(value.offset) &&
    typeof value.offset === "number" &&
    value.offset >= 0 &&
    Number.isSafeInteger(value.line) &&
    typeof value.line === "number" &&
    value.line >= 0 &&
    Number.isSafeInteger(value.column) &&
    typeof value.column === "number" &&
    value.column >= 0
  );
}
