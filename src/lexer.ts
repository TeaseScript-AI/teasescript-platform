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

const keywordKinds = {
  speaker: TokenKind.KeywordSpeaker,
  say: TokenKind.KeywordSay,
  as: TokenKind.KeywordAs,
  exit: TokenKind.KeywordExit,
} as const;

const diagnosticCodes = {
  invalidCharacter: "TSL001",
  unknownEscape: "TSL002",
  unterminatedString: "TSL003",
  unterminatedTemplate: "TSL004",
  unterminatedInterpolation: "TSL005",
} as const;

/** Tokenizes the approved initial parser slice of TeaseScript. */
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

    if (isIdentifierStart(character)) {
      this.#scanIdentifier();
      return;
    }

    switch (character) {
      case "{":
        this.#scanSingleCharacterToken(TokenKind.LeftBrace);
        return;
      case "}":
        this.#scanSingleCharacterToken(TokenKind.RightBrace);
        return;
      case ":":
        this.#scanSingleCharacterToken(TokenKind.Colon);
        return;
      case ".":
        this.#scanSingleCharacterToken(TokenKind.Dot);
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

    while (isIdentifierPart(this.#peek())) {
      this.#advanceCodeUnit();
    }

    const lexeme = this.source.slice(startOffset, this.#offset);
    const kind = keywordKinds[lexeme as keyof typeof keywordKinds];

    if (kind === undefined) {
      this.#emitValuedToken(
        TokenKind.Identifier,
        startOffset,
        start,
        this.#position(),
        lexeme,
      );
      return;
    }

    this.#emitToken(kind, startOffset, start, this.#position());
  }

  #scanSingleCharacterToken(
    kind:
      | typeof TokenKind.LeftBrace
      | typeof TokenKind.RightBrace
      | typeof TokenKind.Colon
      | typeof TokenKind.Dot,
  ): void {
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

      value += this.#advanceCodeUnit();
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
    const templateStartOffset = this.#offset;
    const templateStart = this.#position();
    this.#advanceCodeUnit();
    this.#emitToken(
      TokenKind.TemplateStart,
      templateStartOffset,
      templateStart,
      this.#position(),
    );

    let textStartOffset = this.#offset;
    let textStart = this.#position();
    let value = "";

    while (!this.#isAtEnd()) {
      if (this.#peek() === "`") {
        this.#emitTemplateText(textStartOffset, textStart, value);
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
        this.#emitTemplateText(textStartOffset, textStart, value);
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

        if (this.#scanInterpolation(interpolationStart) === "eof") {
          return;
        }
        textStartOffset = this.#offset;
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

      value += this.#advanceCodeUnit();
    }

    this.#emitTemplateText(textStartOffset, textStart, value);
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

      if (this.#peek() === "{") {
        braceDepth += 1;
      } else if (this.#peek() === "}") {
        braceDepth -= 1;
      }

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

    if (this.#isAtEnd()) {
      return "";
    }

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

    if (value !== undefined) {
      return value;
    }

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
    if (this.#offset === startOffset) {
      return;
    }

    this.#emitValuedToken(
      TokenKind.TemplateText,
      startOffset,
      start,
      this.#position(),
      value,
    );
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
    kind:
      | typeof TokenKind.KeywordSpeaker
      | typeof TokenKind.KeywordSay
      | typeof TokenKind.KeywordAs
      | typeof TokenKind.KeywordExit
      | typeof TokenKind.LeftBrace
      | typeof TokenKind.RightBrace
      | typeof TokenKind.Colon
      | typeof TokenKind.Dot
      | typeof TokenKind.TemplateStart
      | typeof TokenKind.InterpolationStart
      | typeof TokenKind.InterpolationEnd
      | typeof TokenKind.TemplateEnd
      | typeof TokenKind.Newline
      | typeof TokenKind.EndOfFile,
    startOffset: number,
    start: SourcePosition,
    end: SourcePosition,
  ): void {
    this.#tokens.push(
      createToken({
        kind,
        lexeme: this.source.slice(startOffset, end.offset),
        span: createSourceSpan(start, end),
      }),
    );
  }

  #emitValuedToken(
    kind:
      | typeof TokenKind.Identifier
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
    while (isHorizontalWhitespace(this.#peek())) {
      this.#advanceCodeUnit();
    }
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
    if (this.#peek() === "\r") {
      this.#offset += 2;
    } else {
      this.#offset += 1;
    }

    this.#line += 1;
    this.#column = 0;
  }

  #advanceCodePoint(): string {
    const codePoint = this.source.codePointAt(this.#offset);

    if (codePoint === undefined) {
      return "";
    }

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

function isIdentifierStart(character: string): boolean {
  return (
    (character >= "A" && character <= "Z") ||
    (character >= "a" && character <= "z") ||
    character === "_"
  );
}

function isIdentifierPart(character: string): boolean {
  return (
    isIdentifierStart(character) || (character >= "0" && character <= "9")
  );
}
