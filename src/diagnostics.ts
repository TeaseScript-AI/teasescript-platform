import type { DiagnosticCode, DiagnosticCodeSeverity } from "./diagnostic-codes.js";
import { createSourceSpan, type SourceSpan } from "./source.js";

export const DiagnosticSeverity = { Error: "error", Warning: "warning" } as const;

export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

/** A diagnostic with a registered code, at the severity that the code is registered with. */
export function createDiagnostic<C extends DiagnosticCode>(
  severity: DiagnosticCodeSeverity<C>,
  code: C,
  message: string,
  span: SourceSpan,
): Diagnostic {
  return Object.freeze({ severity, code, message, span: createSourceSpan(span.start, span.end) });
}
