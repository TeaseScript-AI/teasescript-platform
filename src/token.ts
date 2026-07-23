import { createSourceSpan, type SourceSpan } from "./source.js";

export const TokenKind = {
  Identifier: "identifier",
  NumberLiteral: "numberLiteral",
  StringLiteral: "stringLiteral",
  TemplateStart: "templateStart",
  TemplateText: "templateText",
  InterpolationStart: "interpolationStart",
  InterpolationEnd: "interpolationEnd",
  TemplateEnd: "templateEnd",

  KeywordSpeaker: "keywordSpeaker",
  KeywordSay: "keywordSay",
  KeywordAs: "keywordAs",
  KeywordExit: "keywordExit",
  KeywordLet: "keywordLet",
  KeywordIf: "keywordIf",
  KeywordElse: "keywordElse",
  KeywordTrue: "keywordTrue",
  KeywordFalse: "keywordFalse",
  KeywordNull: "keywordNull",
  KeywordNot: "keywordNot",
  KeywordAnd: "keywordAnd",
  KeywordOr: "keywordOr",
  KeywordSet: "keywordSet",
  KeywordRepeat: "keywordRepeat",
  KeywordFor: "keywordFor",
  KeywordIn: "keywordIn",
  KeywordWhile: "keywordWhile",
  KeywordBreak: "keywordBreak",
  KeywordContinue: "keywordContinue",

  LeftBrace: "leftBrace",
  RightBrace: "rightBrace",
  LeftBracket: "leftBracket",
  RightBracket: "rightBracket",
  LeftParenthesis: "leftParenthesis",
  RightParenthesis: "rightParenthesis",
  Colon: "colon",
  Comma: "comma",
  Dot: "dot",
  RangeExclusive: "rangeExclusive",
  RangeInclusive: "rangeInclusive",
  Question: "question",
  Plus: "plus",
  Minus: "minus",
  Star: "star",
  Slash: "slash",
  Percent: "percent",
  Equal: "equal",
  EqualEqual: "equalEqual",
  BangEqual: "bangEqual",
  Less: "less",
  LessEqual: "lessEqual",
  Greater: "greater",
  GreaterEqual: "greaterEqual",
  Newline: "newline",
  EndOfFile: "endOfFile",
} as const;

export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

type TokenWithValueKind =
  | typeof TokenKind.Identifier
  | typeof TokenKind.NumberLiteral
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
