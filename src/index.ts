export {
  createDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from "./diagnostics.js";
export { lex, type LexResult } from "./lexer.js";
export { parse, type ParseResult } from "./parser.js";
export {
  combineSourceSpans,
  createSourcePosition,
  createSourceSpan,
  type SourcePosition,
  type SourceSpan,
} from "./source.js";
export { createToken, TokenKind, type Token } from "./token.js";
export type {
  ExitStatement,
  Identifier,
  InterpolationExpression,
  Program,
  PropertyAccessExpression,
  SayStatement,
  SpeakerDeclaration,
  SpeakerProperty,
  SpeakerSetterStatement,
  Statement,
  StringExpression,
  StringLiteral,
  TemplateInterpolation,
  TemplateLiteral,
  TemplatePart,
  TemplateText,
} from "./ast.js";
