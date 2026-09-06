import type { SourceSpan } from "../source.js";

export interface RuntimeWarningInfo {
  readonly kind: "developerWarning";
  readonly severity: "warning";
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}
