import { createSourceSpan, type SourceSpan } from "../source.js";

export interface RuntimeWarningInfo {
  readonly kind: "developerWarning";
  readonly severity: "warning";
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

export function createRuntimeWarning(
  code: string,
  message: string,
  span: SourceSpan,
): RuntimeWarningInfo {
  return Object.freeze({
    kind: "developerWarning",
    severity: "warning",
    code,
    message,
    span: createSourceSpan(span.start, span.end),
  });
}
