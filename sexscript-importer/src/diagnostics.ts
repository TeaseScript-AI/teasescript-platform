import type { SourceSpan } from "./ast.ts";
import type { MigrationDiagnostic } from "./ir.ts";

/** Statement-level codes that only report that a nested expression could not be migrated. */
const WRAPPER_DIAGNOSTIC_CODES = new Set([
  "SX_SAVE_ARGUMENT",
  "SX_UNSUPPORTED_ARGUMENT",
  "SX_UNSUPPORTED_ASSIGNMENT_TARGET",
  "SX_UNSUPPORTED_ASSIGNMENT_VALUE",
  "SX_UNSUPPORTED_CALL",
  "SX_UNSUPPORTED_DECLARATION_VALUE",
  "SX_UNSUPPORTED_EXPRESSION_STATEMENT",
  "SX_UNSUPPORTED_FOR",
  "SX_UNSUPPORTED_FUNCTION_RETURN",
  "SX_UNSUPPORTED_HELPER_CALL",
  "SX_UNSUPPORTED_IF",
  "SX_UNSUPPORTED_WHILE",
]);

/** Removes wrapper diagnostics that merely repeat a more specific nested root cause. */
export function rootDiagnostics(diagnostics: MigrationDiagnostic[]): MigrationDiagnostic[] {
  const exact = new Map<string, MigrationDiagnostic>();
  const withoutSpan: MigrationDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.span == null) {
      withoutSpan.push(diagnostic);
      continue;
    }
    const key = spanKey(diagnostic.span);
    const current = exact.get(key);
    if (current === undefined || (isWrapper(current) && !isWrapper(diagnostic))) {
      exact.set(key, diagnostic);
    }
  }

  const located = [...exact.values()];
  const roots = located.filter((candidate) => {
    if (!isWrapper(candidate)) return true;
    const candidateSpan = candidate.span;
    if (candidateSpan == null) return true;
    return !located.some(
      (other) =>
        other !== candidate && other.span != null && strictlyContains(candidateSpan, other.span),
    );
  });
  return [...withoutSpan, ...roots];
}

function isWrapper(diagnostic: MigrationDiagnostic): boolean {
  return WRAPPER_DIAGNOSTIC_CODES.has(diagnostic.code);
}

function strictlyContains(outer: SourceSpan, inner: SourceSpan): boolean {
  const startsBeforeOrEqual =
    comparePosition(outer.line, outer.column, inner.line, inner.column) <= 0;
  const endsAfterOrEqual =
    comparePosition(outer.endLine, outer.endColumn, inner.endLine, inner.endColumn) >= 0;
  return startsBeforeOrEqual && endsAfterOrEqual && spanKey(outer) !== spanKey(inner);
}

function comparePosition(
  leftLine: number,
  leftColumn: number,
  rightLine: number,
  rightColumn: number,
): number {
  if (leftLine !== rightLine) return leftLine - rightLine;
  return leftColumn - rightColumn;
}

function spanKey(span: SourceSpan): string {
  return `${span.line}:${span.column}:${span.endLine}:${span.endColumn}`;
}
