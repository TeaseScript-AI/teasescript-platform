import { createSourceSpan, type SourceSpan } from "./source.js";

export const TokenKind = {
  Identifier: "identifier",
  KeywordSpeaker: "keywordSpeaker",
  KeywordSay: "keywordSay",
  KeywordAs: "keywordAs",
  KeywordExit: "keywordExit",
  LeftBrace: "leftBrace",
  RightBrace: "rightBrace",
  Colon: "colon",
  Dot: "dot",
  StringLiteral: "stringLiteral",
  TemplateStart: "templateStart",
  TemplateText: "templateText",
  InterpolationStart: "interpolationStart",
  InterpolationEnd: "interpolationEnd",
  TemplateEnd: "templateEnd",
  Newline: "newline",
  EndOfFile: "endOfFile",
} as const;

export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

type TokenWithValueKind =
  | typeof TokenKind.Identifier
  | typeof TokenKind.StringLiteral
  | typeof TokenKind.TemplateText;

type TokenWithoutValueKind = Exclude<TokenKind, TokenWithValueKind>;

interface TokenBase {
  readonly lexeme: string;
  readonly span: SourceSpan;
}

interface TokenWithValue extends TokenBase {
  readonly kind: TokenWithValueKind;
  readonly value: string;
}

interface TokenWithoutValue extends TokenBase {
  readonly kind: TokenWithoutValueKind;
}

export type Token = TokenWithValue | TokenWithoutValue;

export function createToken(token: Token): Token {
  const span = createSourceSpan(token.span.start, token.span.end);

  if ("value" in token) {
    return Object.freeze({
      kind: token.kind,
      lexeme: token.lexeme,
      value: token.value,
      span,
    });
  }

  return Object.freeze({
    kind: token.kind,
    lexeme: token.lexeme,
    span,
  });
}
