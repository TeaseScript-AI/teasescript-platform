import {
  createDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from "./diagnostics.js";
import {
  createSourcePosition,
  createSourceSpan,
  type SourcePosition,
} from "./source.js";
import { createToken, TokenKind, type Token } from "./token.js";

export interface LexResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly Diagnostic[];
}

const keywordKinds: Readonly<Record<string, TokenKind>> = {
  speaker: TokenKind.KeywordSpeaker,
  say: TokenKind.KeywordSay,
  as: TokenKind.KeywordAs,
  exit: TokenKind.KeywordExit,
  let: TokenKind.KeywordLet,
  if: TokenKind.KeywordIf,
  else: TokenKind.KeywordElse,
  true: TokenKind.KeywordTrue,
  false: TokenKind.KeywordFalse,
  null: TokenKind.KeywordNull,
  not: TokenKind.KeywordNot,
  and: TokenKind.KeywordAnd,
  or: TokenKind.KeywordOr,
  set: TokenKind.KeywordSet,
};

const diagnosticCodes = {
  invalidCharacter: "TSL001",
  unknownEscape: "TSL002",
  unterminatedString: "TSL003",
  unterminatedTemplate: "TSL004",
  unterminatedInterpolation: "TSL005",
  invalidNumber: "TSL006",
  unterminatedComment: "TSL007",
} as const;

/** Tokenizes the accepted core-language milestone. */
export function lex(source: string): LexResult {
  if (typeof source !== "string") {
    throw new TypeError("source must be a string.");
  }

  return new Lexer(source).scan();
}

class Lexer {
  readonly #tokens: Token[] = [];
  readonly #diagnostics: Diagnostic[] = [];
  #offset = 0;
  #line = 0;
  #column = 0;

  public constructor(private readonly source: string) {}

  public scan(): LexResult {
    while (!this.#isAtEnd()) {
      this.#scanNormalToken();
    }

    const position = this.#position();
    this.#emitToken(TokenKind.EndOfFile, this.#offset, position, position);

    return Object.freeze({
      tokens: Object.freeze([...this.#tokens]),
      diagnostics: Object.freeze([...this.#diagnostics]),
    });
  }

  #scanNormalToken(): void {
    const character = this.#peek();

    if (isHorizontalWhitespace(character)) {
      this.#advanceCodeUnit();
      return;
    }
    if (this.#isNewline()) {
      this.#scanNewline();
      return;
    }
    if (isDigit(character) || (character === "." && isDigit(this.#peek(1)))) {
      this.#scanNumber();
      return;
    }
    if (isIdentifierStart(character)) {
      this.#scanIdentifier();
      return;
    }

    if (character === "/" && this.#peek(1) === "/") {
      this.#scanLineComment();
      return;
    }
    if (character === "/" && this.#peek(1) === "*") {
      this.#scanBlockComment();
      return;
    }

    const single = singleCharacterKinds[character];
    if (single !== undefined) {
      this.#scanSingleCharacterToken(single);
      return;
    }

    switch (character) {
      case "=":
        this.#scanOptionalEqual(TokenKind.Equal, TokenKind.EqualEqual);
        return;
      case "!":
        if (this.#peek(1) === "=") {
          this.#scanTwoCharacterToken(TokenKind.BangEqual);
        } else {
          this.#scanInvalidCharacter();
        }
        return;
      case "<":
        this.#scanOptionalEqual(TokenKind.Less, TokenKind.LessEqual);
        return;
      case ">":
        this.#scanOptionalEqual(TokenKind.Greater, TokenKind.GreaterEqual);
        return;
      case '"':
        this.#scanString();
        return;
      case "`":
        this.#scanTemplate();
        return;
      default:
        this.#scanInvalidCharacter();
    }
  }

  #scanIdentifier(): void {
    const startOffset = this.#offset;
    const start = this.#position();
    this.#advanceCodeUnit();
    while (isIdentifierPart(this.#peek())) this.#advanceCodeUnit();

    const lexeme = this.source.slice(startOffset, this.#offset);
    const kind = keywordKinds[lexeme];
    if (kind === undefined) {
      this.#emitValuedToken(
        TokenKind.Identifier,
        startOffset,
        start,
        this.#position(),
        lexeme,
      );
    } else {
      this.#emitToken(kind, startOffset, start, this.#position());
    }
  }

  #scanNumber(): void {
    const startOffset = this.#offset;
    const start = this.#position();

    if (this.#peek() === ".") {
      this.#advanceCodeUnit();
      this.#consumeDigits();
    } else {
      this.#consumeDigits();
      if (this.#peek() === ".") {
        this.#advanceCodeUnit();
        this.#consumeDigits();
      }
    }

    if (this.#peek() === "e" || this.#peek() === "E") {
      this.#advanceCodeUnit();
      if (this.#peek() === "+" || this.#peek() === "-") {
        this.#advanceCodeUnit();
      }
      if (!isDigit(this.#peek())) {
        this.#report(
          diagnosticCodes.invalidNumber,
          "Scientific notation requires at least one exponent digit.",
          start,
          this.#position(),
        );
      } else {
        this.#consumeDigits();
      }
    }

    const lexeme = this.source.slice(startOffset, this.#offset);
    this.#emitValuedToken(
      TokenKind.NumberLiteral,
      startOffset,
      start,
      this.#position(),
      lexeme,
    );
  }

  #consumeDigits(): void {
    while (isDigit(this.#peek())) this.#advanceCodeUnit();
  }

  #scanLineComment(): void {
    while (!this.#isAtEnd() && !this.#isNewline()) this.#advanceCodeUnit();
  }

  #scanBlockComment(): void {
    const start = this.#position();
    this.#advanceCodeUnit();
    this.#advanceCodeUnit();
    while (!this.#isAtEnd()) {
      if (this.#peek() === "*" && this.#peek(1) === "/") {
        this.#advanceCodeUnit();
        this.#advanceCodeUnit();
        return;
      }
      if (this.#isNewline()) this.#scanNewline();
      else this.#advanceCodePoint();
    }
    this.#report(
      diagnosticCodes.unterminatedComment,
      "Unterminated block comment.",
      start,
      this.#position(),
    );
  }

  #scanOptionalEqual(single: TokenKind, double: TokenKind): void {
    if (this.#peek(1) === "=") this.#scanTwoCharacterToken(double);
    else this.#scanSingleCharacterToken(single);
  }

  #scanTwoCharacterToken(kind: TokenKind): void {
    const startOffset = this.#offset;
    const start = this.#position();
    this.#advanceCodeUnit();
    this.#advanceCodeUnit();
    this.#emitToken(kind, startOffset, start, this.#position());
  }

  #scanSingleCharacterToken(kind: TokenKind): void {
    const startOffset = this.#offset;
    const start = this.#position();
    this.#advanceCodeUnit();
    this.#emitToken(kind, startOffset, start, this.#position());
  }

  #scanNewline(): void {
    const startOffset = this.#offset;
    const start = this.#position();
    this.#consumeNewline();
    this.#emitToken(TokenKind.Newline, startOffset, start, this.#position());
  }

  #scanString(): void {
    const startOffset = this.#offset;
    const start = this.#position();
    let value = "";
    this.#advanceCodeUnit();

    while (!this.#isAtEnd()) {
      if (this.#peek() === '"') {
        this.#advanceCodeUnit();
        this.#emitValuedToken(
          TokenKind.StringLiteral,
          startOffset,
          start,
          this.#position(),
          value,
        );
        return;
      }
      if (this.#peek() === "\\") {
        value += this.#scanEscape("string");
        continue;
      }
      if (this.#isNewline()) {
        value = this.#trimSourceIndentation(value);
        this.#consumeNewline();
        this.#skipHorizontalWhitespace();
        value += " ";
        continue;
      }
      value += this.#advanceCodePoint();
    }

    this.#emitValuedToken(
      TokenKind.StringLiteral,
      startOffset,
      start,
      this.#position(),
      value,
    );
    this.#report(
      diagnosticCodes.unterminatedString,
      "Unterminated string literal.",
      start,
      this.#position(),
    );
  }

  #scanTemplate(): void {
    const templateOffset = this.#offset;
    const templateStart = this.#position();
    this.#advanceCodeUnit();
    this.#emitToken(
      TokenKind.TemplateStart,
      templateOffset,
      templateStart,
      this.#position(),
    );

    let textOffset = this.#offset;
    let textStart = this.#position();
    let value = "";
    while (!this.#isAtEnd()) {
      if (this.#peek() === "`") {
        this.#emitTemplateText(textOffset, textStart, value);
        const endOffset = this.#offset;
        const endStart = this.#position();
        this.#advanceCodeUnit();
        this.#emitToken(
          TokenKind.TemplateEnd,
          endOffset,
          endStart,
          this.#position(),
        );
        return;
      }
      if (this.#peek() === "$" && this.#peek(1) === "{") {
        this.#emitTemplateText(textOffset, textStart, value);
        const interpolationOffset = this.#offset;
        const interpolationStart = this.#position();
        this.#advanceCodeUnit();
        this.#advanceCodeUnit();
        this.#emitToken(
          TokenKind.InterpolationStart,
          interpolationOffset,
          interpolationStart,
          this.#position(),
        );
        if (this.#scanInterpolation(interpolationStart) === "eof") return;
        textOffset = this.#offset;
        textStart = this.#position();
        value = "";
        continue;
      }
      if (this.#peek() === "\\") {
        value += this.#scanEscape("template");
        continue;
      }
      if (this.#isNewline()) {
        value = this.#trimSourceIndentation(value);
        this.#consumeNewline();
        this.#skipHorizontalWhitespace();
        value += " ";
        continue;
      }
      value += this.#advanceCodePoint();
    }

    this.#emitTemplateText(textOffset, textStart, value);
    this.#report(
      diagnosticCodes.unterminatedTemplate,
      "Unterminated template string.",
      templateStart,
      this.#position(),
    );
  }

  #scanInterpolation(
    interpolationStart: SourcePosition,
  ): "closed" | "templateEnd" | "eof" {
    let braceDepth = 0;
    while (!this.#isAtEnd()) {
      if (this.#peek() === "}" && braceDepth === 0) {
        const endOffset = this.#offset;
        const endStart = this.#position();
        this.#advanceCodeUnit();
        this.#emitToken(
          TokenKind.InterpolationEnd,
          endOffset,
          endStart,
          this.#position(),
        );
        return "closed";
      }
      if (this.#peek() === "`") {
        this.#report(
          diagnosticCodes.unterminatedInterpolation,
          "Unterminated template interpolation.",
          interpolationStart,
          this.#position(),
        );
        return "templateEnd";
      }

      if (this.#peek() === "{") braceDepth += 1;
      else if (this.#peek() === "}") braceDepth -= 1;
      this.#scanNormalToken();
    }

    this.#report(
      diagnosticCodes.unterminatedInterpolation,
      "Unterminated template interpolation.",
      interpolationStart,
      this.#position(),
    );
    return "eof";
  }

  #scanEscape(context: "string" | "template"): string {
    const start = this.#position();
    this.#advanceCodeUnit();
    if (this.#isAtEnd()) return "";
    if (this.#isNewline()) {
      this.#report(
        diagnosticCodes.unknownEscape,
        "Unknown escape sequence before a physical newline.",
        start,
        this.#position(),
      );
      return "";
    }
    if (
      context === "template" &&
      this.#peek() === "$" &&
      this.#peek(1) === "{"
    ) {
      this.#advanceCodeUnit();
      this.#advanceCodeUnit();
      return "${";
    }

    const escaped = this.#advanceCodePoint();
    const value = escapeValue(escaped, context);
    if (value !== undefined) return value;
    this.#report(
      diagnosticCodes.unknownEscape,
      `Unknown escape sequence \\${escaped}.`,
      start,
      this.#position(),
    );
    return escaped;
  }

  #emitTemplateText(
    startOffset: number,
    start: SourcePosition,
    value: string,
  ): void {
    if (this.#offset !== startOffset) {
      this.#emitValuedToken(
        TokenKind.TemplateText,
        startOffset,
        start,
        this.#position(),
        value,
      );
    }
  }

  #scanInvalidCharacter(): void {
    const start = this.#position();
    const character = this.#advanceCodePoint();
    this.#report(
      diagnosticCodes.invalidCharacter,
      `Invalid character ${JSON.stringify(character)}.`,
      start,
      this.#position(),
    );
  }

  #emitToken(
    kind: TokenKind,
    startOffset: number,
    start: SourcePosition,
    end: SourcePosition,
  ): void {
    this.#tokens.push(
      createToken({
        kind: kind as Exclude<
          TokenKind,
          | typeof TokenKind.Identifier
          | typeof TokenKind.NumberLiteral
          | typeof TokenKind.StringLiteral
          | typeof TokenKind.TemplateText
        >,
        lexeme: this.source.slice(startOffset, end.offset),
        span: createSourceSpan(start, end),
      }),
    );
  }

  #emitValuedToken(
    kind:
      | typeof TokenKind.Identifier
      | typeof TokenKind.NumberLiteral
      | typeof TokenKind.StringLiteral
      | typeof TokenKind.TemplateText,
    startOffset: number,
    start: SourcePosition,
    end: SourcePosition,
    value: string,
  ): void {
    this.#tokens.push(
      createToken({
        kind,
        lexeme: this.source.slice(startOffset, end.offset),
        value,
        span: createSourceSpan(start, end),
      }),
    );
  }

  #report(
    code: (typeof diagnosticCodes)[keyof typeof diagnosticCodes],
    message: string,
    start: SourcePosition,
    end: SourcePosition,
  ): void {
    this.#diagnostics.push(
      createDiagnostic(
        DiagnosticSeverity.Error,
        code,
        message,
        createSourceSpan(start, end),
      ),
    );
  }

  #skipHorizontalWhitespace(): void {
    while (isHorizontalWhitespace(this.#peek())) this.#advanceCodeUnit();
  }

  #trimSourceIndentation(value: string): string {
    let indentationLength = 0;
    let offset = this.#offset - 1;
    while (offset >= 0 && isHorizontalWhitespace(this.source[offset] ?? "")) {
      indentationLength += 1;
      offset -= 1;
    }
    return indentationLength === 0
      ? value
      : value.slice(0, -indentationLength);
  }

  #consumeNewline(): void {
    this.#offset += this.#peek() === "\r" ? 2 : 1;
    this.#line += 1;
    this.#column = 0;
  }

  #advanceCodePoint(): string {
    const codePoint = this.source.codePointAt(this.#offset);
    if (codePoint === undefined) return "";
    const character = String.fromCodePoint(codePoint);
    this.#offset += character.length;
    this.#column += character.length;
    return character;
  }

  #advanceCodeUnit(): string {
    const character = this.source[this.#offset] ?? "";
    this.#offset += 1;
    this.#column += 1;
    return character;
  }

  #position(): SourcePosition {
    return createSourcePosition(this.#offset, this.#line, this.#column);
  }

  #peek(distance = 0): string {
    return this.source[this.#offset + distance] ?? "\0";
  }

  #isAtEnd(): boolean {
    return this.#offset >= this.source.length;
  }

  #isNewline(): boolean {
    return (
      this.#peek() === "\n" ||
      (this.#peek() === "\r" && this.#peek(1) === "\n")
    );
  }
}

const singleCharacterKinds: Readonly<Record<string, TokenKind>> = {
  "{": TokenKind.LeftBrace,
  "}": TokenKind.RightBrace,
  "[": TokenKind.LeftBracket,
  "]": TokenKind.RightBracket,
  "(": TokenKind.LeftParenthesis,
  ")": TokenKind.RightParenthesis,
  ":": TokenKind.Colon,
  ",": TokenKind.Comma,
  ".": TokenKind.Dot,
  "?": TokenKind.Question,
  "+": TokenKind.Plus,
  "-": TokenKind.Minus,
  "*": TokenKind.Star,
  "/": TokenKind.Slash,
  "%": TokenKind.Percent,
};

function escapeValue(
  escaped: string,
  context: "string" | "template",
): string | undefined {
  switch (escaped) {
    case "\\":
      return "\\";
    case '"':
      return context === "string" ? '"' : undefined;
    case "`":
      return context === "template" ? "`" : undefined;
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return undefined;
  }
}

function isHorizontalWhitespace(character: string): boolean {
  return character === " " || character === "\t";
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isIdentifierStart(character: string): boolean {
  return (
    (character >= "A" && character <= "Z") ||
    (character >= "a" && character <= "z") ||
    character === "_"
  );
}

function isIdentifierPart(character: string): boolean {
  return isIdentifierStart(character) || isDigit(character);
}
