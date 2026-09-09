import { createSourceSpan, type SourceSpan } from "../source.js";

/** Controlled failure while lowering parser-owned AST data. */
export class InstructionCompilationError extends Error {
  readonly span: SourceSpan;

  public constructor(
    readonly code: "TSC003",
    message: string,
    span: SourceSpan,
  ) {
    super(message);
    this.name = "InstructionCompilationError";
    this.span = createSourceSpan(span.start, span.end);
  }
}
