import { parseChild, runParse, type ParseTask } from "../parse-continuation.js";
import type {
  Expression,
  FunctionDeclaration,
  GlobalStatement,
  FunctionParameter,
  LetStatement,
  ReturnStatement,
  TypeAnnotation,
} from "../ast.js";
import { TokenKind, type Token } from "../token.js";
import type { Parser } from "../parser.js";
import { parserDiagnosticCode } from "./diagnostic-codes.js";
import { copySpan, spanFrom } from "./tokens.js";
import { parseTypeAnnotation } from "./types.js";

// Declarations: `let`, `global`, and functions with their parameters and `return`.

export function parseLetStatement(parser: Parser): LetStatement | null {
  const keyword = parser.advance();
  if (!parser.checkDeclarationName()) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedIdentifier,
      "Expected a variable identifier after 'let'.",
    );
    parser.synchronizeStatement();
    return null;
  }
  const name = parser.declarationName("other");
  let typeAnnotation: TypeAnnotation | null = null;
  if (parser.match(TokenKind.Colon)) {
    typeAnnotation = parseTypeAnnotation(parser);
    if (typeAnnotation === null) {
      parser.synchronizeStatement();
      return null;
    }
  }
  if (!parser.match(TokenKind.Equal)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedEqual,
      "Expected '=' in the variable declaration.",
    );
    parser.synchronizeStatement();
    return null;
  }
  parser.skipContinuationNewlines();
  const initializer = parser.parseRequiredExpression();
  if (initializer === null) {
    parser.synchronizeStatement();
    return null;
  }
  return Object.freeze({
    kind: "letStatement",
    name,
    typeAnnotation,
    initializer,
    span: spanFrom(keyword.span, initializer.span),
  });
}

/**
 * `global function ...`, or `global name[: Type] = value[, default: start]`. Like the prefill of an ask, a
 * `, default:` belongs to the nearest construct before it that takes one, so `global level = load "level", default: 1`
 * gives the fallback to `load`.
 */
export function* parseGlobalStatement(
  parser: Parser,
): ParseTask<GlobalStatement | FunctionDeclaration | null> {
  const keyword = parser.advance();
  if (parser.check(TokenKind.KeywordFunction))
    return yield* parseChild(parseFunctionDeclaration(parser, keyword));
  if (!parser.checkDeclarationName()) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedIdentifier,
      "Expected a variable identifier or 'function' after 'global'.",
    );
    parser.synchronizeStatement();
    return null;
  }
  const name = parser.declarationName("other");
  let typeAnnotation: TypeAnnotation | null = null;
  if (parser.match(TokenKind.Colon)) {
    typeAnnotation = parseTypeAnnotation(parser);
    if (typeAnnotation === null) {
      parser.synchronizeStatement();
      return null;
    }
  }
  if (!parser.match(TokenKind.Equal)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedEqual,
      "Expected '=' in the global declaration.",
    );
    parser.synchronizeStatement();
    return null;
  }
  parser.skipContinuationNewlines();
  const value = parser.parseRequiredExpression();
  if (value === null) {
    parser.synchronizeStatement();
    return null;
  }
  const defaultOffset = parser.offsetAfterComma();
  if (defaultOffset === null || !parser.atNamedDefault(defaultOffset))
    return Object.freeze({
      kind: "globalStatement",
      name,
      typeAnnotation,
      initial: value,
      assignment: null,
      span: spanFrom(keyword.span, value.span),
    });
  for (let skipped = 0; skipped < defaultOffset + 2; skipped += 1) parser.advance();
  const start = yield* parseChild(parser.parseColonValueTask(true));
  if (start === null) {
    parser.synchronizeStatement();
    return null;
  }
  const span = spanFrom(keyword.span, start.span);
  return Object.freeze({
    kind: "globalStatement",
    name,
    typeAnnotation,
    initial: start,
    assignment: Object.freeze({
      kind: "assignmentStatement",
      operator: "=",
      target: name,
      value,
      span: copySpan(span),
    }),
    span,
  });
}

/** A function declaration; `globalKeyword` is the `global` before a global function. */
export function* parseFunctionDeclaration(
  parser: Parser,
  globalKeyword: Token | null,
): ParseTask<FunctionDeclaration | null> {
  const keyword = parser.advance();
  if (!parser.checkDeclarationName()) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedFunctionName,
      "Expected a function identifier after 'function'.",
    );
    parser.synchronizeStatement();
    return null;
  }
  const name = parser.declarationName("other");
  const parameters: FunctionParameter[] = [];
  if (parser.match(TokenKind.LeftParenthesis)) {
    parser.skipNewlines();
    if (parser.check(TokenKind.RightParenthesis)) {
      parser.reportToken(
        parserDiagnosticCode.emptyFunctionParameters,
        "Parentheses are omitted when a function has no parameters.",
        parser.peek(),
      );
    }
    while (!parser.check(TokenKind.RightParenthesis) && !parser.check(TokenKind.EndOfFile)) {
      const parameter = parseFunctionParameter(parser);
      if (parameter !== null) parameters.push(parameter);
      parser.skipNewlines();
      if (!parser.match(TokenKind.Comma)) break;
      parser.skipNewlines();
      if (parser.check(TokenKind.RightParenthesis)) {
        parser.reportInsertion(
          parserDiagnosticCode.expectedParameter,
          "Expected a function parameter after ','.",
        );
        break;
      }
    }
    if (!parser.match(TokenKind.RightParenthesis)) {
      parser.reportMissingCloser(
        parserDiagnosticCode.expectedDelimiter,
        "Expected ')' after the function parameters.",
      );
      parser.synchronizeStatement();
      return null;
    }
  }

  let returnTypeAnnotation: TypeAnnotation | null = null;
  if (parser.match(TokenKind.Colon)) {
    returnTypeAnnotation = parseTypeAnnotation(parser);
    if (returnTypeAnnotation === null) {
      parser.synchronizeStatement();
      return null;
    }
  }
  parser.skipContinuationNewlines();
  const body = yield* parseChild(parser.parseBlock());
  if (body === null) return null;
  return Object.freeze({
    kind: "functionDeclaration",
    global: globalKeyword !== null,
    name,
    parameters: Object.freeze(parameters),
    returnTypeAnnotation,
    body,
    span: spanFrom((globalKeyword ?? keyword).span, body.span),
  });
}

function parseFunctionParameter(parser: Parser): FunctionParameter | null {
  if (!parser.checkDeclarationName()) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedParameter,
      "Expected a function parameter identifier.",
    );
    parser.synchronizeParameter();
    return null;
  }
  const name = parser.declarationName("other");
  let typeAnnotation: TypeAnnotation | null = null;
  let end = name.span;
  if (parser.match(TokenKind.Colon)) {
    typeAnnotation = parseTypeAnnotation(parser, "delimited");
    if (typeAnnotation === null) {
      parser.synchronizeParameter();
      return null;
    }
    // To the type's last token, also a group's `)`.
    end = parser.previous().span;
  }
  let defaultValue: Expression | null = null;
  if (parser.match(TokenKind.Equal)) {
    parser.skipContinuationNewlines();
    // A parameter list is a `()` grouping, where a line break does not end the default.
    defaultValue = runParse(parser.withinDelimiters(parser.parseRequiredExpressionTask()));
    if (defaultValue === null) {
      parser.synchronizeParameter();
      return null;
    }
    end = defaultValue.span;
  }
  return Object.freeze({
    kind: "functionParameter",
    name,
    typeAnnotation,
    defaultValue,
    span: spanFrom(name.span, end),
  });
}

export function parseReturnStatement(parser: Parser): ReturnStatement | null {
  const keyword = parser.advance();
  if (
    parser.check(TokenKind.Newline) ||
    parser.check(TokenKind.RightBrace) ||
    parser.check(TokenKind.EndOfFile)
  ) {
    return Object.freeze({ kind: "returnStatement", value: null, span: copySpan(keyword.span) });
  }
  const value = parser.parseRequiredExpression();
  if (value === null) {
    parser.synchronizeStatement();
    return null;
  }
  return Object.freeze({
    kind: "returnStatement",
    value,
    span: spanFrom(keyword.span, value.span),
  });
}
