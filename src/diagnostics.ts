import { createSourceSpan, type SourceSpan } from "./source.js";

export const DiagnosticSeverity = {
  Error: "error",
  Warning: "warning",
} as const;

export type DiagnosticSeverity =
  (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

export function createDiagnostic(
  severity: DiagnosticSeverity,
  code: string,
  message: string,
  span: SourceSpan,
): Diagnostic {
  return Object.freeze({
    severity,
    code,
    message,
    span: createSourceSpan(span.start, span.end),
  });
}
