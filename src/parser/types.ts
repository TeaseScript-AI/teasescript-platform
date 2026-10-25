import { parseChild, runParse, type ParseTask } from "../parse-continuation.js";
import type { TypeAnnotation, TypeName } from "../ast.js";
import { KEYWORD_TOKENS } from "../language-facts.js";
import { VALUE_KIND_NAMES, VALUE_KINDS } from "../value-kinds.js";
import { TokenKind, type Token } from "../token.js";
import type { Parser } from "../parser.js";
import { parserDiagnosticCode } from "./diagnostic-codes.js";
import { spanFrom } from "./tokens.js";

// Type annotations and the types of `is` tests.

/**
 * How a type continues (V30 §1): a statement type ends at a newline; inside `()`, a newline may also precede `|` or
 * a postfix form; and the type of an `is` test also ends before `||`, the rejected symbolic `or` (V30 §5).
 */
type TypeContext = "statement" | "delimited" | "typeTest" | "delimitedTypeTest";

export function parseTypeAnnotation(
  parser: Parser,
  context: TypeContext = "statement",
): TypeAnnotation | null {
  return runParse(parseTypeTask(parser, context));
}

/** A type: postfix types separated by `|` (ADR 0021). A newline may always follow `|` or `(`. */
export function* parseTypeTask(
  parser: Parser,
  context: TypeContext,
): ParseTask<TypeAnnotation | null> {
  const members: TypeAnnotation[] = [];
  do {
    if (members.length > 0) parser.skipContinuationNewlines();
    const member = yield* parseChild(parsePostfixTypeTask(parser, context));
    if (member === null) return null;
    members.push(member);
  } while (matchTypeOperator(parser, TokenKind.Pipe, context));
  if (members.length === 1) return members[0]!;
  return Object.freeze({
    kind: "unionType",
    members: Object.freeze(members),
    span: spanFrom(members[0]!.span, members.at(-1)!.span),
  });
}

/** A type name or a parenthesized type, followed by any number of `[]`, `set`, `dict`, and `?` in source order. */
function* parsePostfixTypeTask(
  parser: Parser,
  context: TypeContext,
): ParseTask<TypeAnnotation | null> {
  const first = parser.peek();
  let type: TypeAnnotation;
  if (parser.match(TokenKind.LeftParenthesis)) {
    parser.skipContinuationNewlines();
    const inner = yield* parseChild(parseTypeTask(parser, "delimited"));
    if (inner === null) return null;
    parser.skipContinuationNewlines();
    if (!parser.match(TokenKind.RightParenthesis)) {
      parser.reportMissingCloser(
        parserDiagnosticCode.expectedDelimiter,
        "Expected ')' after the grouped type.",
      );
      return null;
    }
    type = inner;
  } else {
    const name = typeName(first);
    if (name === undefined) {
      parser.reportToken(
        parserDiagnosticCode.invalidType,
        first.kind === TokenKind.Identifier
          ? `'${first.lexeme}' is not a type. Use a type such as string, integer, number, boolean, duration, or a list type such as string[].`
          : "Expected a type such as string, integer, number, boolean, duration, or a list type such as string[].",
        first,
      );
      return null;
    }
    const renamed = RENAMED_TYPE_NAMES.get(first.lexeme);
    if (first.kind === TokenKind.Identifier && renamed !== undefined)
      parser.reportToken(
        parserDiagnosticCode.invalidType,
        `'${first.lexeme}' is not a type. Use '${renamed}'.`,
        first,
      );
    parser.advance();
    type = Object.freeze({ kind: "namedType", name, span: first.span });
  }
  for (;;) {
    if (matchTypeOperator(parser, TokenKind.LeftBracket, context)) {
      if (!parser.match(TokenKind.RightBracket)) {
        parser.reportInsertion(
          parserDiagnosticCode.expectedDelimiter,
          "Expected ']' in the list type.",
        );
        return null;
      }
      type = Object.freeze({
        kind: "listType",
        element: type,
        span: spanFrom(first.span, parser.previous().span),
      });
    } else if (matchTypeOperator(parser, TokenKind.KeywordSet, context)) {
      type = Object.freeze({
        kind: "setType",
        element: type,
        span: spanFrom(first.span, parser.previous().span),
      });
    } else if (matchDictTypeOperator(parser, context)) {
      type = Object.freeze({
        kind: "dictType",
        element: type,
        span: spanFrom(first.span, parser.previous().span),
      });
    } else if (matchTypeOperator(parser, TokenKind.Question, context)) {
      type = Object.freeze({
        kind: "optionalType",
        value: type,
        span: spanFrom(first.span, parser.previous().span),
      });
    } else {
      return type;
    }
  }
}

/** Matches the contextual type operator `dict` in `T dict`, which is a name rather than a keyword token. */
function matchDictTypeOperator(parser: Parser, context: TypeContext): boolean {
  let offset = 0;
  if (context === "delimited" || context === "delimitedTypeTest") {
    while (parser.peek(offset).kind === TokenKind.Newline) offset += 1;
  }
  const token = parser.peek(offset);
  if (token.kind !== TokenKind.Identifier || token.lexeme !== "dict") return false;
  parser.skipContinuationNewlines();
  parser.advance();
  return true;
}

/** Matches `|` or a postfix type operator where the type's `context` lets it continue the type. */
function matchTypeOperator(parser: Parser, kind: TokenKind, context: TypeContext): boolean {
  let offset = 0;
  if (context === "delimited" || context === "delimitedTypeTest") {
    while (parser.peek(offset).kind === TokenKind.Newline) offset += 1;
  }
  if (parser.peek(offset).kind !== kind) return false;
  if (
    (context === "typeTest" || context === "delimitedTypeTest") &&
    kind === TokenKind.Pipe &&
    parser.peek(offset + 1).kind === TokenKind.Pipe
  ) {
    return false;
  }
  parser.skipContinuationNewlines();
  parser.advance();
  return true;
}

/**
 * The type names that are identifiers: every kind that an annotation writes (`VALUE_KINDS`), but those that the lexer
 * reads as a token of their own, `speaker`, `set`, and `null` (`typeName`).
 */
const IDENTIFIER_TYPE_NAMES: ReadonlyMap<string, TypeName> = new Map(
  VALUE_KIND_NAMES.filter(
    (kind): kind is TypeName => VALUE_KINDS[kind].written && !KEYWORD_TOKENS.has(kind),
  ).map((name) => [name, name]),
);

/** The earlier names of types, which are compile errors that name the fix (ADR 0026). */
const RENAMED_TYPE_NAMES: ReadonlyMap<string, TypeName> = new Map([
  ["timestamp", "absoluteDateTime"],
]);

/** The type name a token spells in type position; `speaker`, `set`, and `null` are keywords elsewhere. */
export function typeName(token: Token): TypeName | undefined {
  switch (token.kind) {
    case TokenKind.Identifier:
      return IDENTIFIER_TYPE_NAMES.get(token.lexeme) ?? RENAMED_TYPE_NAMES.get(token.lexeme);
    case TokenKind.KeywordSpeaker:
      return "speaker";
    case TokenKind.KeywordSet:
      return "set";
    case TokenKind.KeywordNull:
      return "null";
    default:
      return undefined;
  }
}
