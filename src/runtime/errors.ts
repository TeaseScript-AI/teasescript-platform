import { createSourceSpan, type SourceSpan } from "../source.js";

export interface RuntimeErrorInfo {
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

/**
 * The message of a failure that the plan, the engine's state, or the host causes rather than the script: what failed,
 * worded for a bug report, then that the script is not at fault.
 */
export function internalFault(what: string): string {
  return `${what} This is a fault in the Playroom, not in the script. Report it with a debug export.`;
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
