import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { createSourcePosition, createSourceSpan, type SourcePosition } from "./source.js";
import { createToken, TokenKind, type Token } from "./token.js";

export interface LexResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly Diagnostic[];
}

const keywordKinds: ReadonlyMap<string, TokenKind> = new Map([
  ["speaker", TokenKind.KeywordSpeaker],
  ["say", TokenKind.KeywordSay],
  ["wait", TokenKind.KeywordWait],
  ["as", TokenKind.KeywordAs],
  ["exit", TokenKind.KeywordExit],
  ["let", TokenKind.KeywordLet],
  ["if", TokenKind.KeywordIf],
  ["else", TokenKind.KeywordElse],
  ["true", TokenKind.KeywordTrue],
  ["false", TokenKind.KeywordFalse],
  ["null", TokenKind.KeywordNull],
  ["not", TokenKind.KeywordNot],
  ["and", TokenKind.KeywordAnd],
  ["or", TokenKind.KeywordOr],
  ["set", TokenKind.KeywordSet],
  ["repeat", TokenKind.KeywordRepeat],
  ["for", TokenKind.KeywordFor],
  ["in", TokenKind.KeywordIn],
  ["while", TokenKind.KeywordWhile],
  ["break", TokenKind.KeywordBreak],
  ["continue", TokenKind.KeywordContinue],
  ["function", TokenKind.KeywordFunction],
  ["return", TokenKind.KeywordReturn],
]);

const diagnosticCodes = {
  invalidCharacter: "TSL001",
  unknownEscape: "TSL002",
  unterminatedString: "TSL003",
  unterminatedBlockString: "TSL004",
  unterminatedInterpolation: "TSL005",
  invalidNumber: "TSL006",
  unterminatedComment: "TSL007",
  physicalNewlineInString: "TSL008",
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
  #singleLineStringDepth = 0;

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
    if (character === "." && this.#peek(1) === ".") {
      this.#scanRangeToken();
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
    const kind = keywordKinds.get(lexeme);
    if (kind === undefined) {
      this.#emitValuedToken(TokenKind.Identifier, startOffset, start, this.#position(), lexeme);
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
      if (this.#peek() === "." && this.#peek(1) !== ".") {
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
    this.#emitValuedToken(TokenKind.NumberLiteral, startOffset, start, this.#position(), lexeme);
  }

  #scanRangeToken(): void {
    const startOffset = this.#offset;
    const start = this.#position();
    this.#advanceCodeUnit();
    this.#advanceCodeUnit();
    const kind = this.#peek() === "=" ? TokenKind.RangeInclusive : TokenKind.RangeExclusive;
    if (kind === TokenKind.RangeInclusive) this.#advanceCodeUnit();
    this.#emitToken(kind, startOffset, start, this.#position());
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
    if (this.#singleLineStringDepth > 0) {
      this.#report(
        diagnosticCodes.physicalNewlineInString,
        "Physical newlines are not allowed anywhere inside a single-line string.",
        start,
        this.#position(),
      );
    }
    this.#emitToken(TokenKind.Newline, startOffset, start, this.#position());
  }

  #scanString(): void {
    const stringOffset = this.#offset;
    const stringStart = this.#position();
    const block = this.#peek(1) === '"' && this.#peek(2) === '"';
    const delimiterLength = block ? 3 : 1;
    if (!block) this.#singleLineStringDepth += 1;
    for (let index = 0; index < delimiterLength; index += 1) this.#advanceCodeUnit();
    this.#emitToken(TokenKind.StringStart, stringOffset, stringStart, this.#position());

    const stringParts: StringScanPart[] = [];
    let textOffset = this.#offset;
    let textStart = this.#position();
    let value = "";

    while (!this.#isAtEnd()) {
      if (this.#isStringDelimiter(block)) {
        this.#emitStringText(textOffset, textStart, value, stringParts);
        const endOffset = this.#offset;
        const endStart = this.#position();
        for (let index = 0; index < delimiterLength; index += 1) this.#advanceCodeUnit();
        this.#emitToken(TokenKind.StringEnd, endOffset, endStart, this.#position());
        if (block) this.#normalizeBlockText(stringParts);
        if (!block) this.#singleLineStringDepth -= 1;
        return;
      }
      if (this.#peek() === "$" && this.#peek(1) === "{") {
        this.#emitStringText(textOffset, textStart, value, stringParts);
        stringParts.push({ kind: "interpolation" });
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
        if (this.#scanInterpolation(interpolationStart, block) === "eof") {
          if (block) this.#normalizeBlockText(stringParts);
          if (!block) this.#singleLineStringDepth -= 1;
          this.#report(
            block ? diagnosticCodes.unterminatedBlockString : diagnosticCodes.unterminatedString,
            block ? "Unterminated block string." : "Unterminated string literal.",
            stringStart,
            this.#position(),
          );
          return;
        }
        textOffset = this.#offset;
        textStart = this.#position();
        value = "";
        continue;
      }
      if (this.#peek() === "\\") {
        value += this.#scanEscape();
        continue;
      }
      if (this.#isNewline()) {
        const newlineStart = this.#position();
        this.#consumeNewline();
        value += "\n";
        if (this.#singleLineStringDepth > 0) {
          this.#report(
            diagnosticCodes.physicalNewlineInString,
            "Physical newlines are not allowed anywhere inside a single-line string.",
            newlineStart,
            this.#position(),
          );
        }
        continue;
      }
      value += this.#advanceCodePoint();
    }

    this.#emitStringText(textOffset, textStart, value, stringParts);
    if (block) this.#normalizeBlockText(stringParts);
    if (!block) this.#singleLineStringDepth -= 1;
    this.#report(
      block ? diagnosticCodes.unterminatedBlockString : diagnosticCodes.unterminatedString,
      block ? "Unterminated block string." : "Unterminated string literal.",
      stringStart,
      this.#position(),
    );
  }

  #isStringDelimiter(block: boolean): boolean {
    return this.#peek() === '"' && (!block || (this.#peek(1) === '"' && this.#peek(2) === '"'));
  }

  #scanInterpolation(
    interpolationStart: SourcePosition,
    outerBlock: boolean,
  ): "closed" | "stringEnd" | "eof" {
    let braceDepth = 0;
    while (!this.#isAtEnd()) {
      if (this.#peek() === "}" && braceDepth === 0) {
        const endOffset = this.#offset;
        const endStart = this.#position();
        this.#advanceCodeUnit();
        this.#emitToken(TokenKind.InterpolationEnd, endOffset, endStart, this.#position());
        return "closed";
      }
      if (this.#isStringDelimiter(outerBlock) && !this.#canStartNestedString()) {
        this.#report(
          diagnosticCodes.unterminatedInterpolation,
          "Unterminated string interpolation.",
          interpolationStart,
          this.#position(),
        );
        return "stringEnd";
      }

      if (this.#peek() === "{") braceDepth += 1;
      else if (this.#peek() === "}") braceDepth -= 1;
      this.#scanNormalToken();
    }

    this.#report(
      diagnosticCodes.unterminatedInterpolation,
      "Unterminated string interpolation.",
      interpolationStart,
      this.#position(),
    );
    return "eof";
  }

  #canStartNestedString(): boolean {
    let index = this.#tokens.length - 1;
    while (this.#tokens[index]?.kind === TokenKind.Newline) index -= 1;

    const previous = this.#tokens[index];
    const previousKind = previous?.kind;
    if (
      previousKind === TokenKind.Identifier &&
      (isInteractionCommand(previous?.lexeme) ||
        (this.#tokens[index - 1]?.kind === TokenKind.KeywordAs &&
          isInteractionCommand(this.#tokens[index - 2]?.lexeme)))
    ) {
      return true;
    }
    switch (previousKind) {
      case TokenKind.InterpolationStart:
      case TokenKind.LeftParenthesis:
      case TokenKind.LeftBracket:
      case TokenKind.LeftBrace:
      case TokenKind.Comma:
      case TokenKind.Colon:
      case TokenKind.Plus:
      case TokenKind.Minus:
      case TokenKind.Star:
      case TokenKind.Slash:
      case TokenKind.Percent:
      case TokenKind.EqualEqual:
      case TokenKind.BangEqual:
      case TokenKind.Less:
      case TokenKind.LessEqual:
      case TokenKind.Greater:
      case TokenKind.GreaterEqual:
      case TokenKind.RangeExclusive:
      case TokenKind.RangeInclusive:
      case TokenKind.KeywordNot:
      case TokenKind.KeywordAnd:
      case TokenKind.KeywordOr:
        return true;
      default:
        return false;
    }
  }

  #scanEscape(): string {
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
    if (this.#peek() === "$" && this.#peek(1) === "{") {
      this.#advanceCodeUnit();
      this.#advanceCodeUnit();
      return "${";
    }

    const escaped = this.#advanceCodePoint();
    const value = escapeValue(escaped);
    if (value !== undefined) return value;
    this.#report(
      diagnosticCodes.unknownEscape,
      `Unknown escape sequence \\${escaped}.`,
      start,
      this.#position(),
    );
    return escaped;
  }

  #emitStringText(
    startOffset: number,
    start: SourcePosition,
    value: string,
    parts: StringScanPart[],
  ): void {
    if (this.#offset !== startOffset) {
      parts.push({ kind: "text", tokenIndex: this.#tokens.length });
      this.#emitValuedToken(TokenKind.StringText, startOffset, start, this.#position(), value);
    }
  }

  #normalizeBlockText(parts: readonly StringScanPart[]): void {
    const textParts = parts.filter((part): part is StringScanTextPart => part.kind === "text");
    if (textParts.length === 0) return;
    const normalized = normalizeBlockStringText(
      parts.map((part) =>
        part.kind === "interpolation" ? part : { ...part, token: this.#tokens[part.tokenIndex]! },
      ),
    );
    textParts.forEach(({ tokenIndex }, index) => {
      const token = this.#tokens[tokenIndex]!;
      if (token.kind !== TokenKind.StringText) throw new TypeError("Expected block string text.");
      this.#tokens[tokenIndex] = createToken({ ...token, value: normalized[index]! });
    });
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
        // EVIDENCE: invariant: literal/identifier scanners create their payload tokens separately from this emitter.
        kind: kind as Exclude<
          TokenKind,
          typeof TokenKind.Identifier | typeof TokenKind.NumberLiteral | typeof TokenKind.StringText
        >,
        lexeme: this.source.slice(startOffset, end.offset),
        span: createSourceSpan(start, end),
      }),
    );
  }

  #emitValuedToken(
    kind:
      typeof TokenKind.Identifier | typeof TokenKind.NumberLiteral | typeof TokenKind.StringText,
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
      createDiagnostic(DiagnosticSeverity.Error, code, message, createSourceSpan(start, end)),
    );
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
    return this.#peek() === "\n" || (this.#peek() === "\r" && this.#peek(1) === "\n");
  }
}

function isInteractionCommand(value: string | undefined): boolean {
  return value === "askText" || value === "askNumber" || value === "choose";
}

interface StringScanTextPart {
  readonly kind: "text";
  readonly tokenIndex: number;
}

type StringScanPart = StringScanTextPart | { readonly kind: "interpolation" };

interface BlockTextPart extends StringScanTextPart {
  readonly token: Token;
}

function normalizeBlockStringText(
  parts: readonly (BlockTextPart | { readonly kind: "interpolation" })[],
): readonly string[] {
  const textParts = parts.filter((part): part is BlockTextPart => part.kind === "text");
  const removed = textParts.map(() => new Set<number>());
  const textIndex = new Map(textParts.map((part, index) => [part, index]));
  const first = parts[0];
  if (first?.kind === "text") {
    const length = physicalNewlineLength(first.token.lexeme, 0);
    if (length > 0) markRemoved(removed[textIndex.get(first)!]!, 0, length);
  }
  const last = parts.at(-1);
  if (last?.kind === "text") {
    const match = /(?:\r\n|\n)[ \t]*$/u.exec(last.token.lexeme);
    if (match?.index !== undefined) {
      markRemoved(
        removed[textIndex.get(last)!]!,
        match.index,
        last.token.lexeme.length - match.index,
      );
    }
  }

  type IndentUnit = { readonly text: number; readonly offset: number; readonly character: string };
  type ContentLine = { readonly indent: readonly IndentUnit[]; readonly nonblank: boolean };
  const lines: ContentLine[] = [];
  let indent: IndentUnit[] = [];
  let nonblank = false;
  const finishLine = () => {
    lines.push({ indent, nonblank });
    indent = [];
    nonblank = false;
  };

  for (const part of parts) {
    if (part.kind === "interpolation") {
      nonblank = true;
      continue;
    }
    const index = textIndex.get(part)!;
    const raw = part.token.lexeme;
    for (let offset = 0; offset < raw.length;) {
      const newlineLength = physicalNewlineLength(raw, offset);
      if (newlineLength > 0) {
        const isRemoved = removed[index]!.has(offset);
        offset += newlineLength;
        if (!isRemoved) finishLine();
        continue;
      }
      if (removed[index]!.has(offset)) {
        offset += 1;
        continue;
      }
      const character = raw[offset]!;
      if (!nonblank && isHorizontalWhitespace(character)) {
        indent.push({ text: index, offset, character });
      } else {
        nonblank = true;
      }
      offset += 1;
    }
  }
  if (indent.length > 0 || nonblank) finishLine();

  const nonblankLines = lines.filter((line) => line.nonblank);
  let common = nonblankLines[0]?.indent.map((unit) => unit.character).join("") ?? "";
  for (let index = 1; index < nonblankLines.length && common.length > 0; index += 1) {
    const candidate = nonblankLines[index]!.indent.map((unit) => unit.character).join("");
    let shared = 0;
    while (shared < common.length && common[shared] === candidate[shared]) shared += 1;
    common = common.slice(0, shared);
  }
  for (const line of lines) {
    const count = line.nonblank ? common.length : line.indent.length;
    for (let index = 0; index < count; index += 1) {
      const unit = line.indent[index]!;
      removed[unit.text]!.add(unit.offset);
    }
  }

  return textParts.map((part, index) => decodeStringText(part.token.lexeme, removed[index]!));
}

function markRemoved(target: Set<number>, start: number, length: number): void {
  for (let offset = start; offset < start + length; offset += 1) target.add(offset);
}

function physicalNewlineLength(raw: string, offset: number): number {
  if (raw[offset] === "\n") return 1;
  return raw[offset] === "\r" && raw[offset + 1] === "\n" ? 2 : 0;
}

function decodeStringText(raw: string, removed: ReadonlySet<number>): string {
  let value = "";
  for (let offset = 0; offset < raw.length;) {
    const newlineLength = physicalNewlineLength(raw, offset);
    if (newlineLength > 0) {
      if (!removed.has(offset)) value += "\n";
      offset += newlineLength;
      continue;
    }
    if (removed.has(offset)) {
      offset += 1;
      continue;
    }
    if (raw[offset] !== "\\") {
      const codePoint = raw.codePointAt(offset)!;
      const character = String.fromCodePoint(codePoint);
      value += character;
      offset += character.length;
      continue;
    }
    offset += 1;
    if (raw[offset] === "$" && raw[offset + 1] === "{") {
      value += "${";
      offset += 2;
      continue;
    }
    const newlineAfterEscape = physicalNewlineLength(raw, offset);
    if (newlineAfterEscape > 0) continue;
    if (offset >= raw.length) continue;
    const codePoint = raw.codePointAt(offset)!;
    const escaped = String.fromCodePoint(codePoint);
    value += escapeValue(escaped) ?? escaped;
    offset += escaped.length;
  }
  return value;
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

function escapeValue(escaped: string): string | undefined {
  switch (escaped) {
    case "\\":
      return "\\";
    case '"':
      return '"';
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
