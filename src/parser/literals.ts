import { parseChild, type ParseTask } from "../parse-continuation.js";
import type {
  Expression,
  ObjectLiteral,
  ObjectProperty,
  ParenthesizedExpression,
  ListLiteral,
  SetLiteral,
  DictEntry,
  DictLiteral,
  StringInterpolation,
  StringLiteral,
  StringPart,
  StringText,
} from "../ast.js";
import { TokenKind, type Token } from "../token.js";
import type { Parser } from "../parser.js";
import { parserDiagnosticCode } from "./diagnostic-codes.js";
import { copySpan, isPropertyName, spanFrom } from "./tokens.js";
import { allowCalendarDuration } from "./units.js";

// Literals: parentheses, lists and sets, objects, dicts, and strings with their interpolations.

export function* parseParenthesized(
  parser: Parser,
  start: Token,
): ParseTask<ParenthesizedExpression | null> {
  parser.skipNewlines();
  if (parser.atGroupEnd(true)) {
    parser.reportMissingCloser(parserDiagnosticCode.expectedExpression, "Expected an expression.");
    return null;
  }
  const expression = yield* parseChild(parser.parseRequiredExpressionTask());
  parser.skipNewlines();
  if (expression === null || !parser.match(TokenKind.RightParenthesis)) {
    if (expression !== null) {
      parser.reportMissingCloser(
        parserDiagnosticCode.expectedDelimiter,
        "Expected ')' after the expression.",
      );
    }
    return null;
  }
  return Object.freeze({
    kind: "parenthesizedExpression",
    expression,
    span: spanFrom(start.span, parser.previous().span),
  });
}

export function* parseCollectionLiteralElements(
  parser: Parser,
  start: Token,
  kind: "listLiteral" | "setLiteral",
): ParseTask<ListLiteral | SetLiteral> {
  const elements = yield* parseChild(parseDelimitedElements(parser, TokenKind.RightBracket));
  const end = parser.consumeClosingDelimiter(
    TokenKind.RightBracket,
    kind === "listLiteral"
      ? "Expected ']' after the list literal."
      : "Expected ']' after the set literal.",
  );
  return Object.freeze({
    kind,
    elements: Object.freeze(elements),
    span: spanFrom(start.span, end),
  });
}

function* parseDelimitedElements(parser: Parser, closing: TokenKind): ParseTask<Expression[]> {
  const elements: Expression[] = [];
  parser.skipNewlines();
  while (!parser.check(closing) && !parser.check(TokenKind.EndOfFile)) {
    if (parser.atGroupEnd(true)) break;
    const value = yield* parseChild(parser.parseRequiredExpressionTask());
    if (value === null) {
      parser.synchronizeDelimited(closing);
    } else {
      elements.push(value);
    }
    parser.skipNewlines();
    if (!parser.match(TokenKind.Comma)) break;
    parser.skipNewlines();
    if (parser.check(closing)) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected a collection element after ','.",
      );
      break;
    }
  }
  return elements;
}

export function* parseObjectLiteral(parser: Parser, start: Token): ParseTask<ObjectLiteral> {
  const properties: ObjectProperty[] = [];
  parser.skipNewlines();
  while (!parser.check(TokenKind.RightBrace) && !parser.check(TokenKind.EndOfFile)) {
    // A literal left open ends as after `let o = {` (see `atGroupEnd`); `let: 1` stays a property.
    if (parser.atGroupEnd(false)) break;
    if (!isPropertyName(parser.peek())) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedPropertyName,
        "Expected an object property name.",
      );
      parser.synchronizeDelimited(TokenKind.RightBrace);
      break;
    }
    const name = parser.identifier(parser.advance());
    if (!parser.match(TokenKind.Colon)) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedColon,
        "Expected ':' after the object property name.",
      );
      parser.synchronizeDelimited(TokenKind.RightBrace);
      break;
    }
    const value = yield* parseChild(parser.parseColonValueTask(true));
    if (value === null) break;
    properties.push(
      Object.freeze({ kind: "objectProperty", name, value, span: spanFrom(name.span, value.span) }),
    );
    parser.skipNewlines();
    if (!parser.match(TokenKind.Comma)) break;
    parser.skipNewlines();
    if (parser.check(TokenKind.RightBrace)) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedPropertyName,
        "Expected an object property after ','.",
      );
      break;
    }
  }
  const end = parser.consumeClosingDelimiter(
    TokenKind.RightBrace,
    "Expected '}' after the object literal.",
  );
  return Object.freeze({
    kind: "objectLiteral",
    properties: Object.freeze(properties),
    span: spanFrom(start.span, end),
  });
}

/** `dict{ ... }` after its `{`: entries `key: value`, where a key is a name, quoted text, or `[expression]`. */
export function* parseDictLiteral(parser: Parser, start: Token): ParseTask<DictLiteral> {
  const entries: DictEntry[] = [];
  parser.skipNewlines();
  while (!parser.check(TokenKind.RightBrace) && !parser.check(TokenKind.EndOfFile)) {
    // As in an object literal, a dict left open ends where its group must have (see `atGroupEnd`).
    if (parser.atGroupEnd(false)) break;
    const keyStart = parser.peek();
    const key = yield* parseChild(parseDictKey(parser));
    if (key === null) {
      parser.synchronizeDelimited(TokenKind.RightBrace);
      break;
    }
    if (!parser.match(TokenKind.Colon)) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedColon,
        "Expected ':' after the dict key.",
      );
      parser.synchronizeDelimited(TokenKind.RightBrace);
      break;
    }
    const value = yield* parseChild(parser.parseColonValueTask(true));
    if (value === null) break;
    entries.push(
      Object.freeze({ kind: "dictEntry", key, value, span: spanFrom(keyStart.span, value.span) }),
    );
    parser.skipNewlines();
    if (!parser.match(TokenKind.Comma)) break;
    parser.skipNewlines();
    if (parser.check(TokenKind.RightBrace)) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedPropertyName,
        "Expected a dict entry after ','.",
      );
      break;
    }
  }
  const end = parser.consumeClosingDelimiter(
    TokenKind.RightBrace,
    "Expected '}' after the dict literal.",
  );
  return Object.freeze({
    kind: "dictLiteral",
    entries: Object.freeze(entries),
    span: spanFrom(start.span, end),
  });
}

/** A dict key: quoted text, `[expression]`, or a name, which is its own text. */
function* parseDictKey(parser: Parser): ParseTask<Expression | null> {
  const token = parser.peek();
  if (parser.match(TokenKind.StringStart))
    return yield* parseChild(parseStringLiteral(parser, token));
  if (parser.match(TokenKind.LeftBracket)) {
    parser.skipNewlines();
    const key = yield* parseChild(parser.parseRequiredExpressionTask());
    if (key === null) return null;
    parser.skipNewlines();
    if (!parser.match(TokenKind.RightBracket)) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedDelimiter,
        "Expected ']' after the computed dict key.",
      );
      return null;
    }
    return key;
  }
  if (!isPropertyName(token)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedPropertyName,
      "Expected a dict key: a name, quoted text, or [expression].",
    );
    return null;
  }
  parser.advance();
  const text: StringText = Object.freeze({
    kind: "stringText",
    raw: token.lexeme,
    value: token.lexeme,
    span: copySpan(token.span),
  });
  return Object.freeze({
    kind: "stringLiteral",
    form: "singleLine",
    parts: Object.freeze([text]),
    span: copySpan(token.span),
  });
}

export function* parseStringLiteral(parser: Parser, start: Token): ParseTask<StringLiteral | null> {
  const parts: StringPart[] = [];
  let valid = true;
  let recovered = false;
  while (!parser.check(TokenKind.StringEnd) && !parser.check(TokenKind.EndOfFile)) {
    if (parser.match(TokenKind.StringText)) {
      parts.push(parser.stringText(parser.previous()));
      continue;
    }
    if (parser.match(TokenKind.InterpolationStart)) {
      const diagnosticCount = parser.diagnostics.length;
      // An interpolation without an expression is left out.
      const interpolation = yield* parseChild(parseStringInterpolation(parser, parser.previous()));
      if (interpolation !== null) parts.push(interpolation);
      // Also when only the lexer reported a missing `}`.
      recovered ||=
        interpolation === null ||
        parser.diagnostics.length !== diagnosticCount ||
        parser.previous().kind !== TokenKind.InterpolationEnd;
      continue;
    }
    parser.reportToken(
      parserDiagnosticCode.unsupportedStringExpression,
      "Unexpected token in string.",
      parser.peek(),
    );
    valid = false;
    parser.advance();
  }
  // The lexer reported a string that reaches the end of the file.
  if (!parser.match(TokenKind.StringEnd)) {
    parser.unclosedLiterals += 1;
    return null;
  }
  if (!valid) return null;
  const literal: StringLiteral = Object.freeze({
    kind: "stringLiteral",
    form: start.lexeme.length === 3 ? "block" : "singleLine",
    parts: Object.freeze(parts),
    span: spanFrom(start.span, parser.previous().span),
  });
  if (recovered) parser.shared.recoveredStrings.add(literal);
  return literal;
}

function* parseStringInterpolation(
  parser: Parser,
  start: Token,
): ParseTask<StringInterpolation | null> {
  parser.skipNewlines();
  if (parser.check(TokenKind.InterpolationEnd)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedStringExpression,
      "Expected an expression inside the string interpolation.",
    );
    parser.advance();
    return null;
  }
  if (parser.check(TokenKind.StringEnd) || parser.check(TokenKind.EndOfFile)) {
    return null;
  }
  const mark = parser.mark();
  const expression = yield* parseChild(parser.parseOr());
  // Only a failure that reported nothing itself gets an error here.
  const reported = parser.diagnostics.length !== mark.diagnostics;
  if (expression === null) {
    parser.reportMissing(
      mark,
      parserDiagnosticCode.unsupportedStringExpression,
      "Expected a supported expression inside the string interpolation.",
      parser.peek().span,
    );
    parser.synchronizeInterpolation();
    parser.match(TokenKind.InterpolationEnd);
    return null;
  }
  // Interpolation shows any value.
  allowCalendarDuration(parser, expression);
  parser.skipNewlines();
  if (!parser.match(TokenKind.InterpolationEnd)) {
    if (!reported && !parser.check(TokenKind.StringEnd) && !parser.check(TokenKind.EndOfFile)) {
      const message = parser.check(TokenKind.Colon)
        ? "Only identifiers and chained property access are supported in string interpolation."
        : "Only one complete expression is allowed in string interpolation.";
      parser.reportToken(parserDiagnosticCode.unsupportedStringExpression, message, parser.peek());
    }
    parser.synchronizeInterpolation();
    parser.match(TokenKind.InterpolationEnd);
  }
  // An expression that reported an error, or that more follows, stays as written so far: the error is reported once.
  return Object.freeze({
    kind: "stringInterpolation",
    expression,
    span: spanFrom(start.span, parser.previous().span),
  });
}
