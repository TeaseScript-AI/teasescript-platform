import { KEYWORD_TOKENS } from "../language-facts.js";
import { createSourceSpan, type SourceSpan } from "../source.js";
import { TokenKind, type Token } from "../token.js";

// Token classes, matching delimiters, and source spans, which the parser and the modules beside it share.

/** Tokens that open and close a nested group, which a scan for its matching end counts. */
const OPENING_DELIMITERS: ReadonlySet<TokenKind> = new Set([
  TokenKind.LeftParenthesis,
  TokenKind.LeftBracket,
  TokenKind.LeftBrace,
]);
const CLOSING_DELIMITERS: ReadonlySet<TokenKind> = new Set([
  TokenKind.RightParenthesis,
  TokenKind.RightBracket,
  TokenKind.RightBrace,
]);

const propertyNameKinds: ReadonlySet<TokenKind> = new Set([
  TokenKind.Identifier,
  TokenKind.KeywordSpeaker,
  TokenKind.KeywordSay,
  TokenKind.KeywordWait,
  TokenKind.KeywordAs,
  TokenKind.KeywordExit,
  TokenKind.KeywordLet,
  TokenKind.KeywordIf,
  TokenKind.KeywordElse,
  TokenKind.KeywordTrue,
  TokenKind.KeywordFalse,
  TokenKind.KeywordNull,
  TokenKind.KeywordNot,
  TokenKind.KeywordAnd,
  TokenKind.KeywordOr,
  TokenKind.KeywordSet,
  TokenKind.KeywordRepeat,
  TokenKind.KeywordFor,
  TokenKind.KeywordIn,
  TokenKind.KeywordWhile,
  TokenKind.KeywordBreak,
  TokenKind.KeywordContinue,
  TokenKind.KeywordFunction,
  TokenKind.KeywordReturn,
  TokenKind.KeywordIs,
  TokenKind.KeywordOtherwise,
]);

export function isPropertyName(token: Token): boolean {
  return propertyNameKinds.has(token.kind);
}

export function isExpressionStart(token: Token): boolean {
  return (
    token.kind === TokenKind.Identifier ||
    token.kind === TokenKind.NumberLiteral ||
    token.kind === TokenKind.StringStart ||
    token.kind === TokenKind.RegexLiteral ||
    token.kind === TokenKind.KeywordSpeaker ||
    token.kind === TokenKind.KeywordSay ||
    token.kind === TokenKind.KeywordWait ||
    token.kind === TokenKind.KeywordTrue ||
    token.kind === TokenKind.KeywordFalse ||
    token.kind === TokenKind.KeywordNull ||
    token.kind === TokenKind.KeywordSet ||
    token.kind === TokenKind.KeywordNot ||
    // `!`, which the parser reads as `not` once it reported it.
    token.kind === TokenKind.Bang ||
    token.kind === TokenKind.LeftParenthesis ||
    token.kind === TokenKind.LeftBracket ||
    token.kind === TokenKind.LeftBrace ||
    token.kind === TokenKind.Plus ||
    token.kind === TokenKind.Minus
  );
}

/** Whether a token is a word: an identifier, or a keyword that the lexer reads as a token of its own. */
export function isWord(token: Token): boolean {
  return token.kind === TokenKind.Identifier || KEYWORD_TOKENS.get(token.lexeme) === token.kind;
}

export function spanFrom(start: SourceSpan, end: SourceSpan): SourceSpan {
  return createSourceSpan(start.start, end.end);
}

export function copySpan(span: SourceSpan): SourceSpan {
  return createSourceSpan(span.start, span.end);
}

/**
 * For each token, whether the innermost delimiter around it is `(` or `[`. A block, an object, or text inside them
 * starts again, so a newline there ends a statement as usual.
 */
export function delimiterClosers(tokens: readonly Token[]): Map<number, number> {
  const closers = new Map<number, number>();
  const open: number[] = [];
  tokens.forEach((token, index) => {
    if (OPENING_DELIMITERS.has(token.kind)) open.push(index);
    else if (CLOSING_DELIMITERS.has(token.kind)) {
      const opener = open.pop();
      if (opener !== undefined) closers.set(opener, index);
    }
  });
  return closers;
}
