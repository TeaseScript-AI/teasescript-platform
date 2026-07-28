import { createSourceSpan, type SourceSpan } from "../source.js";

/** Controlled compiler-boundary failure for semantically invalid AST input. */
export class InstructionCompilationError extends Error {
  readonly span: SourceSpan;

  public constructor(
    readonly code: "TSC001" | "TSC003" | "TSC005",
    message: string,
    span: SourceSpan,
  ) {
    super(message);
    this.name = "InstructionCompilationError";
    this.span = createSourceSpan(span.start, span.end);
  }
}
