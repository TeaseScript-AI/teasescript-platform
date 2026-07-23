export {
  createDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from "./diagnostics.js";
export { lex, type LexResult } from "./lexer.js";
export {
  combineSourceSpans,
  createSourcePosition,
  createSourceSpan,
  type SourcePosition,
  type SourceSpan,
} from "./source.js";
export { createToken, TokenKind, type Token } from "./token.js";
