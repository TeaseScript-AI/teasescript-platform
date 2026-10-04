import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { createSourceSpan, type SourceSpan } from "./source.js";
import { addTag, normalizeTagName, type Tag } from "./tags.js";
import { TokenKind, type Token } from "./token.js";

/** The metadata of a file, written between `---` lines at its start (ADR 0023). It never executes. */
export interface ScriptHeader {
  readonly title: string | null;
  readonly author: string | null;
  readonly description: string | null;
  /** The tags for selection, each name once, in written order. */
  readonly tags: readonly Tag[];
  /** Search words for the website catalog; they never affect selection. */
  readonly keywords: readonly string[];
  /** From the opening to the closing `---`. */
  readonly span: SourceSpan;
}

export interface HeaderReadResult {
  readonly header: ScriptHeader | null;
  /** The tokens after the header, without misplaced header blocks. */
  readonly programTokens: readonly Token[];
  readonly diagnostics: readonly Diagnostic[];
}

const headerDiagnosticCode = {
  unclosedHeader: "TSH001",
  misplacedHeader: "TSH002",
  expectedField: "TSH003",
  unknownField: "TSH004",
  repeatedField: "TSH005",
  expectedText: "TSH006",
  interpolation: "TSH007",
  expectedTag: "TSH008",
  invalidTagName: "TSH009",
  invalidTagValue: "TSH010",
  repeatedTag: "TSH011",
  conflictingTagValue: "TSH012",
  emptyKeyword: "TSH013",
  repeatedKeyword: "TSH014",
  expectedLineEnd: "TSH015",
  expectedValue: "TSH016",
} as const;

const TEXT_FIELDS = ["title", "author", "description"] as const;
type TextField = (typeof TEXT_FIELDS)[number];
const FIELDS: readonly string[] = [...TEXT_FIELDS, "tags", "keywords"];

const TAG_NAME_RULE = "use lowercase letters a–z, digits, and hyphens";

/**
 * Reads the optional header at the start of a file's tokens: a `---` line, one `field: value` line per field with
 * TeaseScript literals, and a closing `---` line. Only blank lines and comments may precede it. A `---` block later
 * in the file is reported and left out of the program.
 */
export function readScriptHeader(tokens: readonly Token[]): HeaderReadResult {
  return new HeaderReader(tokens).read();
}

class HeaderReader {
  readonly #diagnostics: Diagnostic[] = [];
  #index = 0;

  public constructor(private readonly tokens: readonly Token[]) {}

  public read(): HeaderReadResult {
    this.#skipNewlines();
    const header = this.#isDelimiterLine(this.#index) ? this.#readHeader() : null;
    const programStart = header === null ? 0 : this.#index;
    return Object.freeze({
      header,
      programTokens: this.#withoutMisplacedHeaders(programStart),
      diagnostics: Object.freeze([...this.#diagnostics]),
    });
  }

  #readHeader(): ScriptHeader {
    const opening = spanOf(this.tokens[this.#index]!, this.tokens[this.#index + 2]!);
    this.#index += 3;
    const fields = new Map<string, string | null>();
    const tags = new Map<string, Tag>();
    const keywords = new Set<string>();
    let end = opening.end;
    for (;;) {
      this.#skipNewlines();
      const token = this.#peek();
      if (token.kind === TokenKind.EndOfFile) {
        this.#report(
          headerDiagnosticCode.unclosedHeader,
          "The header has no closing --- line.",
          opening,
        );
        end = token.span.end;
        break;
      }
      if (this.#isDelimiterLine(this.#index)) {
        end = this.tokens[this.#index + 2]!.span.end;
        this.#index += 3;
        break;
      }
      this.#readField(fields, tags, keywords);
    }
    const text = (field: TextField) => fields.get(field) ?? null;
    return Object.freeze({
      title: text("title"),
      author: text("author"),
      description: text("description"),
      tags: Object.freeze([...tags.values()].map((tag) => Object.freeze({ ...tag }))),
      keywords: Object.freeze([...keywords]),
      span: createSourceSpan(opening.start, end),
    });
  }

  #readField(
    fields: Map<string, string | null>,
    tags: Map<string, Tag>,
    keywords: Set<string>,
  ): void {
    const nameToken = this.#peek();
    if (nameToken.kind !== TokenKind.Identifier || this.#peek(1).kind !== TokenKind.Colon) {
      this.#report(
        headerDiagnosticCode.expectedField,
        'Expected a header field such as title: "Strict punishment", or a closing --- line.',
        nameToken.span,
      );
      this.#skipLine();
      return;
    }
    const name = nameToken.lexeme;
    if (!FIELDS.includes(name)) {
      this.#report(
        headerDiagnosticCode.unknownField,
        `Unknown header field '${name}'. A header has ${FIELDS.slice(0, -1).join(", ")}, and ${FIELDS.at(-1)!}.`,
        nameToken.span,
      );
      this.#skipLine();
      return;
    }
    if (fields.has(name)) {
      this.#report(
        headerDiagnosticCode.repeatedField,
        `The header field '${name}' appears more than once.`,
        nameToken.span,
      );
      this.#skipLine();
      return;
    }
    fields.set(name, null);
    this.#index += 2;
    // As after any `:`, the value may start on the next line (V30 §1).
    this.#skipNewlines();

    let complete: boolean;
    if (name === "tags") {
      complete = this.#readList(() => this.#readTag(tags));
    } else if (name === "keywords") {
      complete = this.#readList(() => this.#readKeyword(keywords));
    } else {
      const text = this.#readText(
        `The header field '${name}' takes text in quotes, such as ${name}: "…".`,
      );
      if (text !== null) fields.set(name, text.text);
      complete = text !== null;
    }
    if (!complete) {
      this.#skipLine();
      return;
    }
    if (!this.#atLineEnd()) {
      this.#report(
        headerDiagnosticCode.expectedLineEnd,
        `Expected the end of the line after the header field '${name}'.`,
        this.#peek().span,
      );
      this.#skipLine();
    }
  }

  /** Reads comma-separated entries; a line break may follow a comma (V30 §1). */
  #readList(readEntry: () => boolean): boolean {
    for (;;) {
      if (!this.#atValue()) {
        this.#report(
          headerDiagnosticCode.expectedValue,
          "Expected a value after the ':' or ','.",
          this.#peek().span,
        );
        return false;
      }
      if (!readEntry()) return false;
      if (this.#peek().kind !== TokenKind.Comma) return true;
      this.#index += 1;
      this.#skipNewlines();
    }
  }

  /** A plain tag in quotes, `"chastity"`, or a tag with a number, `punishment: 4`. */
  #readTag(tags: Map<string, Tag>): boolean {
    const first = this.#peek();
    if (first.kind === TokenKind.StringStart) {
      const text = this.#readText("");
      if (text === null) return false;
      if (this.#peek().kind === TokenKind.Colon) {
        return this.#fail(
          headerDiagnosticCode.invalidTagName,
          "Write the name of a tag with a number without quotes, such as punishment: 4.",
          text.span,
        );
      }
      if (text.text.includes(":")) {
        return this.#fail(
          headerDiagnosticCode.invalidTagName,
          `Write a tag with a number without quotes, such as ${text.text.trim()}.`,
          text.span,
        );
      }
      const name = normalizeTagName(text.text);
      if (name === null) {
        return this.#fail(
          headerDiagnosticCode.invalidTagName,
          `'${text.text}' is not a tag name: ${TAG_NAME_RULE}.`,
          text.span,
        );
      }
      this.#addTag(tags, { name, value: null }, text.span);
      return true;
    }

    // An unquoted name is the source text up to the `:`, such as `corner-time`, which the lexer splits into tokens.
    const nameStart = this.#index;
    while (!isNameEnd(this.#peek().kind)) this.#index += 1;
    if (this.#index === nameStart) {
      return this.#fail(
        headerDiagnosticCode.expectedTag,
        'Expected a tag in quotes, such as "chastity", or a tag with a number, such as punishment: 4.',
        first.span,
      );
    }
    const nameTokens = this.tokens.slice(nameStart, this.#index);
    const nameSpan = spanOf(nameTokens[0]!, nameTokens.at(-1)!);
    const adjacent = nameTokens.every(
      (token, index) =>
        index === 0 || nameTokens[index - 1]!.span.end.offset === token.span.start.offset,
    );
    const written = nameTokens.map((token) => token.lexeme).join(adjacent ? "" : " ");
    const name = adjacent ? normalizeTagName(written) : null;
    if (this.#peek().kind !== TokenKind.Colon) {
      return this.#fail(
        headerDiagnosticCode.expectedTag,
        name === null
          ? 'Expected a tag in quotes, such as "chastity", or a tag with a number, such as punishment: 4.'
          : `Write a tag without a number in quotes: "${name}".`,
        nameSpan,
      );
    }
    if (name === null) {
      return this.#fail(
        headerDiagnosticCode.invalidTagName,
        `'${written}' is not a tag name: ${TAG_NAME_RULE}.`,
        nameSpan,
      );
    }
    this.#index += 1;
    this.#skipNewlines();
    const value = this.#readNumber();
    if (value === null) return false;
    this.#addTag(tags, { name, value: value.value }, createSourceSpan(nameSpan.start, value.end));
    return true;
  }

  /** A number with an optional sign, as in `punishment: -1.5`. */
  #readNumber(): { readonly value: number; readonly end: SourceSpan["end"] } | null {
    const first = this.#peek();
    const signed = first.kind === TokenKind.Minus || first.kind === TokenKind.Plus;
    const number = this.#peek(signed ? 1 : 0);
    if (number.kind !== TokenKind.NumberLiteral) {
      this.#report(
        headerDiagnosticCode.invalidTagValue,
        "A tag's value is a number, such as punishment: 4.",
        number.span,
      );
      return null;
    }
    this.#index += signed ? 2 : 1;
    const value = Number(number.lexeme) * (first.kind === TokenKind.Minus ? -1 : 1);
    if (!Number.isFinite(value)) {
      // A malformed number such as `1e` is already reported by the lexer.
      if (!Number.isNaN(value)) {
        this.#report(
          headerDiagnosticCode.invalidTagValue,
          "A tag's number must be finite.",
          spanOf(first, number),
        );
      }
      return null;
    }
    if (!this.#atLineEnd() && this.#peek().kind !== TokenKind.Comma) {
      this.#report(
        headerDiagnosticCode.invalidTagValue,
        "A tag's value is a plain number, such as punishment: 4.",
        this.#peek().span,
      );
      return null;
    }
    return { value, end: number.span.end };
  }

  #readKeyword(keywords: Set<string>): boolean {
    const text = this.#readText('A keyword is text in quotes, such as "long session".');
    if (text === null) return false;
    const keyword = text.text.trim();
    if (keyword === "") {
      return this.#fail(headerDiagnosticCode.emptyKeyword, "A keyword cannot be empty.", text.span);
    }
    if (keywords.has(keyword)) {
      this.#report(
        headerDiagnosticCode.repeatedKeyword,
        `The keyword '${keyword}' is listed more than once.`,
        text.span,
        DiagnosticSeverity.Warning,
      );
    } else {
      keywords.add(keyword);
    }
    return true;
  }

  /** A string literal without interpolation; `expected` reports anything else, or nothing when empty. */
  #readText(expected: string): { readonly text: string; readonly span: SourceSpan } | null {
    const start = this.#peek();
    if (start.kind !== TokenKind.StringStart) {
      if (expected !== "") this.#report(headerDiagnosticCode.expectedText, expected, start.span);
      return null;
    }
    this.#index += 1;
    let text = "";
    let valid = true;
    for (;;) {
      const token = this.#peek();
      if (token.kind === TokenKind.EndOfFile) return null; // The lexer reports the unterminated string.
      this.#index += 1;
      if (token.kind === TokenKind.StringEnd) {
        return valid ? { text, span: spanOf(start, token) } : null;
      }
      if (token.kind === TokenKind.StringText) {
        text += token.value;
      } else if (token.kind === TokenKind.InterpolationStart) {
        this.#report(
          headerDiagnosticCode.interpolation,
          "A header is written as it is shown; it cannot use ${…}.",
          token.span,
        );
        valid = false;
        this.#skipInterpolation();
      }
    }
  }

  #skipInterpolation(): void {
    let depth = 1;
    while (depth > 0 && this.#peek().kind !== TokenKind.EndOfFile) {
      const kind = this.#peek().kind;
      if (kind === TokenKind.InterpolationStart) depth += 1;
      if (kind === TokenKind.InterpolationEnd) depth -= 1;
      this.#index += 1;
    }
  }

  #addTag(tags: Map<string, Tag>, tag: Tag, span: SourceSpan): void {
    const outcome = addTag(tags, tag);
    if (outcome === "repeated") {
      this.#report(
        headerDiagnosticCode.repeatedTag,
        `The tag '${tag.name}' is listed more than once.`,
        span,
        DiagnosticSeverity.Warning,
      );
    } else if (outcome === "conflict") {
      this.#report(
        headerDiagnosticCode.conflictingTagValue,
        `The tag '${tag.name}' has two different numbers.`,
        span,
      );
    }
  }

  /** The program tokens from `start`, each later `---` block left out with a diagnostic. */
  #withoutMisplacedHeaders(start: number): readonly Token[] {
    let kept: Token[] | null = null;
    let index = start;
    while (index < this.tokens.length) {
      if (!this.#isDelimiterLine(index)) {
        kept?.push(this.tokens[index]!);
        index += 1;
        continue;
      }
      kept ??= this.tokens.slice(start, index);
      this.#report(
        headerDiagnosticCode.misplacedHeader,
        "A header between --- lines must come first in the file, before any code.",
        spanOf(this.tokens[index]!, this.tokens[index + 2]!),
      );
      let closing = index + 3;
      while (closing < this.tokens.length && !this.#isDelimiterLine(closing)) closing += 1;
      index = closing < this.tokens.length ? closing + 3 : index + 3;
    }
    if (kept !== null) return Object.freeze(kept);
    return start === 0 ? this.tokens : Object.freeze(this.tokens.slice(start));
  }

  /** Whether a standalone `---` line starts at `index`. */
  #isDelimiterLine(index: number): boolean {
    const tokens = this.tokens;
    if (index > 0 && tokens[index - 1]!.kind !== TokenKind.Newline) return false;
    for (let offset = 0; offset < 3; offset += 1) {
      const token = tokens[index + offset];
      if (token?.kind !== TokenKind.Minus) return false;
      if (offset > 0 && tokens[index + offset - 1]!.span.end.offset !== token.span.start.offset) {
        return false;
      }
    }
    const after = tokens[index + 3]?.kind;
    return after === TokenKind.Newline || after === TokenKind.EndOfFile;
  }

  /** Whether the next token can start a value: not the end of the line, the file, or the header. */
  #atValue(): boolean {
    return !this.#atLineEnd() && !this.#isDelimiterLine(this.#index);
  }

  #atLineEnd(): boolean {
    const kind = this.#peek().kind;
    return kind === TokenKind.Newline || kind === TokenKind.EndOfFile;
  }

  /** Skips the rest of a line, but never a closing `---` line that an incomplete value stopped at. */
  #skipLine(): void {
    if (this.#isDelimiterLine(this.#index)) return;
    while (!this.#atLineEnd()) this.#index += 1;
  }

  #skipNewlines(): void {
    while (this.#peek().kind === TokenKind.Newline) this.#index += 1;
  }

  #peek(offset = 0): Token {
    return this.tokens[Math.min(this.#index + offset, this.tokens.length - 1)]!;
  }

  #fail(code: string, message: string, span: SourceSpan): false {
    this.#report(code, message, span);
    return false;
  }

  #report(
    code: string,
    message: string,
    span: SourceSpan,
    severity: DiagnosticSeverity = DiagnosticSeverity.Error,
  ): void {
    this.#diagnostics.push(createDiagnostic(severity, code, message, span));
  }
}

function isNameEnd(kind: Token["kind"]): boolean {
  return (
    kind === TokenKind.Colon ||
    kind === TokenKind.Comma ||
    kind === TokenKind.Newline ||
    kind === TokenKind.EndOfFile ||
    kind === TokenKind.StringStart
  );
}

function spanOf(first: Token, last: Token): SourceSpan {
  return createSourceSpan(first.span.start, last.span.end);
}
