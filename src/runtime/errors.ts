import { createSourceSpan, type SourceSpan } from "../source.js";

export interface RuntimeErrorInfo {
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

export class RuntimeFault extends Error {
  public readonly code: string;
  public readonly span: SourceSpan;

  public constructor(code: string, message: string, span: SourceSpan) {
    super(message);
    this.name = "RuntimeFault";
    this.code = code;
    this.span = createSourceSpan(span.start, span.end);
  }

  public toInfo(): RuntimeErrorInfo {
    return Object.freeze({
      code: this.code,
      message: this.message,
      span: createSourceSpan(this.span.start, this.span.end),
    });
  }
}
