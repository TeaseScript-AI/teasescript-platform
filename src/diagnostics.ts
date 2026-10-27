import type { DiagnosticCode, DiagnosticCodeSeverity } from "./diagnostic-codes.js";
import { createSourceSpan, type SourceSpan } from "./source.js";

/**
 * How strongly a diagnostic speaks: an error stops the compile; a warning and an information compile, the information
 * a note the editor shows at its information level (the new checker's "not checked (budget)", TABLE r4.54).
 */
export const DiagnosticSeverity = { Error: "error", Warning: "warning", Info: "info" } as const;

export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

/** A diagnostic with a registered code, at one of the severities that the code is registered with. */
export function createDiagnostic<C extends DiagnosticCode>(
  severity: DiagnosticCodeSeverity<C>,
  code: C,
  message: string,
  span: SourceSpan,
): Diagnostic {
  return Object.freeze({ severity, code, message, span: createSourceSpan(span.start, span.end) });
}
