import { codePointWidth } from "./code-points.js";
import type { OwnedDiagnosticCode } from "./diagnostic-codes.js";
import { parseChild, runParse, type ParseTask } from "./parse-continuation.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import {
  createSourcePosition,
  createSourceSpan,
  type SourcePosition,
  type SourceSpan,
} from "./source.js";
import {
  COMMANDS,
  commandFacts,
  type CommandFacts,
  FOREIGN_FORM_CODE,
  FOREIGN_FORMS,
  isIdentifierPart,
  isIdentifierStart,
  KEYWORD_TOKENS,
} from "./language-facts.js";
import { createToken, TokenKind, type Token } from "./token.js";

export interface LexResult {
  readonly tokens: readonly Token[];
  /** The line and block comments, in source order; inside a block comment only its line breaks are tokens. */
  readonly comments: readonly SourceSpan[];
  readonly diagnostics: readonly Diagnostic[];
}

const diagnosticCodes = {
  invalidCharacter: "TSL001",
  unknownEscape: "TSL002",
  unterminatedString: "TSL003",
  unterminatedBlockString: "TSL004",
  unterminatedInterpolation: "TSL005",
  invalidNumber: "TSL006",
  unterminatedComment: "TSL007",
  physicalNewlineInString: "TSL008",
  unterminatedRegex: "TSL009",
  foreignForm: FOREIGN_FORM_CODE,
} as const satisfies Record<string, OwnedDiagnosticCode<"lexer", "error">>;

/**
 * Tokenizes the accepted core-language milestone. A `/` at an offset of `regexStarts` starts a regex literal, as one does
 * wherever the token before shows that the grammar expects a value there; the parser finds the other places (V30 §8).
 */
export function lex(source: string, regexStarts: ReadonlySet<number> = new Set()): LexResult {
  if (typeof source !== "string") {
    throw new TypeError("source must be a string.");
  }

  return new Lexer(source, regexStarts).scan();
}

/** The quote of text: `"`, or the backtick of another language. */
type Quote = '"' | "`";

class Lexer {
  readonly #tokens: Token[] = [];
  readonly #comments: SourceSpan[] = [];
  readonly #diagnostics: Diagnostic[] = [];
  #offset = 0;
  #line = 0;
  #column = 0;
  #singleLineStringDepth = 0;
  /** By the index of each `InterpolationEnd` token, the index of the `InterpolationStart` token it closes. */
  readonly #interpolationStarts = new Map<number, number>();
  /** The end of the line `#quotesFollowOnLine` last searched, the offset of the second-to-last `quote` before it. */
  #quoteSearch: { lineEnd: number; secondToLastQuote: number; quote: Quote } = {
    lineEnd: -1,
    secondToLastQuote: -1,
    quote: '"',
  };
  /** For `:]` and `\E` in a regex literal, where the last search began and what it found: an offset, or -1 before `end`. */
  readonly #markerSearches = new Map<string, { from: number; found: number; end: number }>();

  public constructor(
    private readonly source: string,
    private readonly regexStarts: ReadonlySet<number>,
  ) {}

  public scan(): LexResult {
    while (!this.#isAtEnd()) {
      runParse(this.#scanNormalToken());
    }

    const position = this.#position();
    this.#emitToken(TokenKind.EndOfFile, this.#offset, position, position);

    return Object.freeze({
      tokens: Object.freeze([...this.#tokens]),
      comments: Object.freeze([...this.#comments]),
      diagnostics: Object.freeze([...this.#diagnostics]),
    });
  }

  *#scanNormalToken(): ParseTask<void> {
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
    if (character === "#" && this.#startsHashComment()) {
      const start = this.#position();
      this.#scanLineComment();
      this.#report(
        diagnosticCodes.foreignForm,
        FOREIGN_FORMS.get("#")!.message,
        start,
        createSourcePosition(start.offset + 1, start.line, start.column + 1),
      );
      return;
    }
    if (character === "/" && this.#peek(1) === "*") {
      this.#scanBlockComment();
      return;
    }
    if (character === "/" && (this.regexStarts.has(this.#offset) || this.#regexMayStart())) {
      this.#scanRegex();
      return;
    }

    const single = singleCharacterKinds[character];
    if (single !== undefined) {
      this.#scanSingleCharacterToken(single);
      return;
    }

    switch (character) {
      case "+":
        this.#scanOptionalEqual(TokenKind.Plus, TokenKind.PlusEqual);
        return;
      case "-":
        this.#scanOptionalEqual(TokenKind.Minus, TokenKind.MinusEqual);
        return;
      case "=":
        this.#scanOptionalEqual(TokenKind.Equal, TokenKind.EqualEqual);
        return;
      case "!":
        // A lone `!` is a token so that the parser can name `not` instead (V30 §5).
        this.#scanOptionalEqual(TokenKind.Bang, TokenKind.BangEqual);
        return;
      case "<":
        this.#scanOptionalEqual(TokenKind.Less, TokenKind.LessEqual);
        return;
      case ">":
        this.#scanOptionalEqual(TokenKind.Greater, TokenKind.GreaterEqual);
        return;
      case '"':
        yield* parseChild(this.#scanString('"'));
        return;
      case "`":
        // Text in the backticks of another language, which is read as text in quotes.
        this.#report(
          diagnosticCodes.foreignForm,
          FOREIGN_FORMS.get("`")!.message,
          this.#position(),
          createSourcePosition(this.#offset + 1, this.#line, this.#column + 1),
        );
        yield* parseChild(this.#scanString("`"));
        return;
      case "~":
        // Lua's `~=`, which is read as `!=`: the token's lexeme is the operator that the parser takes.
        if (this.#peek(1) === "=" && this.#peek(2) !== "=") {
          const start = this.#position();
          this.#advanceCodeUnit();
          this.#advanceCodeUnit();
          this.#report(
            diagnosticCodes.foreignForm,
            FOREIGN_FORMS.get("~=")!.message,
            start,
            this.#position(),
          );
          this.#tokens.push(
            createToken({
              kind: TokenKind.BangEqual,
              lexeme: "!=",
              span: createSourceSpan(start, this.#position()),
            }),
          );
          return;
        }
        this.#scanInvalidCharacter();
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
    const kind = KEYWORD_TOKENS.get(lexeme);
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

  /**
   * Whether the `#` here starts the comment of another language: it comes first on its line, or before a space or the
   * end of its line, so that Lua's `#items` stays an invalid character.
   */
  #startsHashComment(): boolean {
    const next = this.#peek(1);
    return (
      (this.#tokens.at(-1)?.kind ?? TokenKind.Newline) === TokenKind.Newline ||
      isHorizontalWhitespace(next) ||
      next === "\n" ||
      next === "\r" ||
      this.#offset + 1 >= this.source.length
    );
  }

  #scanLineComment(): void {
    const start = this.#position();
    while (!this.#isAtEnd() && !this.#isNewline()) this.#advanceCodeUnit();
    this.#comments.push(createSourceSpan(start, this.#position()));
  }

  #scanBlockComment(): void {
    const start = this.#position();
    this.#advanceCodeUnit();
    this.#advanceCodeUnit();
    while (!this.#isAtEnd()) {
      if (this.#peek() === "*" && this.#peek(1) === "/") {
        this.#advanceCodeUnit();
        this.#advanceCodeUnit();
        this.#comments.push(createSourceSpan(start, this.#position()));
        return;
      }
      if (this.#isNewline()) this.#scanNewline();
      else this.#advanceCodePoint();
    }
    this.#comments.push(createSourceSpan(start, this.#position()));
    this.#report(
      diagnosticCodes.unterminatedComment,
      "Unterminated block comment.",
      start,
      this.#position(),
    );
  }

  /**
   * Whether a `/` here starts a regex literal (V30 §8) rather than dividing: the grammar expects an operand, because the
   * token before it, past line breaks, does not end one. A name, a number, text, a regex, `true`, `false`, `null`, a
   * closing `)`, `]`, or `}`, and a word after `.` end an operand. The parser finds the places the token before does not
   * show, such as after a message mode (see `parse`).
   */
  #regexMayStart(): boolean {
    let index = this.#tokens.length - 1;
    while (this.#tokens[index]?.kind === TokenKind.Newline) index -= 1;
    const previous = this.#tokens[index];
    if (previous === undefined) return true;
    if (this.#tokens[index - 1]?.kind === TokenKind.Dot) return false;
    switch (previous.kind) {
      // `save` takes a value, and so does `say as speaker`.
      case TokenKind.Identifier:
        return (
          previous.lexeme === "save" ||
          (this.#tokens[index - 1]?.kind === TokenKind.KeywordAs &&
            this.#tokens[index - 2]?.kind === TokenKind.KeywordSay)
        );
      case TokenKind.NumberLiteral:
      case TokenKind.StringEnd:
      case TokenKind.RegexLiteral:
      case TokenKind.RightParenthesis:
      case TokenKind.RightBracket:
      case TokenKind.RightBrace:
      case TokenKind.KeywordTrue:
      case TokenKind.KeywordFalse:
      case TokenKind.KeywordNull:
      // Both may name a value, as in `speaker.name` or a variable `wait`.
      case TokenKind.KeywordSpeaker:
      case TokenKind.KeywordWait:
        return false;
      default:
        return true;
    }
  }

  /**
   * A regex literal `/pattern/flags`. The pattern is opaque: no interpolation and no string escapes. It ends at the first
   * `/` that is not escaped as `\/`, inside a character class, or inside quoted text, read as RE2 reads them: a `]` right
   * after the opening `[` or `[^` and a `]` of a named class such as `[:alpha:]` belong to the class, and quoted text runs
   * from `\Q` to `\E`, or without `\E` on the line to the closing slash. The flags are the letters and digits right after
   * it, which the compiler checks. A literal cannot continue past the end of its line.
   */
  #scanRegex(): void {
    const startOffset = this.#offset;
    const start = this.#position();
    this.#advanceCodeUnit();
    let pattern = "";
    let inClass = false;
    let quoted = false;
    const take = (end: number): void => {
      while (this.#offset < end) pattern += this.#advanceCodeUnit();
    };
    while (!this.#isAtEnd() && this.#peek() !== "\n" && this.#peek() !== "\r") {
      const character = this.#peek();
      if (character === "/" && !inClass) {
        this.#advanceCodeUnit();
        while (isIdentifierPart(this.#peek())) this.#advanceCodeUnit();
        this.#emitValuedToken(
          TokenKind.RegexLiteral,
          startOffset,
          start,
          this.#position(),
          pattern,
        );
        return;
      }
      if (quoted) {
        // As everywhere, `\/` does not end the literal.
        if (character === "\\") {
          pattern += this.#advanceCodeUnit();
          if (this.#isAtEnd() || this.#peek() === "\n" || this.#peek() === "\r") break;
        }
        pattern += this.#advanceCodePoint();
        continue;
      }
      if (character === "\\" && this.#peek(1) === "Q" && !inClass) {
        const end = this.#findOnLine("\\E", this.#offset + 2);
        if (end < 0) quoted = true;
        take(end < 0 ? this.#offset + 2 : end + 2);
        continue;
      }
      if (character === "[" && this.#peek(1) === ":" && inClass) {
        // RE2 looks for the `:]` from the `[`, so `[:]` names the class `[:]`.
        const end = this.#findOnLine(":]", this.#offset + 1);
        if (end >= 0) {
          take(end + 2);
          continue;
        }
      }
      if (character === "[" && !inClass) {
        inClass = true;
        pattern += this.#advanceCodeUnit();
        if (this.#peek() === "^") pattern += this.#advanceCodeUnit();
        if (this.#peek() === "]") pattern += this.#advanceCodeUnit();
        continue;
      }
      if (character === "]") inClass = false;
      if (character === "\\") {
        pattern += this.#advanceCodeUnit();
        if (this.#isAtEnd() || this.#peek() === "\n" || this.#peek() === "\r") break;
      }
      pattern += this.#advanceCodePoint();
    }
    this.#report(
      diagnosticCodes.unterminatedRegex,
      "This regex has no closing '/' on its line. End it with '/', and write '\\/' for a slash inside it.",
      start,
      this.#position(),
    );
    this.#emitValuedToken(TokenKind.RegexLiteral, startOffset, start, this.#position(), pattern);
  }

  /**
   * The offset of the next `marker` from `from` before the end of the line, or -1. A literal searches forward only, and an
   * earlier result answers a later search that it covers, so every character is searched at most once for each marker.
   */
  #findOnLine(marker: string, from: number): number {
    const known = this.#markerSearches.get(marker);
    if (
      known !== undefined &&
      known.from <= from &&
      (known.found >= from || (known.found < 0 && from < known.end))
    )
      return known.found;
    let index = from;
    for (; index < this.source.length; index += 1) {
      const character = this.source[index];
      if (character === "\n" || character === "\r") break;
      if (this.source.startsWith(marker, index)) {
        this.#markerSearches.set(marker, { from, found: index, end: index });
        return index;
      }
    }
    this.#markerSearches.set(marker, { from, found: -1, end: index });
    return -1;
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

  /** Text in quotes, or in backticks (`quote`), which only a form of another language uses. */
  *#scanString(quote: Quote): ParseTask<void> {
    const stringOffset = this.#offset;
    const stringStart = this.#position();
    const block = quote === '"' && this.#peek(1) === '"' && this.#peek(2) === '"';
    const delimiterLength = block ? 3 : 1;
    if (!block) this.#singleLineStringDepth += 1;
    for (let index = 0; index < delimiterLength; index += 1) this.#advanceCodeUnit();
    this.#emitToken(TokenKind.StringStart, stringOffset, stringStart, this.#position());

    const stringParts: StringScanPart[] = [];
    let textOffset = this.#offset;
    let textStart = this.#position();
    let value = "";

    while (!this.#isAtEnd()) {
      if (this.#isStringDelimiter(block, quote)) {
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
        const startToken = this.#tokens.length;
        this.#advanceCodeUnit();
        this.#advanceCodeUnit();
        this.#emitToken(
          TokenKind.InterpolationStart,
          interpolationOffset,
          interpolationStart,
          this.#position(),
        );
        if (
          (yield* parseChild(
            this.#scanInterpolation(interpolationStart, startToken, block, quote),
          )) === "eof"
        ) {
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

  #isStringDelimiter(block: boolean, quote: Quote): boolean {
    return this.#peek() === quote && (!block || (this.#peek(1) === '"' && this.#peek(2) === '"'));
  }

  *#scanInterpolation(
    interpolationStart: SourcePosition,
    startToken: number,
    outerBlock: boolean,
    outerQuote: Quote,
  ): ParseTask<"closed" | "stringEnd" | "eof"> {
    let braceDepth = 0;
    // The brackets, parentheses, and braces still open inside the interpolation. A single-line string cannot end inside
    // one, so a quote there starts a nested string, such as `"y"` in `${[showPermanentButton "x" { say "y" }].length}`,
    // when the line still has the quotes that close it and the outer string. Otherwise, as outside them, a quote after
    // a value ends the outer string, as in `"${[1, 2"` and `"${name"`. In a block string only `"""` can end it, so a
    // lone quote is always nested there.
    let openDelimiters = 0;
    while (!this.#isAtEnd()) {
      if (this.#peek() === "}" && braceDepth === 0) {
        const endOffset = this.#offset;
        const endStart = this.#position();
        this.#advanceCodeUnit();
        this.#interpolationStarts.set(this.#tokens.length, startToken);
        this.#emitToken(TokenKind.InterpolationEnd, endOffset, endStart, this.#position());
        return "closed";
      }
      if (
        this.#isStringDelimiter(outerBlock, outerQuote) &&
        !(openDelimiters > 0 && !outerBlock && this.#quotesFollowOnLine(outerQuote)) &&
        !this.#canStartNestedString()
      ) {
        this.#report(
          diagnosticCodes.unterminatedInterpolation,
          "Unterminated string interpolation.",
          interpolationStart,
          this.#position(),
        );
        return "stringEnd";
      }

      const next = this.#peek();
      if (next === "{") braceDepth += 1;
      else if (next === "}") braceDepth -= 1;
      if (next === "(" || next === "[" || next === "{") openDelimiters += 1;
      else if ((next === ")" || next === "]" || next === "}") && openDelimiters > 0)
        openDelimiters -= 1;
      yield* parseChild(this.#scanNormalToken());
    }

    this.#report(
      diagnosticCodes.unterminatedInterpolation,
      "Unterminated string interpolation.",
      interpolationStart,
      this.#position(),
    );
    return "eof";
  }

  /** Whether at least two more `quote`s follow the one at the current offset on its line. */
  #quotesFollowOnLine(quote: Quote): boolean {
    if (this.#offset >= this.#quoteSearch.lineEnd || quote !== this.#quoteSearch.quote) {
      let last = -1;
      let secondToLast = -1;
      let index = this.#offset + 1;
      for (; index < this.source.length && this.source[index] !== "\n"; index += 1) {
        if (this.source[index] !== quote) continue;
        secondToLast = last;
        last = index;
      }
      this.#quoteSearch = { lineEnd: index, secondToLastQuote: secondToLast, quote };
    }
    return this.#offset < this.#quoteSearch.secondToLastQuote;
  }

  /**
   * Whether the token at `index` ends the words that a play command takes before its file, right after that command, as
   * `async` in `playAudio async "a.mp3"`; a member such as `obj.playAudio` takes none (see `COMMANDS`).
   */
  #endsFileModifiers(index: number): boolean {
    let command = index;
    while (command >= 0 && FILE_MODIFIERS.has(this.#tokens[command]!.lexeme)) command -= 1;
    const modifiers = commandFacts(this.#tokens[command]?.lexeme ?? "")?.fileModifiers;
    return (
      command < index &&
      modifiers !== undefined &&
      this.#tokens[command - 1]?.kind !== TokenKind.Dot &&
      this.#tokens.slice(command + 1, index + 1).every((token) => modifiers.includes(token.lexeme))
    );
  }

  #canStartNestedString(): boolean {
    let index = this.#tokens.length - 1;
    while (this.#tokens[index]?.kind === TokenKind.Newline) index -= 1;

    // A play command takes its file after its words, as in `"${playAudio async "a.mp3"}"`.
    if (this.#endsFileModifiers(index)) return true;
    const previous = this.#tokens[index];
    const previousKind = previous?.kind;
    if (
      previousKind === TokenKind.Identifier &&
      // A command that gives a value takes its operand after it, such as `"${load "k", default: "none"}"` and
      // `"${askText "Name?"}"`, and so does the bare `default` of the earlier form, lexed so that `load` can name the fix;
      // a member such as `obj.load` does not.
      (((commandFacts(previous!.lexeme)?.value === true || previous!.lexeme === "default") &&
        this.#tokens[index - 1]?.kind !== TokenKind.Dot) ||
        isInteractionCommand(previous?.lexeme) ||
        (this.#tokens[index - 1]?.kind === TokenKind.KeywordAs &&
          isInteractionCommand(this.#tokens[index - 2]?.lexeme)) ||
        // The mode of an ask's question, as in `askText prose "Name?"` or `askText as mistress prose "Name?"`.
        this.#isQuestionMode(index))
    ) {
      return true;
    }
    // The options of that mode, as in `askText prose(align: "center") "Name?"`.
    if (previousKind === TokenKind.RightParenthesis) {
      const opener = this.#openerOf(index);
      if (opener !== null && this.#isQuestionMode(opener - 1)) return true;
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
      case TokenKind.KeywordIs:
      case TokenKind.KeywordNot:
      case TokenKind.KeywordAnd:
      case TokenKind.KeywordOr:
      case TokenKind.KeywordOtherwise:
      // The symbols the parser names a word for, as in `"${a || "b"}"` and `"${name ?? "pet"}"`.
      case TokenKind.Pipe:
      case TokenKind.Ampersand:
      case TokenKind.Bang:
      case TokenKind.Question:
        return true;
      default:
        return false;
    }
  }

  /** Whether the token at `index` is `bubble` or `prose` right after an ask, or after its `as speaker`. */
  #isQuestionMode(index: number): boolean {
    const lexeme = this.#tokens[index]?.lexeme;
    return (
      this.#tokens[index]?.kind === TokenKind.Identifier &&
      (lexeme === "bubble" || lexeme === "prose") &&
      (isInteractionCommand(this.#tokens[index - 1]?.lexeme) ||
        (this.#tokens[index - 2]?.kind === TokenKind.KeywordAs &&
          isInteractionCommand(this.#tokens[index - 3]?.lexeme)))
    );
  }

  /**
   * The index of the `(` that the `)` at `index` closes, found back to the interpolation it stands in, or `null`. Only
   * a quote right after a `)` asks, and the search goes back over that one group. It jumps over each complete
   * interpolation of a string inside it, as in `prose(font: "${name}")`, so nested asks are not searched again.
   */
  #openerOf(index: number): number | null {
    let depth = 0;
    for (let at = index; at >= 0; at -= 1) {
      const kind = this.#tokens[at]!.kind;
      if (kind === TokenKind.RightParenthesis) depth += 1;
      else if (kind === TokenKind.LeftParenthesis) {
        depth -= 1;
        if (depth === 0) return at;
      } else if (kind === TokenKind.InterpolationEnd) at = this.#interpolationStarts.get(at) ?? at;
      else if (kind === TokenKind.InterpolationStart) return null;
    }
    return null;
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
    // A symbol of another language, such as `;`, names what TeaseScript writes instead, and a `#` only where it starts a
    // comment (`#startsHashComment`).
    const foreign = character === "#" ? undefined : FOREIGN_FORMS.get(character);
    this.#report(
      foreign === undefined ? diagnosticCodes.invalidCharacter : diagnosticCodes.foreignForm,
      foreign?.message ?? `Invalid character ${JSON.stringify(character)}.`,
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
          | typeof TokenKind.Identifier
          | typeof TokenKind.NumberLiteral
          | typeof TokenKind.StringText
          | typeof TokenKind.RegexLiteral
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
      | typeof TokenKind.StringText
      | typeof TokenKind.RegexLiteral,
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
    if (this.#offset >= this.source.length) return "";
    const width = codePointWidth(this.source, this.#offset);
    const character = this.source.slice(this.#offset, this.#offset + width);
    this.#offset += width;
    this.#column += width;
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

/** Every word that a play command takes before its file (see `COMMANDS`). */
const FILE_MODIFIERS: ReadonlySet<string> = new Set(
  Object.values(COMMANDS).flatMap((facts: CommandFacts) => facts.fileModifiers ?? []),
);

/** Whether `value` is a compact interaction, which may take `as speaker` and a question's mode (see `COMMANDS`). */
function isInteractionCommand(value: string | undefined): boolean {
  return value !== undefined && commandFacts(value)?.interaction !== undefined;
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
      const width = codePointWidth(raw, offset);
      value += raw.slice(offset, offset + width);
      offset += width;
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
    const escaped = raw.slice(offset, offset + codePointWidth(raw, offset));
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
  "|": TokenKind.Pipe,
  "&": TokenKind.Ampersand,
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
