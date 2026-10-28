import { parseChild, runParse, type ParseTask } from "./parse-continuation.js";
import type {
  AssignmentStatement,
  AssignmentTarget,
  BinaryExpression,
  Block,
  CallArgument,
  CallExpression,
  Expression,
  ExpressionStatement,
  Identifier,
  NamedArgument,
  PositionalArgument,
  Program,
  PropertyAccessExpression,
  RangeExpression,
  SayParts,
  PlayMediaStatement,
  NumberLiteral,
  Statement,
  StringLiteral,
  StringText,
  UnaryExpression,
} from "./ast.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import {
  COMMANDS,
  commandFacts,
  FOREIGN_FORMS,
  isAsk,
  isCommand,
  protectedNameMessage,
  TEASESCRIPT_PROTECTED_NAMES,
  type ForeignForm,
  type StatementCommand,
  type ValueCommand,
} from "./language-facts.js";
import { lex } from "./lexer.js";
import { readMisplacedHeader, readScriptHeader, type ScriptHeader } from "./script-header.js";
import { createSourcePosition, createSourceSpan, type SourceSpan } from "./source.js";
import { TokenKind, type Token } from "./token.js";
import { parserDiagnosticCode } from "./parser/diagnostic-codes.js";
import {
  copySpan,
  delimiterClosers,
  isExpressionStart,
  isPropertyName,
  isWord,
  spanFrom,
} from "./parser/tokens.js";
import { parseSayParts, parseSayValue, parseSpeakerStatement } from "./parser/say.js";
import {
  parseAskImageWithPresentation,
  parseInteractionExpression,
  PRESENTATION_MODES,
} from "./parser/asks.js";
import {
  parseExportTextStatement,
  parseOpenUrlStatement,
  parseShowButtonParts,
  parseShowButtonStatement,
  parseShowPermanentButtonParts,
  parseShowPopupParts,
  parseShowPopupStatement,
} from "./parser/buttons-and-popups.js";
import { parseTimerParts, parseTimerStatement, parseWaitStatement } from "./parser/timers.js";
import {
  parseHideCameraStatement,
  parseHideImageStatement,
  parseMediaParts,
  parseShowCameraParts,
  parseShowImageStatement,
  parseStopAudioStatement,
} from "./parser/media.js";
import { finishFindQuery } from "./parser/tag-queries.js";
import {
  NO_STORAGE_DELIMITERS,
  parseDeleteStatement,
  parseLoadExpression,
  parseSaveStatement,
  type StorageDelimiter,
} from "./parser/storage.js";
import {
  parseExitStatement,
  parseForStatement,
  parseIfStatement,
  parseLabelStatement,
  parseLoopControl,
  parseRepeatStatement,
  parseSwitchStatement,
  parseTransferStatement,
  parseWhileStatement,
} from "./parser/control-flow.js";
import {
  parseFunctionDeclaration,
  parseGlobalStatement,
  parseLetStatement,
  parseReturnStatement,
} from "./parser/declarations.js";
import { parseTypeTask, typeName } from "./parser/types.js";
import {
  parseCollectionLiteralElements,
  parseDictLiteral,
  parseObjectLiteral,
  parseParenthesized,
  parseStringLiteral,
} from "./parser/literals.js";
import { parseDurationUnit, parseUnitSuffix } from "./parser/units.js";

export interface ParseResult {
  readonly program: Program;
  /**
   * The offsets of each `/` that starts a regex literal although the token before does not show it (V30 §8), which
   * lexing the source or a part of it again needs to read it the same way.
   */
  readonly regexStarts: ReadonlySet<number>;
  /** The file's `---` header, or `null` when it has none. */
  readonly header: ScriptHeader | null;
  readonly diagnostics: readonly Diagnostic[];
  /**
   * Every statement and media cue the parser read, also one it could not read and left out of the program, and the
   * inside of every statement block. Language tooling finds the statement at a position with them.
   */
  readonly statementRanges: readonly StatementRange[];
  /**
   * The arguments of every command besides the compact interactions whose arguments the parser read, also of one whose
   * statement it could not read further, such as one without its block yet. Language tooling finds the command at a
   * position with them.
   */
  readonly commandRanges: readonly CommandRange[];
}

/**
 * Source offsets of a statement, from its first token to the line break, `}`, or end of file that ended it, or of the
 * inside of a statement block, from after its `{` to its `}` or the end of file.
 */
export interface StatementRange {
  readonly kind: "statement" | "block";
  readonly start: number;
  readonly end: number;
}

/**
 * Source offsets of a command's arguments, from the start of its name to the end of its last argument, and of the `{`
 * of its block of statements, when one follows them.
 */
export interface CommandRange {
  readonly kind: "command";
  readonly start: number;
  readonly end: number;
  readonly block: number | null;
}

const PROTECTED_NAMES: ReadonlySet<string> = new Set(TEASESCRIPT_PROTECTED_NAMES);

/**
 * The words that start a statement wherever a line starts with them (see `COMMANDS`), which can never be a value; of
 * these only `showButton` and `showPopup` also have a value form, used after `=`, an operator, or an opening delimiter.
 */
const LINE_STATEMENTS: ReadonlySet<string> = new Set(
  Object.keys(COMMANDS).filter((name) => commandFacts(name)?.statement === "line"),
);
/** What the parsers over one token list share. */
interface SharedParse {
  /**
   * For each token, its innermost enclosing opener, if any: inside `(` or `[` a newline may continue a type, and an
   * expression directly inside `${` does not continue before an operator (V30 §1).
   */
  readonly openers: readonly (TokenKind | undefined)[];
  /** For each opening delimiter, the index of the delimiter that closes it, once one is looked up. */
  closers: ReadonlyMap<number, number> | null;
  /**
   * The `say` values parsed so far, by token position. Telling a mode or skip word from a value parses ahead, also the
   * `say` values nested there, so each is parsed once per context; parsed again at every level, nesting is exponential.
   */
  readonly sayValues: Map<number, ParsedSayValue[]>;
  /**
   * Strings with an interpolation that reported an error. They keep what parsed, so that what they belong to stays in
   * the program; where only text written out in quotes is allowed, they count as failed, without a further error.
   */
  readonly recoveredStrings: WeakSet<StringLiteral>;
  /**
   * The `otherwise` expressions with an error of their own: a `??`, a fallback that starts with `not`, or arithmetic or a
   * range next to it. An operator around one adds no second error (see `Parser.#reportOtherwiseOperand`).
   */
  readonly faultyOtherwise: WeakSet<Expression>;
  /**
   * For each newline token, the index of the first newline of its run and of the token after the run, so that skipping
   * a run, or giving it back after a missing closer, costs the same at every level of nesting.
   */
  readonly newlineRuns: { readonly starts: Int32Array; readonly ends: Int32Array };
  /**
   * Errors that only follow the lexer's report of a string or regex without its closing delimiter, as "Expected an
   * expression" after `let text = "unfinished`. The parse keeps them, so that every decision it makes is the same as
   * without this set, but `parse` leaves them out (see `Parser.reportMissing`).
   */
  readonly followUps: WeakSet<Diagnostic>;
}
/** A point in a parse, from which `Parser.reportMissing` tells what a failed part reported. */
export interface ParseMark {
  readonly diagnostics: number;
  readonly unclosedLiterals: number;
}
/** A `say` value parsed at a token position in one parsing context, with what its parse left behind. */
interface ParsedSayValue {
  readonly insideDelimiters: boolean;
  readonly storageDelimiters: ReadonlySet<StorageDelimiter>;
  readonly blockEndsCompactInteraction: boolean;
  readonly recoveredAtStatementBoundary: boolean;
  readonly parts: SayParts | null;
  readonly end: number;
  readonly diagnostics: readonly Diagnostic[];
  /** The literals without their closing delimiter that its parse failed to read (see `Parser.unclosedLiterals`). */
  readonly unclosedLiterals: number;
  /** The offsets of the `/` where its parse expected a value (see `Parser.regexStarts`). */
  readonly regexStarts: readonly number[];
  /** The statement and command ranges its parse recorded. */
  readonly ranges: RangeSegment;
  readonly recovered: boolean;
}
/**
 * The statement ranges from `from` up to `to` in `list`, which only grows. A parser that reuses a `say` value lists its
 * segment rather than a copy of its ranges, so a value nested in others is not copied into each of them.
 */
interface RangeSegment {
  readonly list: readonly (StatementRange | CommandRange | RangeSegment)[];
  readonly from: number;
  readonly to: number;
}
const OPENING_TOKENS: ReadonlySet<TokenKind> = new Set([
  TokenKind.LeftParenthesis,
  TokenKind.LeftBracket,
  TokenKind.LeftBrace,
  TokenKind.InterpolationStart,
]);
/** Tokens that start a value but cannot go on from a name before them, as an operator or a call can. */
const OPERAND_STARTS: ReadonlySet<TokenKind> = new Set([
  TokenKind.Identifier,
  TokenKind.NumberLiteral,
  TokenKind.StringStart,
  TokenKind.KeywordTrue,
  TokenKind.KeywordFalse,
  TokenKind.KeywordNull,
  TokenKind.KeywordNot,
  TokenKind.Bang,
]);
const CLOSING_TOKENS: ReadonlySet<TokenKind> = new Set([
  TokenKind.RightParenthesis,
  TokenKind.RightBracket,
  TokenKind.RightBrace,
  TokenKind.InterpolationEnd,
]);

/** Parses the accepted core-language milestone. */
export function parse(source: string): ParseResult {
  // A `/` where the grammar expects a value starts a regex literal (V30 §8). The lexer tells most such places from the
  // token before; where a parse with errors expected a value at a `/` that the lexer took for division, the source is
  // lexed and parsed again with a regex there, until no new one appears. A parse without errors is never changed.
  const regexStarts = new Set<number>();
  for (;;) {
    const header = readScriptHeader(lex(source, regexStarts));
    const parser = new Parser(header.programTokens);
    const program = parser.parseProgram();
    const added = parser.regexStarts.filter((offset) => !regexStarts.has(offset));
    if (added.length > 0 && parser.diagnostics.length > 0) {
      for (const offset of added) regexStarts.add(offset);
      continue;
    }
    const { statements, commands } = parser.ranges();
    return Object.freeze({
      program,
      regexStarts,
      header: header.header,
      diagnostics: Object.freeze([
        ...header.diagnostics,
        ...parser.diagnostics.filter((diagnostic) => !parser.shared.followUps.has(diagnostic)),
      ]),
      statementRanges: Object.freeze(statements),
      commandRanges: Object.freeze(commands),
    });
  }
}

/** The public members serve `parse` and the modules in `parser/`, and are internal to the parser. */
export class Parser {
  public readonly diagnostics: Diagnostic[] = [];
  /**
   * The statement and command ranges. A speculative parser keeps its own, so only those of the parse that counts are
   * listed, also those of a `say` value it reuses.
   */
  public readonly statementRanges: (StatementRange | CommandRange | RangeSegment)[] = [];
  /**
   * The offsets of each `/` where this parse expected a value, which a regex literal starts there; like its diagnostics,
   * a speculative parser keeps its own.
   */
  public readonly regexStarts: number[] = [];
  /**
   * The strings and regexes without their closing delimiter that this parse failed to read; the lexer reports them.
   * Like its diagnostics, a speculative parser counts its own.
   */
  public unclosedLiterals = 0;
  public current = 0;
  #commaLookahead: {
    readonly at: number;
    readonly insideDelimiters: boolean;
    readonly offset: number | null;
  } | null = null;
  public recoveredAtStatementBoundary = false;
  /**
   * Inside a media cue position, a permanent button's text, or the head of a block statement such as `if` or `switch`,
   * where the following block `{` ends a compact interaction, and a value that is still expected (see `#atHeadBlock`).
   */
  public blockEndsCompactInteraction = false;
  /**
   * The `save` `as` that ends an enclosing storage operand, and a bare `default` after a `load` key, the earlier form
   * that `load` reports with its fix. A compact interaction stops at them, and a bare interaction leaves the `as` to
   * `save`; groupings such as parentheses start without them.
   */
  public storageDelimiters: ReadonlySet<StorageDelimiter> = NO_STORAGE_DELIMITERS;
  /** Inside `()`, `[]`, or an object literal, where a line break does not end an expression (V30 §1). */
  public insideDelimiters = false;
  /** The values before a `calendar` without a unit, so that after a `say` mode or skip word, `calendar` is the text. */
  public readonly unitlessCalendars = new WeakSet<Expression>();
  /** What every parser over these tokens shares: a speculative parser computes none of it again. */
  public readonly shared: SharedParse;

  public constructor(
    public readonly tokens: readonly Token[],
    shared: SharedParse = {
      openers: innermostOpeners(tokens),
      closers: null,
      sayValues: new Map(),
      recoveredStrings: new WeakSet(),
      faultyOtherwise: new WeakSet(),
      newlineRuns: newlineRuns(tokens),
      followUps: new WeakSet(),
    },
  ) {
    this.shared = shared;
  }

  /** The statement and command ranges, with those of each reused `say` value, read once without recursion. */
  public ranges(): {
    readonly statements: readonly StatementRange[];
    readonly commands: readonly CommandRange[];
  } {
    const statements: StatementRange[] = [];
    const commands: CommandRange[] = [];
    const pending: RangeSegment[] = [
      { list: this.statementRanges, from: 0, to: this.statementRanges.length },
    ];
    for (let segment = pending.pop(); segment !== undefined; segment = pending.pop()) {
      for (let index = segment.from; index < segment.to; index += 1) {
        const entry = segment.list[index]!;
        if ("list" in entry) pending.push(entry);
        else if (entry.kind === "command") commands.push(entry);
        else statements.push(entry);
      }
    }
    return { statements, commands };
  }

  /**
   * Records the arguments of the command named by `command`, which end at `end`, and with `block` the `{` after them
   * that starts its block (see `ParseResult.commandRanges`).
   */
  public recordCommand(command: Token, end: number, block: boolean): void {
    this.statementRanges.push(
      Object.freeze({
        kind: "command",
        start: command.span.start.offset,
        end,
        block: block && this.check(TokenKind.LeftBrace) ? this.peek().span.start.offset : null,
      }),
    );
  }

  /** Where the last token read ends, before the line breaks read after it. */
  public lastEnd(): number {
    let index = this.current - 1;
    while (index > 0 && this.tokens[index]!.kind === TokenKind.Newline) index -= 1;
    return this.tokens[index]!.span.end.offset;
  }

  public parseProgram(): Program {
    const statements: Statement[] = [];
    this.skipNewlines();
    while (!this.check(TokenKind.EndOfFile)) {
      const startIndex = this.current;
      const diagnosticCount = this.diagnostics.length;
      const statement = runParse(this.parseStatement());
      if (statement !== null) statements.push(statement);
      this.endStatement(startIndex, diagnosticCount, false);
    }

    return Object.freeze({
      kind: "program",
      statements: Object.freeze(statements),
      span: createSourceSpan(createSourcePosition(0, 0, 0), this.peek().span.end),
    });
  }

  public *parseStatement(): ParseTask<Statement | null> {
    const misplacedHeader = readMisplacedHeader(this.tokens, this.current);
    if (misplacedHeader !== null) {
      this.diagnostics.push(misplacedHeader.diagnostic);
      this.current = misplacedHeader.next;
      return null;
    }
    const command = this.#commandAt("statement");
    switch (command) {
      case null:
        break;
      case "showButton":
        return yield* parseChild(parseShowButtonStatement(this));
      case "timer":
        return yield* parseChild(parseTimerStatement(this));
      case "showPermanentButton": {
        const parts = yield* parseChild(parseShowPermanentButtonParts(this));
        return parts === null
          ? null
          : Object.freeze({ kind: "showPermanentButtonStatement", ...parts });
      }
      case "showImage":
        return parseShowImageStatement(this);
      case "hideImage":
        return parseHideImageStatement(this);
      case "showCamera": {
        const parts = parseShowCameraParts(this);
        return parts === null ? null : Object.freeze({ kind: "showCameraStatement", ...parts });
      }
      case "hideCamera":
        return parseHideCameraStatement(this);
      case "showPopup":
        return yield* parseChild(parseShowPopupStatement(this));
      case "openUrl":
        return yield* parseChild(parseOpenUrlStatement(this));
      case "exportText":
        return yield* parseChild(parseExportTextStatement(this));
      case "stopAudio":
        return parseStopAudioStatement(this);
      case "save":
        return parseSaveStatement(this);
      case "delete":
        return parseDeleteStatement(this);
      case "switch":
        return yield* parseChild(parseSwitchStatement(this));
      case "label":
        return parseLabelStatement(this);
      case "goto":
      case "call":
        return yield* parseChild(parseTransferStatement(this));
      case "end":
        return Object.freeze({ kind: "endStatement", span: copySpan(this.advance().span) });
      case "global":
        return yield* parseChild(parseGlobalStatement(this));
      case "playAudio":
      case "playVideo": {
        const parts = yield* parseChild(parseMediaParts(this));
        return parts === null
          ? null
          : Object.freeze({ kind: "playMediaStatement", ...parts } satisfies PlayMediaStatement);
      }
      default:
        return command satisfies never;
    }
    if (
      this.check(TokenKind.KeywordWait) &&
      this.peek(1).kind === TokenKind.LeftParenthesis &&
      this.peek(2).kind === TokenKind.RightParenthesis
    ) {
      return this.#parseAssignmentOrExpressionStatement();
    }
    switch (this.peek().kind) {
      case TokenKind.KeywordSpeaker:
        return parseSpeakerStatement(this);
      case TokenKind.KeywordSay: {
        const parts = yield* parseChild(parseSayParts(this, true));
        return parts === null ? null : Object.freeze({ kind: "sayStatement", ...parts });
      }
      case TokenKind.KeywordWait:
        return parseWaitStatement(this);
      case TokenKind.KeywordExit:
        return parseExitStatement(this);
      case TokenKind.KeywordLet:
        return parseLetStatement(this);
      case TokenKind.KeywordIf:
        return yield* parseChild(parseIfStatement(this));
      case TokenKind.KeywordRepeat:
        return yield* parseChild(parseRepeatStatement(this));
      case TokenKind.KeywordFor:
        return yield* parseChild(parseForStatement(this));
      case TokenKind.KeywordWhile:
        return yield* parseChild(parseWhileStatement(this));
      case TokenKind.KeywordBreak:
        return parseLoopControl(this, "breakStatement");
      case TokenKind.KeywordContinue:
        return parseLoopControl(this, "continueStatement");
      case TokenKind.KeywordFunction:
        return yield* parseChild(parseFunctionDeclaration(this, null));
      case TokenKind.KeywordReturn:
        return parseReturnStatement(this);
      default: {
        const foreign = this.foreignStatementWord();
        if (foreign !== undefined) return yield* parseChild(this.#parseForeignStatement(foreign));
        if (isExpressionStart(this.peek())) {
          return this.#parseAssignmentOrExpressionStatement();
        }
        this.reportToken(
          parserDiagnosticCode.expectedStatement,
          "Expected a supported TeaseScript statement.",
          this.peek(),
        );
        this.synchronizeStatement();
        return null;
      }
    }
  }

  /**
   * A statement that starts with a word of another language (`foreignStatementWord`): reports the word, which the parse
   * of the TeaseScript word then reads in its place.
   */
  *#parseForeignStatement(
    word: NonNullable<ForeignForm["statement"]>,
  ): ParseTask<Statement | null> {
    this.reportForeignWord();
    switch (word) {
      case "function":
        return yield* parseChild(parseFunctionDeclaration(this, null));
      case "let":
        return parseLetStatement(this);
      case "say": {
        const parts = yield* parseChild(parseSayParts(this, true));
        return parts === null ? null : Object.freeze({ kind: "sayStatement", ...parts });
      }
      case "else if":
        return yield* parseChild(parseIfStatement(this));
      default:
        return word satisfies never;
    }
  }

  /**
   * `skippable` and `unskippable` predate their modifier meaning as ordinary
   * identifiers. Keep that interpretation whenever the existing say grammar
   * can consume a complete value (and optional pacing) from this position,
   * also one that recovered from an error, such as a string with a failed
   * interpolation. When a `/` follows the modifier (`afterModifier`), only a
   * value without errors counts: a regex may start there (V30 §8), and the
   * tokens after the `/` do not show its pattern, as in `say prose /[/*]/`.
   */
  public *canParseCompleteSayValue(
    statement: boolean,
    afterModifier: TokenKind | undefined,
  ): ParseTask<boolean> {
    const speculative = new Parser(this.tokens, this.shared);
    speculative.current = this.current;

    const value = yield* parseChild(speculative.parseOr());
    if (value === null) return false;
    // A unit after the word itself, as in `say bubble() s` or `say skippable ms`, is the earlier modifier followed by
    // text whose name is a unit word, also `calendar` or an angle unit.
    if (unitAfterWord(value, this.peek(), speculative.unitlessCalendars)) return false;

    if (speculative.match(TokenKind.Comma)) {
      if (speculative.canParseInstantPacingAlias(statement)) {
        speculative.advance();
      } else {
        const pacing = yield* parseChild(speculative.parseOr());
        if (pacing === null) return false;
      }
    }

    return (
      speculative.#isSayBoundary(statement) &&
      (afterModifier !== TokenKind.Slash || speculative.diagnostics.length === 0)
    );
  }

  /**
   * Whether the `(` here, after a `say` statement's mode and skip word, holds the text and pacing of its bounded form: a
   * comma follows its first value, also one that recovered from an error, such as a string with a failed interpolation.
   * Grouping parentheses, valid or not, hold one value.
   */
  public *opensBoundedSayText(): ParseTask<boolean> {
    const speculative = new Parser(this.tokens, this.shared);
    speculative.current = this.current + 1;
    speculative.skipNewlines();
    const value = yield* parseChild(speculative.withinDelimiters(speculative.parseOr()));
    if (value === null) return false;
    speculative.skipNewlines();
    return speculative.check(TokenKind.Comma);
  }

  /** The end of a compact `say`: of its statement, or as a value also of an enclosing `()` or `[]`. */
  #isSayBoundary(statement: boolean): boolean {
    return (
      this.check(TokenKind.Newline) ||
      this.check(TokenKind.RightBrace) ||
      this.check(TokenKind.EndOfFile) ||
      (!statement && (this.check(TokenKind.RightParenthesis) || this.check(TokenKind.RightBracket)))
    );
  }

  /** `instant` remains an identifier unless it fills the entire pacing slot. */
  public canParseInstantPacingAlias(statement: boolean): boolean {
    if (!this.checkIdentifier("instant")) return false;
    const speculative = new Parser(this.tokens, this.shared);
    speculative.current = this.current;
    speculative.advance();
    return speculative.#isSayBoundary(statement);
  }

  /** The source text from the start of `first` to the end of `last`, from tokens already read. */
  public textOf(first: SourceSpan, last: SourceSpan): string {
    // Tokens are in source order, so the first one is found by halving, whatever was read since.
    let low = 0;
    let high = this.current;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.tokens[middle]!.span.start.offset < first.start.offset) low = middle + 1;
      else high = middle;
    }
    let end = low;
    while (end < this.current && this.tokens[end]!.span.end.offset <= last.end.offset) end += 1;
    return this.sourceText(low, end);
  }

  /**
   * The source of the tokens from `start` up to `end`, with one space where the source separates two of them. A line
   * break between tokens separates them too, but not right after an opening bracket or before a closing one; one inside
   * a token, as in a block string, stays.
   */
  public sourceText(start: number, end: number): string {
    let text = "";
    let previous: Token | null = null;
    let lineBreak = false;
    for (let index = start; index < end; index += 1) {
      const token = this.tokens[index]!;
      if (token.kind === TokenKind.Newline) {
        lineBreak = true;
        continue;
      }
      if (
        previous !== null &&
        token.span.start.offset > previous.span.end.offset &&
        !(lineBreak && (OPENING_TOKENS.has(previous.kind) || CLOSING_TOKENS.has(token.kind)))
      )
        text += " ";
      text += token.lexeme;
      previous = token;
      lineBreak = false;
    }
    return text;
  }

  /**
   * The arguments of a bounded command form such as `load("k", default: 0)`: at most one unnamed value, which comes
   * first, and each option of `names` at most once. `null` reports an already diagnosed failure.
   */
  public boundedArguments(
    command: Token,
    call: CallExpression,
    names: readonly string[],
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
  ): { value: Expression | null; options: ReadonlyMap<string, Expression> } | null {
    let value: Expression | null = null;
    const options = new Map<string, Expression>();
    let valid = true;
    let sawNamed = false;
    for (const argument of call.arguments) {
      if (argument.kind === "positionalArgument") {
        // An unnamed value after a named one is already reported.
        if (!sawNamed && value !== null) {
          this.reportSpan(
            code,
            `${command.lexeme}(...) takes one unnamed value. Name the others, such as '${names[0]}:'.`,
            argument.span,
          );
        }
        if (sawNamed || value !== null) valid = false;
        else value = argument.value;
        continue;
      }
      sawNamed = true;
      const name = argument.name.name;
      if (!names.includes(name)) {
        this.reportSpan(
          code,
          `Unknown ${command.lexeme} option '${name}'. Use ${names.map((known) => `'${known}:'`).join(" or ")}.`,
          argument.name.span,
        );
        valid = false;
      } else if (options.has(name)) {
        this.reportSpan(code, `Duplicate ${command.lexeme} option '${name}'.`, argument.name.span);
        valid = false;
      } else {
        options.set(name, argument.value);
      }
    }
    return valid ? { value, options } : null;
  }

  /**
   * Reports and skips a parenthesized group written directly after a command that uses command syntax. Recovery stops at
   * the end of the line, so an enclosing block keeps its closing brace.
   */
  public rejectAdjacentParenthesis(command: Token, message: string): boolean {
    if (
      !this.check(TokenKind.LeftParenthesis) ||
      this.peek().span.start.offset !== command.span.end.offset
    )
      return false;
    this.reportToken(parserDiagnosticCode.invalidMediaForm, message, this.peek());
    let depth = 0;
    let braces = 0;
    while (!this.check(TokenKind.Newline) && !this.check(TokenKind.EndOfFile)) {
      // An unclosed group never takes the closing brace of an enclosing block on the same line; braces opened inside
      // the group, as in an object argument, close there.
      if (depth > 0 && braces === 0 && this.check(TokenKind.RightBrace)) break;
      const token = this.advance();
      if (token.kind === TokenKind.LeftBrace) braces += 1;
      else if (token.kind === TokenKind.RightBrace) braces -= 1;
      else if (token.kind === TokenKind.LeftParenthesis) depth += 1;
      else if (token.kind === TokenKind.RightParenthesis && --depth === 0) break;
    }
    return true;
  }

  /** A statement block; statements inside it are not part of an enclosing cue position or switch subject. */
  public *parseBlock(): ParseTask<Block | null> {
    return yield* parseChild(this.asStatements(this.#parseBlockStatements()));
  }

  *#parseBlockStatements(): ParseTask<Block | null> {
    if (!this.match(TokenKind.LeftBrace)) {
      this.reportInsertion(parserDiagnosticCode.expectedBlock, "Expected '{' to start the block.");
      return null;
    }
    const leftBrace = this.previous();
    const statements: Statement[] = [];
    this.skipNewlines();
    while (!this.check(TokenKind.RightBrace) && !this.check(TokenKind.EndOfFile)) {
      const startIndex = this.current;
      const diagnosticCount = this.diagnostics.length;
      const statement = yield* parseChild(this.parseStatement());
      if (statement !== null) statements.push(statement);
      this.endStatement(startIndex, diagnosticCount, true);
    }
    if (!this.closeBlock(leftBrace)) return null;
    return Object.freeze({
      kind: "block",
      statements: Object.freeze(statements),
      span: spanFrom(leftBrace.span, this.previous().span),
    });
  }

  #parseAssignmentOrExpressionStatement(): AssignmentStatement | ExpressionStatement | null {
    const expression = this.parseExpression();
    if (expression === null) {
      this.synchronizeStatement();
      return null;
    }
    if (
      this.match(TokenKind.Equal) ||
      this.match(TokenKind.PlusEqual) ||
      this.match(TokenKind.MinusEqual)
    ) {
      const operatorKind = this.previous().kind;
      const operator: AssignmentStatement["operator"] =
        operatorKind === TokenKind.PlusEqual
          ? "+="
          : operatorKind === TokenKind.MinusEqual
            ? "-="
            : "=";
      this.skipContinuationNewlines();
      const value = this.parseRequiredExpression();
      if (value === null) {
        this.synchronizeStatement();
        return null;
      }
      if (!isAssignmentTarget(expression)) {
        this.reportSpan(
          parserDiagnosticCode.invalidAssignmentTarget,
          "The left side of an assignment must be a variable, property, or index.",
          expression.span,
        );
        return null;
      }
      return Object.freeze({
        kind: "assignmentStatement",
        operator,
        target: expression,
        value,
        span: spanFrom(expression.span, value.span),
      });
    }
    if (
      expression.kind !== "callExpression" &&
      !(expression.kind === "tagQueryExpression" && expression.select === "list") &&
      // `askBooleans(...)` was a call, which a statement may discard the answer of.
      !(expression.kind === "interactionExpression" && expression.interactionKind === "booleans")
    ) {
      if (expression.kind === "identifier") {
        this.reportSpan(
          parserDiagnosticCode.expectedStatement,
          // `fallback` was a statement until an end always returned to a call.
          expression.name === "fallback"
            ? "TeaseScript has no 'fallback': an 'end' returns to the file that called this one. Use 'call' to start a file that should come back here, and 'goto' or 'exit' where no call waits."
            : "Expected a supported TeaseScript statement.",
          expression.span,
        );
        this.synchronizeStatement();
        return null;
      }
      this.reportSpan(
        parserDiagnosticCode.invalidExpressionStatement,
        "Only function or method calls may be used as expression statements.",
        expression.span,
      );
      return null;
    }
    return Object.freeze({
      kind: "expressionStatement",
      expression,
      span: copySpan(expression.span),
    });
  }

  public parseRequiredExpression(): Expression | null {
    return runParse(this.parseRequiredExpressionTask());
  }

  /**
   * The expression before the block of `if`, `while`, `repeat`, `for`, or `switch`, where the block's `{` ends a compact
   * interaction, so `if askBoolean { ... }` asks without a question.
   */
  public parseBlockHead(): Expression | null {
    const enclosing = this.blockEndsCompactInteraction;
    this.blockEndsCompactInteraction = true;
    try {
      return this.parseRequiredExpression();
    } finally {
      this.blockEndsCompactInteraction = enclosing;
    }
  }

  public parseExpression(): Expression | null {
    return runParse(this.parseOr());
  }

  public *parseRequiredExpressionTask(): ParseTask<Expression | null> {
    const mark = this.mark();
    const expression = yield* parseChild(this.parseOr());
    if (expression === null)
      this.reportMissing(mark, parserDiagnosticCode.expectedExpression, "Expected an expression.");
    return expression;
  }

  /**
   * Parses the value after a `:` that requires one. Newlines after the colon continue the statement unless the next
   * line plainly starts something else; the value is then missing, and the token stays for the enclosing recovery.
   */
  public *parseColonValueTask(required: boolean): ParseTask<Expression | null> {
    if (this.check(TokenKind.Newline)) {
      this.skipContinuationNewlines();
      if (this.#startsNonValueLine()) {
        if (required) {
          this.reportInsertion(parserDiagnosticCode.expectedExpression, "Expected an expression.");
        }
        return null;
      }
    }
    return yield* parseChild(required ? this.parseRequiredExpressionTask() : this.parseOr());
  }

  /** A statement, a property or choice key, a closing delimiter, or the end of the file. */
  #startsNonValueLine(): boolean {
    const token = this.peek();
    const next = this.peek(1).kind;
    if (
      (isPropertyName(token) || token.kind === TokenKind.NumberLiteral) &&
      next === TokenKind.Colon
    )
      return true;
    switch (token.kind) {
      case TokenKind.EndOfFile:
      case TokenKind.RightBrace:
      case TokenKind.RightParenthesis:
      case TokenKind.RightBracket:
        return true;
      case TokenKind.KeywordSpeaker:
        return next === TokenKind.Identifier;
      default:
        return this.atStatementStart();
    }
  }

  public *parseOr(): ParseTask<Expression | null> {
    let expression = yield* parseChild(this.#parseAnd());
    while (expression !== null) {
      const operator = this.#matchOperator(TokenKind.KeywordOr) ?? this.#matchSymbolicOr();
      if (operator === null) break;
      this.skipContinuationNewlines();
      const mark = this.mark();
      const right = yield* parseChild(this.#parseAnd());
      if (right === null) {
        this.#reportMissingOperand("or", "Expected an expression after 'or'.", mark);
        return null;
      }
      const left = expression;
      expression = this.#binary(left, right, "or", operator);
      this.#reportOtherwiseOperand(expression, left);
      this.#reportOtherwiseOperand(expression, right);
    }
    return expression;
  }

  *#parseAnd(): ParseTask<Expression | null> {
    let expression = yield* parseChild(this.#parseNot());
    while (expression !== null) {
      const operator =
        this.#matchOperator(TokenKind.KeywordAnd) ??
        this.#matchSymbol(TokenKind.Ampersand, "oneOrTwo");
      if (operator === null) break;
      this.skipContinuationNewlines();
      const mark = this.mark();
      const right = yield* parseChild(this.#parseNot());
      if (right === null) {
        this.#reportMissingOperand("and", "Expected an expression after 'and'.", mark);
        return null;
      }
      const left = expression;
      expression = this.#binary(left, right, "and", operator);
      this.#reportOtherwiseOperand(expression, left);
      this.#reportOtherwiseOperand(expression, right);
    }
    return expression;
  }

  *#parseNot(): ParseTask<Expression | null> {
    const operators: Token[] = [];
    while (this.matchNot()) {
      operators.push(this.previous());
      this.skipContinuationNewlines();
    }
    const mark = this.mark();
    let expression = yield* parseChild(this.#parseComparison());
    if (expression === null) {
      if (operators.length > 0)
        this.#reportMissingOperand("not", "Expected an expression after 'not'.", mark);
      return null;
    }
    const operand = expression;
    for (let index = operators.length - 1; index >= 0; index -= 1) {
      expression = this.#unary(operators[index]!, expression, "not");
    }
    if (operators.length > 0) this.#reportOtherwiseOperand(expression, operand);
    return expression;
  }

  *#parseComparison(): ParseTask<Expression | null> {
    const diagnosticCount = this.diagnostics.length;
    const left = yield* parseChild(this.#parseOtherwise());
    if (left === null) return null;
    let expression: Expression;
    if (this.check(TokenKind.KeywordIs)) {
      expression = yield* parseChild(this.#parseTypeTestTask(left));
      if (expression !== left) this.#reportOtherwiseOperand(expression, left);
    } else if (isComparisonKind(this.peek().kind)) {
      const operator = this.advance();
      // `===` and `!==` of other languages, which are read as `==` and `!=`.
      if (
        (operator.kind === TokenKind.EqualEqual || operator.kind === TokenKind.BangEqual) &&
        this.check(TokenKind.Equal) &&
        this.peek().span.start.offset === operator.span.end.offset
      ) {
        const extra = this.advance();
        this.reportSpan(
          parserDiagnosticCode.foreignForm,
          FOREIGN_FORMS.get(operator.lexeme + extra.lexeme)!.message,
          spanFrom(operator.span, extra.span),
        );
      }
      this.skipContinuationNewlines();
      const leftQuotable = this.diagnostics.length === diagnosticCount;
      const right = yield* parseChild(
        this.#parseOperand(
          operator.lexeme,
          () => this.#parseOtherwise(),
          "Expected an expression after the comparison operator.",
          (operators, value, quotable) =>
            this.#reportNotAfterComparison(
              left,
              operator,
              operators,
              value,
              leftQuotable && quotable,
            ),
        ),
      );
      if (right === null) return null;
      expression = this.#binary(left, right, binaryOperator(operator), operator.span);
      this.#reportOtherwiseOperand(expression, left);
      this.#reportOtherwiseOperand(expression, right);
    } else {
      return left;
    }
    if (isComparisonKind(this.peek().kind) || this.check(TokenKind.KeywordIs)) {
      this.reportToken(
        parserDiagnosticCode.chainedComparison,
        "Comparisons may not be chained.",
        this.peek(),
      );
      while (isComparisonKind(this.peek().kind) || this.check(TokenKind.KeywordIs)) {
        if (this.check(TokenKind.KeywordIs)) {
          yield* parseChild(this.#parseTypeTestTask(expression));
          continue;
        }
        this.advance();
        this.skipContinuationNewlines();
        // The chain has its error already, so a `not` here, as in `a == b == not c`, is read without another one.
        while (this.matchNot()) this.skipContinuationNewlines();
        yield* parseChild(this.#parseOtherwise());
      }
    }
    return expression;
  }

  /**
   * The operand after `symbol`, a comparison, `otherwise`, arithmetic, a range, or a sign, which `parse` reads, or
   * `missing` without one: its message, or what reports it. `not` binds more loosely than each of them (V30 §5), so
   * `x == not a` has no operand after the `==`: `report` gives the one error for the `not`, and the rest is read as
   * `x == (not a)`, so that nothing after it reports another error. `report` hears whether the operand is free of errors
   * of its own, which the `??` of `x == not a ?? b` is not.
   */
  *#parseOperand(
    symbol: string,
    parse: () => ParseTask<Expression | null>,
    missing: string | ((mark: ParseMark) => void),
    report: (operators: readonly Token[], value: Expression, quotable: boolean) => void,
  ): ParseTask<Expression | null> {
    const operators: Token[] = [];
    while (this.matchNot()) {
      operators.push(this.previous());
      this.skipContinuationNewlines();
    }
    const mark = this.mark();
    let value = yield* parseChild(parse());
    if (value === null) {
      if (operators.length > 0)
        this.#reportMissingOperand("not", "Expected an expression after 'not'.", mark);
      else if (typeof missing === "string") this.#reportMissingOperand(symbol, missing, mark);
      else missing(mark);
      return null;
    }
    if (operators.length === 0) return value;
    report(operators, value, this.diagnostics.length === mark.diagnostics);
    for (let index = operators.length - 1; index >= 0; index -= 1) {
      value = this.#unary(operators[index]!, value, "not");
    }
    return value;
  }

  /**
   * Reports the value missing after `symbol`, unless the operand reported its own error, as the `==` of `a and x ==`
   * does. Before the `{` that ends a block head, as in `if x == {`, the message says that the `{` starts the block.
   */
  #reportMissingOperand(symbol: string, message: string, mark: ParseMark): void {
    this.reportMissing(
      mark,
      parserDiagnosticCode.expectedExpression,
      this.#atHeadBlock()
        ? `Expected a value after '${symbol}': the '{' that follows starts the block. Write the value before the '{'.`
        : message,
    );
  }

  /**
   * Reports `not` right after a comparison operator. The message quotes the code as written in two forms that compile:
   * the opposite comparison, and the `not` in parentheses after `==` or `!=`, or before the whole comparison after `<`,
   * `<=`, `>`, or `>=`, which do not compare true and false. Two `not`s cancel out. An operand with an error of its own,
   * as the `??` of `x ?? false == not a`, is not quoted, nor an `otherwise` without parentheses, which needs them here.
   */
  #reportNotAfterComparison(
    left: Expression,
    operator: Token,
    operators: readonly Token[],
    value: Expression,
    quotable: boolean,
  ): void {
    const symbol = operator.lexeme;
    this.#reportNotReadings(
      symbol,
      left,
      operators,
      value,
      quotable && !isOtherwise(left) && !isOtherwise(value),
      ["x", "a"],
      (compared, negated) => {
        if (operators.length % 2 === 0) return [`${compared} ${symbol} ${negated}`];
        const opposite = `${compared} ${OPPOSITE_COMPARISONS[symbol]!} ${negated}`;
        return symbol === "==" || symbol === "!="
          ? [opposite, `${compared} ${symbol} (not ${negated})`]
          : [opposite, `not (${compared} ${symbol} ${negated})`];
      },
    );
  }

  /**
   * Reports `not` right after `symbol`, quoting the code to write: `readings` of the source text of `left` and of the
   * operand after the `not`s. Only a short expression is quoted, as for `otherwise` (see `#reportUnclearOtherwise`), and
   * one without errors of its own; the readings of `example` stand in for it.
   */
  #reportNotReadings(
    symbol: string,
    left: Expression,
    operators: readonly Token[],
    value: Expression,
    quotable: boolean,
    example: readonly [string, string],
    readings: (left: string, value: string) => string[],
  ): void {
    let written: string[] | undefined;
    if (quotable && value.span.end.offset - left.span.start.offset <= 240) {
      written = readings(this.textOf(left.span, left.span), this.textOf(value.span, value.span));
      if (!written.every((reading) => reading.length <= 60 && !reading.includes("\n")))
        written = undefined;
    }
    const quoted = (written ?? readings(...example)).map((reading) => `'${reading}'`).join(", or ");
    this.reportSpan(
      parserDiagnosticCode.expectedExpression,
      `'not' cannot follow '${symbol}' directly. Write ${written === undefined ? "it as in " : ""}${quoted}.`,
      operators[0]!.span,
    );
  }

  /**
   * Reports `not` right after arithmetic, a sign, or a range operator, which cannot use the true or false it gives,
   * also in parentheses, so the message names no grouping.
   */
  #reportNotAfterArithmetic(symbol: string, operators: readonly Token[]): void {
    const user = symbol === ".." || symbol === "..=" ? "a range" : `'${symbol}'`;
    this.reportSpan(
      parserDiagnosticCode.expectedExpression,
      `'not' cannot follow '${symbol}': it gives true or false, which ${user} cannot use. Remove the 'not'.`,
      operators[0]!.span,
    );
  }

  /** `value is T` or `value is not T`; the right operand is a type, not a value (ADR 0021). */
  *#parseTypeTestTask(value: Expression): ParseTask<Expression> {
    this.advance();
    this.skipContinuationNewlines();
    const negated = this.matchNot();
    this.skipContinuationNewlines();
    const first = this.peek();
    if (this.atComparedValue()) {
      const compared = yield* parseChild(this.#parseOtherwise());
      this.reportSpan(
        parserDiagnosticCode.invalidType,
        "'is' checks a type. Use '==' to compare values.",
        compared?.span ?? first.span,
      );
      return value;
    }
    const opener = this.shared.openers[this.current];
    const type = yield* parseChild(
      parseTypeTask(
        this,
        opener === TokenKind.LeftParenthesis || opener === TokenKind.LeftBracket
          ? "delimitedTypeTest"
          : "typeTest",
      ),
    );
    if (type === null) return value;
    // A type test ends its operand too (see `#parseMultiplicative`).
    this.#skipNewlinesBeforeOperator();
    return Object.freeze({
      kind: "typeTestExpression",
      value,
      type,
      negated,
      span: spanFrom(value.span, type.span),
    });
  }

  /** Whether the right operand of `is`, after any `(`, starts a value rather than a type, as in `is ("happy")`. */
  public atComparedValue(): boolean {
    let offset = 0;
    while (
      this.peek(offset).kind === TokenKind.LeftParenthesis ||
      this.peek(offset).kind === TokenKind.Newline
    ) {
      offset += 1;
    }
    const token = this.peek(offset);
    // The type is missing before the `{` of the block, as in `if x is {`.
    if (offset === 0 && this.#atHeadBlock()) return false;
    // `set[1]` is a set value; `set` alone, or `set[]` for a list of sets, is a type.
    if (
      token.kind === TokenKind.KeywordSet &&
      this.peek(offset + 1).kind === TokenKind.LeftBracket &&
      this.peek(offset + 2).kind !== TokenKind.RightBracket
    )
      return true;
    return typeName(token) === undefined && isExpressionStart(token);
  }

  /**
   * `a otherwise b`, left-associative, between the ranges and the comparisons. Next to any other operator it needs
   * parentheses, because the fallback could be meant for its nearest value or for all of that operator's operand (V30 §5,
   * §18): this reports arithmetic and ranges, and `#reportOtherwiseOperand` the operators that bind more loosely.
   */
  *#parseOtherwise(): ParseTask<Expression | null> {
    const diagnosticCount = this.diagnostics.length;
    let expression = yield* parseChild(this.#parseRange());
    while (expression !== null) {
      const word = this.#matchOperator(TokenKind.KeywordOtherwise);
      const operator = word ?? this.#matchSymbol(TokenKind.Question, "two");
      if (operator === null) break;
      this.skipContinuationNewlines();
      const left = expression;
      // Arithmetic before `otherwise` needs parentheses too, which only its own message names (see below).
      const leftQuotable =
        this.diagnostics.length === diagnosticCount && !isArithmetic(left) && !isSign(left);
      const right = yield* parseChild(
        this.#parseOperand(
          "otherwise",
          () => this.#parseRange(),
          "Expected a fallback value after 'otherwise'.",
          (operators, value, quotable) => {
            // A `??` has its one error already (V30 §39).
            if (word === null) return;
            this.#reportNotReadings(
              "otherwise",
              left,
              operators,
              value,
              leftQuotable && quotable,
              ["a", "b"],
              (fallen, fallback) => [
                operators.length % 2 === 0
                  ? `${fallen} otherwise ${fallback}`
                  : `${fallen} otherwise (not ${fallback})`,
              ],
            );
          },
        ),
      );
      if (right === null) return null;
      const otherwise = this.#binary(expression, right, "otherwise", operator);
      // A `??` has its one error already (V30 §39), and so has a `not` that starts the fallback, which only
      // `#parseOperand` reads there: the parentheses follow once both are written as they should be.
      if (
        word === null ||
        (right.kind === "unaryExpression" && right.operator === "not") ||
        this.#reportMixedOtherwise(expression, right, operator)
      )
        this.shared.faultyOtherwise.add(otherwise);
      expression = otherwise;
    }
    return expression;
  }

  /**
   * Reports an operand of `otherwise` that is arithmetic or a range without parentheses (owner decision on #850), and
   * tells whether it did. The message names both readings: the fallback for the nearest value, and for the whole
   * operand. A sign before the fallback, as in `otherwise -1`, can be read only one way.
   */
  #reportMixedOtherwise(left: Expression, right: Expression, operator: SourceSpan): boolean {
    const leftMixed = isArithmetic(left) || isSign(left);
    const rightMixed = isArithmetic(right);
    if (!leftMixed && !rightMixed) return false;
    // The values next to `otherwise`: the last one of the left operand and the first one of the right operand.
    let last = left;
    while (isArithmetic(last) || isSign(last))
      last = isSign(last) ? last.operand : last.kind === "binaryExpression" ? last.right : last.end;
    let first = right;
    while (isArithmetic(first))
      first = first.kind === "binaryExpression" ? first.left : first.start;
    this.#reportUnclearOtherwise(operator, spanFrom(left.span, right.span), () => {
      // The source text of an operand ends with that of its last value and starts with that of its first one.
      const text = (expression: Expression) => this.textOf(expression.span, expression.span);
      const [whole, value, fallback, rest] = [text(left), text(last), text(first), text(right)];
      return [
        {
          code: `${whole.slice(0, whole.length - value.length)}(${value} otherwise ${fallback})${rest.slice(fallback.length)}`,
          subject: value,
          fallback,
        },
        {
          code: `${leftMixed ? `(${whole})` : whole} otherwise ${rightMixed ? `(${rest})` : rest}`,
          subject: whole,
          fallback: rest,
        },
      ];
    });
    return true;
  }

  /**
   * Reports an `otherwise` without parentheses as an operand of `whole`: a comparison, a type test, `not`, `and`, or `or`
   * (owner decision on #1243). As for arithmetic, the message names both readings: the fallback for the value next to the
   * operator, and for all of the operator's operand. In a chain, the last `otherwise` before the operator is next to it,
   * and the first one after it.
   */
  #reportOtherwiseOperand(whole: Expression, operand: Expression): void {
    if (!isOtherwise(operand)) return;
    const before = operand.span.start.offset === whole.span.start.offset;
    let next = operand;
    while (!before && isOtherwise(next.left)) next = next.left;
    if (this.shared.faultyOtherwise.has(next)) return;
    this.#reportUnclearOtherwise(next.operatorSpan, whole.span, () => {
      // The source text of `whole` starts or ends with that of the operand, and so does that of a chain with the value
      // at its far end.
      const text = (expression: Expression) => this.textOf(expression.span, expression.span);
      const [all, own] = [text(whole), text(operand)];
      if (before) {
        const [rest, fallback] = [all.slice(own.length), text(operand.right)];
        const subject = text(operand.left);
        return [
          { code: `(${own})${rest}`, subject, fallback },
          {
            code: `${own.slice(0, own.length - fallback.length)}(${fallback}${rest})`,
            subject,
            fallback: `${fallback}${rest}`,
          },
        ];
      }
      const [rest, value] = [all.slice(0, all.length - own.length), text(next.left)];
      const fallback = text(next.right);
      return [
        { code: `${rest}(${own})`, subject: value, fallback },
        {
          code: `(${rest}${value})${own.slice(value.length)}`,
          subject: `${rest}${value}`,
          fallback,
        },
      ];
    });
  }

  /**
   * Reports the `otherwise` at `operator`, which needs parentheses, naming both `readings` with the code as written. Only
   * a short expression is quoted, which also keeps a long chain from being written out for each error in it.
   */
  #reportUnclearOtherwise(
    operator: SourceSpan,
    span: SourceSpan,
    readings: () => readonly { code: string; subject: string; fallback: string }[],
  ): void {
    let message = "It is unclear what 'otherwise' belongs to. Put parentheses around that part";
    if (span.end.offset - span.start.offset <= 240) {
      const choices = readings();
      if (choices.every(({ code }) => code.length <= 60 && !code.includes("\n")))
        message += `: ${choices
          .map(
            ({ code, subject, fallback }) =>
              `'${code}' uses ${/\s/.test(fallback) ? `'${fallback}'` : fallback} when '${subject}' is null`,
          )
          .join("; ")}`;
    }
    this.reportSpan(parserDiagnosticCode.mixedOtherwise, `${message}.`, operator);
  }

  *#parseRange(): ParseTask<Expression | null> {
    const left = yield* parseChild(this.#parseAdditive());
    if (
      left === null ||
      (!this.check(TokenKind.RangeExclusive) && !this.check(TokenKind.RangeInclusive))
    ) {
      return left;
    }
    const operator = this.advance();
    this.skipContinuationNewlines();
    const right = yield* parseChild(
      this.#parseOperand(
        operator.lexeme,
        () => this.#parseAdditive(),
        "Expected an expression after the range operator.",
        (operators) => this.#reportNotAfterArithmetic(operator.lexeme, operators),
      ),
    );
    if (right === null) return null;
    const expression: Expression = Object.freeze({
      kind: "rangeExpression",
      start: left,
      end: right,
      inclusive: operator.kind === TokenKind.RangeInclusive,
      span: spanFrom(left.span, right.span),
    });
    if (this.check(TokenKind.RangeExclusive) || this.check(TokenKind.RangeInclusive)) {
      this.reportToken(
        parserDiagnosticCode.chainedRange,
        "Ranges may not be chained.",
        this.peek(),
      );
      while (this.check(TokenKind.RangeExclusive) || this.check(TokenKind.RangeInclusive)) {
        this.advance();
        this.skipContinuationNewlines();
        yield* parseChild(this.#parseAdditive());
      }
    }
    return expression;
  }

  *#parseAdditive(): ParseTask<Expression | null> {
    let expression = yield* parseChild(this.#parseMultiplicative());
    while (expression !== null && (this.check(TokenKind.Plus) || this.check(TokenKind.Minus))) {
      const operator = this.advance();
      this.skipContinuationNewlines();
      const right = yield* parseChild(
        this.#parseOperand(
          operator.lexeme,
          () => this.#parseMultiplicative(),
          "Expected an expression after the arithmetic operator.",
          (operators) => this.#reportNotAfterArithmetic(operator.lexeme, operators),
        ),
      );
      if (right === null) return null;
      expression = this.#binary(expression, right, binaryOperator(operator), operator.span);
    }
    return expression;
  }

  *#parseMultiplicative(): ParseTask<Expression | null> {
    let expression = yield* parseChild(this.#parseUnaryArithmetic());
    while (expression !== null) {
      // Every operand but a type test ends here, so each level above finds an operator that starts the next line.
      this.#skipNewlinesBeforeOperator();
      if (
        !this.check(TokenKind.Star) &&
        !this.check(TokenKind.Slash) &&
        !this.check(TokenKind.Percent)
      )
        break;
      const operator = this.advance();
      this.skipContinuationNewlines();
      const right = yield* parseChild(
        this.#parseOperand(
          operator.lexeme,
          () => this.#parseUnaryArithmetic(),
          "Expected an expression after the arithmetic operator.",
          (operators) => this.#reportNotAfterArithmetic(operator.lexeme, operators),
        ),
      );
      if (right === null) return null;
      expression = this.#binary(expression, right, binaryOperator(operator), operator.span);
    }
    return expression;
  }

  *#parseUnaryArithmetic(): ParseTask<Expression | null> {
    const before = this.tokens[this.current - 1];
    // `count++` and `count--` of other languages: one sign that touches the same sign between values, with no value
    // after it. A line goes on after a binary operator but not after a sign (V30 §1), so this sign ends its line.
    const touching =
      before !== undefined &&
      this.peek().kind === before.kind &&
      before.span.end.offset === this.peek().span.start.offset;
    const operators: Token[] = [];
    while (this.check(TokenKind.Plus) || this.check(TokenKind.Minus)) {
      operators.push(this.advance());
      if (!touching || operators.length > 1) this.skipContinuationNewlines();
    }
    const sign = operators.at(-1);
    if (sign === undefined) return yield* parseChild(this.#parsePostfix());
    const increment =
      touching && operators.length === 1
        ? FOREIGN_FORMS.get(before!.lexeme + sign.lexeme)
        : undefined;
    let expression = yield* parseChild(
      this.#parseOperand(
        sign.lexeme,
        () => this.#parseUnaryArithmetic(),
        increment === undefined
          ? "Expected an expression after the unary operator."
          : (mark) =>
              this.reportMissing(
                mark,
                parserDiagnosticCode.foreignForm,
                increment.message,
                spanFrom(before!.span, sign.span),
              ),
        (nots) => this.#reportNotAfterArithmetic(sign.lexeme, nots),
      ),
    );
    if (expression === null) return null;
    for (let index = operators.length - 1; index >= 0; index -= 1) {
      const operator = operators[index]!;
      // EVIDENCE: invariant: operators contains only the plus/minus tokens collected by the loop above.
      expression = this.#unary(operator, expression, operator.lexeme as "+" | "-");
    }
    return expression;
  }

  *#parsePostfix(): ParseTask<Expression | null> {
    const start = this.current;
    let expression = yield* parseChild(this.#parsePrimary());
    while (expression !== null) {
      if (this.match(TokenKind.Dot)) {
        if (!isPropertyName(this.peek())) {
          this.reportInsertion(
            parserDiagnosticCode.expectedPropertyAfterDot,
            "Expected a property name after '.'.",
          );
          return expression;
        }
        const property = this.identifier(this.advance());
        expression = Object.freeze({
          kind: "propertyAccessExpression",
          object: expression,
          property,
          span: spanFrom(expression.span, property.span),
        } satisfies PropertyAccessExpression);
        continue;
      }
      if (this.match(TokenKind.LeftBracket)) {
        const start = expression;
        this.skipNewlines();
        const index = yield* parseChild(this.withinDelimiters(this.parseRequiredExpressionTask()));
        this.skipNewlines();
        if (index === null || !this.match(TokenKind.RightBracket)) {
          if (index !== null) {
            this.reportInsertion(
              parserDiagnosticCode.expectedDelimiter,
              "Expected ']' after the index expression.",
            );
          }
          return expression;
        }
        expression = Object.freeze({
          kind: "indexExpression",
          object: start,
          index,
          span: spanFrom(start.span, this.previous().span),
        });
        continue;
      }
      if (this.match(TokenKind.LeftParenthesis)) {
        if (
          expression.kind === "identifier" &&
          (expression.name === "findImages" || expression.name === "findScripts")
        ) {
          expression = yield* parseChild(
            this.withinDelimiters(
              finishFindQuery(
                this,
                expression,
                this.previous(),
                expression.name === "findImages" ? "images" : "scripts",
              ),
            ),
          );
          continue;
        }
        expression = yield* parseChild(
          this.withinDelimiters(this.finishCall(expression, this.previous())),
        );
        continue;
      }
      break;
    }
    return expression === null ? null : parseUnitSuffix(this, expression, start);
  }

  public *finishCall(callee: Expression, left: Token): ParseTask<CallExpression> {
    const argumentsList: CallArgument[] = [];
    let sawPositional = false;
    let sawNamed = false;
    this.skipNewlines();
    while (!this.check(TokenKind.RightParenthesis) && !this.check(TokenKind.EndOfFile)) {
      let argument: CallArgument | null = null;
      if (isPropertyName(this.peek()) && this.peek(1).kind === TokenKind.Colon) {
        const name = this.identifier(this.advance());
        this.advance();
        const value = yield* parseChild(this.parseColonValueTask(true));
        if (value !== null) {
          argument = Object.freeze({
            kind: "namedArgument",
            name,
            value,
            span: spanFrom(name.span, value.span),
          } satisfies NamedArgument);
        }
        sawNamed = true;
      } else {
        const value = yield* parseChild(this.parseRequiredExpressionTask());
        if (value !== null) {
          argument = Object.freeze({
            kind: "positionalArgument",
            value,
            span: copySpan(value.span),
          } satisfies PositionalArgument);
        }
        if (sawNamed && value !== null) this.#reportPositionalAfterNamed(value.span);
        sawPositional = true;
      }
      if (argument !== null) argumentsList.push(argument);
      this.skipNewlines();
      if (!this.match(TokenKind.Comma)) break;
      this.skipNewlines();
      if (this.check(TokenKind.RightParenthesis)) {
        this.reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an argument after ','.",
        );
        break;
      }
    }

    let end = left.span;
    if (this.match(TokenKind.RightParenthesis)) end = this.previous().span;
    else {
      this.reportMissingCloser(
        parserDiagnosticCode.expectedDelimiter,
        "Expected ')' after the function arguments.",
      );
      if (argumentsList.length > 0) end = argumentsList.at(-1)!.span;
    }
    return Object.freeze({
      kind: "callExpression",
      callee,
      arguments: Object.freeze(argumentsList),
      argumentStyle: sawNamed
        ? sawPositional
          ? "mixed"
          : "named"
        : sawPositional
          ? "positional"
          : "none",
      span: spanFrom(callee.span, end),
    });
  }

  *#parsePrimary(): ParseTask<Expression | null> {
    const token = this.peek();
    const command = this.#commandAt("value");
    if (command !== null && isAsk(command)) {
      // An earlier name, such as `choose`, is an error that names the fix, and the ask is read as written (#830).
      const renamed = commandFacts(command)?.renamed;
      if (renamed !== undefined)
        this.reportToken(
          parserDiagnosticCode.unsupportedInteractionForm,
          `'${command}' is now called '${renamed}', like the other asks that wait for the player's answer. Write '${renamed}' instead.`,
          token,
        );
      return yield* parseChild(parseInteractionExpression(this, COMMANDS[command].interaction));
    }
    if (
      this.checkIdentifier("askImage") &&
      this.peek(1).kind === TokenKind.Identifier &&
      PRESENTATION_MODES.has(this.peek(1).lexeme)
    )
      return yield* parseChild(parseAskImageWithPresentation(this));
    switch (command) {
      case null:
        break;
      case "showButton": {
        const parts = yield* parseChild(parseShowButtonParts(this));
        return parts === null ? null : Object.freeze({ kind: "showButtonExpression", ...parts });
      }
      case "showPopup": {
        const parts = yield* parseChild(parseShowPopupParts(this));
        return parts === null ? null : Object.freeze({ kind: "showPopupExpression", ...parts });
      }
      case "timer": {
        const parts = yield* parseChild(parseTimerParts(this));
        return parts === null ? null : Object.freeze({ kind: "timerExpression", ...parts });
      }
      case "showCamera": {
        const parts = parseShowCameraParts(this);
        return parts === null ? null : Object.freeze({ kind: "showCameraExpression", ...parts });
      }
      case "showPermanentButton": {
        const parts = yield* parseChild(parseShowPermanentButtonParts(this));
        return parts === null
          ? null
          : Object.freeze({ kind: "showPermanentButtonExpression", ...parts });
      }
      case "playAudio":
      case "playVideo": {
        const parts = yield* parseChild(parseMediaParts(this));
        return parts === null ? null : Object.freeze({ kind: "playMediaExpression", ...parts });
      }
      case "load":
        return yield* parseChild(parseLoadExpression(this));
      default:
        return command satisfies never;
    }
    // At the start of a line outside brackets, `say` begins a statement, so a value continued onto it ends before it.
    if (
      this.check(TokenKind.KeywordSay) &&
      (this.insideDelimiters || this.previous()?.kind !== TokenKind.Newline)
    ) {
      const parts = yield* parseChild(parseSayValue(this));
      return parts === null ? null : Object.freeze({ kind: "sayExpression", ...parts });
    }
    if (this.match(TokenKind.NumberLiteral)) {
      const amount: NumberLiteral = Object.freeze({
        kind: "numberLiteral",
        raw: token.lexeme,
        value: Number(token.lexeme),
        numericType: /[.eE]/u.test(token.lexeme) ? "number" : "integer",
        span: copySpan(token.span),
      });
      return parseDurationUnit(this, amount, this.current - 1);
    }
    if (this.match(TokenKind.KeywordTrue)) {
      return Object.freeze({ kind: "booleanLiteral", value: true, span: copySpan(token.span) });
    }
    if (this.match(TokenKind.KeywordFalse)) {
      return Object.freeze({ kind: "booleanLiteral", value: false, span: copySpan(token.span) });
    }
    if (this.match(TokenKind.KeywordNull)) {
      return Object.freeze({ kind: "nullLiteral", value: null, span: copySpan(token.span) });
    }
    if (this.checkIdentifier("dict") && this.peek(1).kind === TokenKind.LeftBrace) {
      this.advance();
      this.advance();
      return yield* parseChild(this.withinDelimiters(parseDictLiteral(this, token)));
    }
    // The protected constant `pi` (V30 §13) is the number it names, and like a number it may take a unit: `pi rad`.
    if (this.checkIdentifier("pi")) {
      this.advance();
      return parseDurationUnit(
        this,
        Object.freeze({
          kind: "numberLiteral",
          raw: "pi",
          value: 3.141592653589793,
          numericType: "number",
          span: copySpan(token.span),
        }),
        this.current - 1,
      );
    }
    if (
      this.match(TokenKind.Identifier) ||
      this.match(TokenKind.KeywordSpeaker) ||
      this.match(TokenKind.KeywordWait)
    ) {
      return this.identifier(token);
    }
    if (this.match(TokenKind.StringStart)) {
      return yield* parseChild(this.#withoutEnclosingDelimiters(parseStringLiteral(this, token)));
    }
    if (this.match(TokenKind.RegexLiteral)) {
      const source = tokenValue(token);
      // The lexer reported a literal without its closing slash.
      if (token.lexeme.length < source.length + 2) {
        this.unclosedLiterals += 1;
        return null;
      }
      return Object.freeze({
        kind: "regexLiteral",
        source,
        flags: token.lexeme.slice(source.length + 2),
        span: copySpan(token.span),
      });
    }
    if (this.match(TokenKind.LeftParenthesis)) {
      return yield* parseChild(this.withinDelimiters(parseParenthesized(this, token)));
    }
    if (this.match(TokenKind.LeftBracket)) {
      return yield* parseChild(
        this.withinDelimiters(parseCollectionLiteralElements(this, token, "listLiteral")),
      );
    }
    // The `{` of a block head's block is no value (see `#atHeadBlock`).
    if (this.check(TokenKind.LeftBrace) && !this.#atHeadBlock()) {
      this.advance();
      return yield* parseChild(this.withinDelimiters(parseObjectLiteral(this, token)));
    }
    if (this.match(TokenKind.KeywordSet)) {
      if (!this.match(TokenKind.LeftBracket)) {
        this.reportInsertion(parserDiagnosticCode.expectedDelimiter, "Expected '[' after 'set'.");
        return null;
      }
      return yield* parseChild(
        this.withinDelimiters(parseCollectionLiteralElements(this, token, "setLiteral")),
      );
    }
    // The lexer took this `/` for division, but a value starts here (see `parse`).
    if (token.kind === TokenKind.Slash) this.regexStarts.push(token.span.start.offset);
    return null;
  }

  /** `default:` at `offset` tokens ahead, the named fallback of `load` or the session-start value of a `global`. */
  public atNamedDefault(offset: number): boolean {
    const token = this.peek(offset);
    return (
      token.kind === TokenKind.Identifier &&
      token.lexeme === "default" &&
      this.peek(offset + 1).kind === TokenKind.Colon
    );
  }

  /**
   * The offset of the token after a `,` and any newlines after it, or `null` without a comma. Inside delimiters a line
   * break does not end the expression, so the comma may also start the next line there (V30 §1). Nested interactions
   * that end at the same token reuse one scan of the newlines.
   */
  public offsetAfterComma(): number | null {
    const lookahead = this.#commaLookahead;
    if (lookahead?.at === this.current && lookahead.insideDelimiters === this.insideDelimiters)
      return lookahead.offset;
    let offset: number | null = 0;
    if (this.insideDelimiters) while (this.peek(offset).kind === TokenKind.Newline) offset += 1;
    if (this.peek(offset).kind !== TokenKind.Comma) offset = null;
    else {
      offset += 1;
      while (this.peek(offset).kind === TokenKind.Newline) offset += 1;
    }
    this.#commaLookahead = { at: this.current, insideDelimiters: this.insideDelimiters, offset };
    return offset;
  }

  public atStorageDelimiter(): boolean {
    return (
      (this.storageDelimiters.has("as") && this.check(TokenKind.KeywordAs)) ||
      // `default:` is a contextual name, such as a choice option label, not the earlier form.
      (this.storageDelimiters.has("default") &&
        this.checkIdentifier("default") &&
        this.peek(1).kind !== TokenKind.Colon)
    );
  }

  /** Parses a `()`, `[]`, or object-literal grouping, where a line break does not end an expression. */
  public *withinDelimiters<T>(task: ParseTask<T>): ParseTask<T> {
    const enclosing = this.insideDelimiters;
    this.insideDelimiters = true;
    try {
      return yield* parseChild(this.#withoutEnclosingDelimiters(task));
    } finally {
      this.insideDelimiters = enclosing;
    }
  }

  /** Parses a block of statements, where a line break ends a complete statement again. */
  public *asStatements<T>(task: ParseTask<T>): ParseTask<T> {
    const enclosing = this.insideDelimiters;
    this.insideDelimiters = false;
    try {
      return yield* parseChild(this.#withoutEnclosingDelimiters(task));
    } finally {
      this.insideDelimiters = enclosing;
    }
  }

  /**
   * Parses a grouping or block in which the delimiters that end an enclosing operand do not apply: the storage `as`
   * and `default`, and the block `{` after a cue position or switch subject.
   */
  *#withoutEnclosingDelimiters<T>(task: ParseTask<T>): ParseTask<T> {
    const enclosingStorageDelimiters = this.storageDelimiters;
    const enclosingBlockEndsInteraction = this.blockEndsCompactInteraction;
    this.storageDelimiters = NO_STORAGE_DELIMITERS;
    this.blockEndsCompactInteraction = false;
    try {
      return yield* parseChild(task);
    } finally {
      this.storageDelimiters = enclosingStorageDelimiters;
      this.blockEndsCompactInteraction = enclosingBlockEndsInteraction;
    }
  }

  /** Parses a `save` or `delete` operand that ends at the given delimiters. */
  public parseStorageOperand(delimiters: ReadonlySet<StorageDelimiter>): Expression | null {
    const enclosing = this.storageDelimiters;
    this.storageDelimiters = delimiters;
    const operand = this.parseExpression();
    this.storageDelimiters = enclosing;
    return operand;
  }

  /**
   * Whether the `{` next starts the block of a block head, such as the condition of an `if`, where the head expects a
   * value, as in `if x == {`. It starts an object literal instead when a property and its `:` follow, as in
   * `if door == { open: true } {`, or when the head goes on after its `}`, as in `if box == {} {`, where a block would
   * end the statement.
   */
  #atHeadBlock(): boolean {
    if (!this.blockEndsCompactInteraction || !this.check(TokenKind.LeftBrace)) return false;
    const afterNewlines = this.shared.newlineRuns.ends;
    const first = afterNewlines[this.current + 1]!;
    if (isPropertyName(this.tokens[first]!) && this.tokens[first + 1]?.kind === TokenKind.Colon)
      return false;
    this.shared.closers ??= delimiterClosers(this.tokens);
    const closer = this.shared.closers.get(this.current);
    if (closer === undefined) return true;
    const after = afterNewlines[closer + 1]!;
    const next = this.tokens[after]!.kind;
    // The block of a head on the next line, as in `if box == {}` and then `{` on a line of its own.
    if (after > closer + 1) return next !== TokenKind.LeftBrace;
    // A block ends its statement, or a button inside a grouping, as in `[showPermanentButton "Stop" { ... }]`. A comma
    // could also go on with the options of a compact `askChoice` in the head.
    return (
      next === TokenKind.EndOfFile ||
      next === TokenKind.RightBrace ||
      next === TokenKind.KeywordElse ||
      next === TokenKind.RightParenthesis ||
      next === TokenKind.RightBracket
    );
  }

  #binary(
    left: Expression,
    right: Expression,
    operator: BinaryExpression["operator"],
    operatorSpan: SourceSpan,
  ): BinaryExpression {
    return Object.freeze({
      kind: "binaryExpression",
      operator,
      left,
      right,
      operatorSpan: copySpan(operatorSpan),
      span: spanFrom(left.span, right.span),
    });
  }

  #unary(
    operatorToken: Token,
    operand: Expression,
    operator: UnaryExpression["operator"],
  ): UnaryExpression {
    return Object.freeze({
      kind: "unaryExpression",
      operator,
      operand,
      span: spanFrom(operatorToken.span, operand.span),
    });
  }

  public identifier(token: Token): Identifier {
    return Object.freeze({ kind: "identifier", name: token.lexeme, span: copySpan(token.span) });
  }

  public stringText(token: Token): StringText {
    return Object.freeze({
      kind: "stringText",
      raw: token.lexeme,
      value: tokenValue(token),
      span: copySpan(token.span),
    });
  }

  public consumeClosingDelimiter(kind: TokenKind, message: string): SourceSpan {
    this.skipNewlines();
    if (this.match(kind)) return this.previous().span;
    this.reportMissingCloser(parserDiagnosticCode.expectedDelimiter, message);
    return this.previous().span;
  }

  /**
   * Reports a missing closing delimiter where its line ends: the newlines skipped while looking for it are given back,
   * so the statement on the next line still parses, as after `f("a"`.
   */
  public reportMissingCloser(
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
  ): void {
    if (this.current > 0 && this.previous().kind === TokenKind.Newline)
      this.current = this.shared.newlineRuns.starts[this.current - 1]!;
    this.reportInsertion(code, message);
  }

  /**
   * Ends the statement of a statement list that started at token `start` at the line break, `}`, or end of file after
   * it, records its range, and skips the line breaks before the next statement. `diagnosticCount` is the number of
   * diagnostics before it.
   */
  public endStatement(start: number, diagnosticCount: number, inBlock: boolean): void {
    if (this.current === start) this.advance();
    // Recovery has already stopped at the next statement.
    if (this.recoveredAtStatementBoundary) this.recoveredAtStatementBoundary = false;
    else this.finishStatement(inBlock);
    let end = this.current;
    // A statement with an error may be unfinished, such as one that ends in a comma or misses a list's `]`, so it also
    // holds the line breaks after it, where an author completes it, as a recovered one does.
    if (this.diagnostics.length > diagnosticCount && this.tokens[end]!.kind === TokenKind.Newline)
      end = this.shared.newlineRuns.ends[end]!;
    this.statementRanges.push(
      Object.freeze({
        kind: "statement",
        start: this.tokens[start]!.span.start.offset,
        end: this.tokens[end]!.span.start.offset,
      }),
    );
    this.skipNewlines();
  }

  /** Reads the `}` of the statement block opened by `leftBrace`, or reports it missing, and records the block's range. */
  public closeBlock(leftBrace: Token): boolean {
    const closed = this.match(TokenKind.RightBrace);
    if (!closed)
      this.reportInsertion(
        parserDiagnosticCode.expectedRightBrace,
        "Expected '}' to close the block.",
      );
    this.statementRanges.push(
      Object.freeze({
        kind: "block",
        start: leftBrace.span.end.offset,
        end: (closed ? this.previous() : this.peek()).span.start.offset,
      }),
    );
    return closed;
  }

  /** Stops at the line break, `}`, or end of file after a statement, reporting and skipping the rest of its line. */
  public finishStatement(inBlock: boolean): void {
    if (
      this.check(TokenKind.Newline) ||
      this.check(TokenKind.EndOfFile) ||
      (inBlock && this.check(TokenKind.RightBrace))
    ) {
      return;
    }
    this.reportInsertion(
      parserDiagnosticCode.expectedStatementEnd,
      "Expected a newline after the statement.",
    );
    this.synchronizeStatement(inBlock);
  }

  public skipMalformedBlock(): void {
    let depth = 0;
    while (!this.check(TokenKind.EndOfFile)) {
      if (this.match(TokenKind.LeftBrace)) depth += 1;
      else if (this.match(TokenKind.RightBrace)) {
        depth -= 1;
        if (depth === 0) return;
      } else this.advance();
    }
  }

  public synchronizeStatement(stopAtRightBrace = false): void {
    while (
      !this.check(TokenKind.Newline) &&
      !this.check(TokenKind.EndOfFile) &&
      !(stopAtRightBrace && this.check(TokenKind.RightBrace))
    ) {
      this.advance();
    }
  }

  /**
   * Skips the rest of a malformed compact interaction: to the end of its statement, or inside a grouping to the
   * grouping's closing delimiter, which the grouping then reads, so the statements after it still parse.
   */
  public skipInteractionRest(): void {
    if (!this.insideDelimiters) {
      this.synchronizeStatement();
      return;
    }
    let depth = 0;
    while (!this.check(TokenKind.EndOfFile)) {
      if (OPENING_TOKENS.has(this.peek().kind)) depth += 1;
      else if (CLOSING_TOKENS.has(this.peek().kind)) {
        if (depth === 0) return;
        depth -= 1;
      }
      this.advance();
    }
  }

  public synchronizeProperty(): void {
    while (
      !this.check(TokenKind.Newline) &&
      !this.check(TokenKind.RightBrace) &&
      !this.check(TokenKind.EndOfFile)
    ) {
      this.advance();
    }
  }

  /**
   * Skips a malformed element to the next comma or the closer, or to a statement that starts a line, which no element
   * can be: the closer is then missing, and the statement still parses, as after `let v = [` on a line of its own.
   */
  public synchronizeDelimited(closing: TokenKind): void {
    while (
      !this.check(TokenKind.Comma) &&
      !this.check(closing) &&
      !this.check(TokenKind.EndOfFile) &&
      !(this.previous().kind === TokenKind.Newline && this.atStatementStart())
    ) {
      this.advance();
    }
  }

  public synchronizeParameter(): void {
    while (
      !this.check(TokenKind.Comma) &&
      !this.check(TokenKind.RightParenthesis) &&
      !this.check(TokenKind.EndOfFile)
    ) {
      this.advance();
    }
  }

  public synchronizeInterpolation(): void {
    while (
      !this.check(TokenKind.InterpolationEnd) &&
      !this.check(TokenKind.StringEnd) &&
      !this.check(TokenKind.EndOfFile)
    ) {
      this.advance();
    }
  }

  /** A statement that ends an unclosed block, such as a speaker missing its closing brace, which a value cannot start. */
  public isRecoveredTopLevelStatement(): boolean {
    return (
      (this.atStatementStart() || this.checkIdentifier("showCamera")) &&
      this.peek(1).kind !== TokenKind.Colon
    );
  }

  /** A statement keyword, or a protected statement-only command, which can never be a value. */
  public atStatementStart(): boolean {
    const token = this.peek();
    return (
      isStatementStart(token.kind) ||
      (token.kind === TokenKind.Identifier && LINE_STATEMENTS.has(token.lexeme))
    );
  }

  /** Newline tokens delimit statements unless a caller explicitly skips them. */
  public skipNewlines(): void {
    if (this.check(TokenKind.Newline)) this.current = this.shared.newlineRuns.ends[this.current]!;
  }

  public skipContinuationNewlines(): void {
    this.skipNewlines();
  }

  /**
   * Inside `()`, `[]`, and object literals, where a line break does not end an expression, a binary operator may also
   * start the next line (V30 §1): skips the newlines before one, so that it continues the expression. Elsewhere a
   * newline before an operator ends the statement.
   */
  #skipNewlinesBeforeOperator(): void {
    if (!this.insideDelimiters || !this.check(TokenKind.Newline)) return;
    // V30 §1 does not list `${...}`, so its own expression ends at the newline, whatever encloses the string.
    if (this.shared.openers[this.current] === TokenKind.InterpolationStart) return;
    const after = this.shared.newlineRuns.ends[this.current]!;
    if (startsBinaryOperator(this.tokens, after)) this.current = after;
  }

  #reportPositionalAfterNamed(span: SourceSpan): void {
    this.reportSpan(
      parserDiagnosticCode.mixedArguments,
      "A positional argument may not follow a named argument. Move it before the named arguments, or name it too.",
      span,
    );
  }

  /** Reports `as` without the speaker after it, in a `say`, a `showButton`, or an ask. */
  public reportMissingSpeakerAfterAs(): void {
    this.reportInsertion(
      parserDiagnosticCode.expectedSpeakerAfterAs,
      "Expected a speaker identifier after 'as'.",
    );
  }

  public mark(): ParseMark {
    return { diagnostics: this.diagnostics.length, unclosedLiterals: this.unclosedLiterals };
  }

  /**
   * Reports the part missing here, at `at` or else before the next token, unless the part that failed since `mark`
   * reported its own error, as `1 +` in `wait 1 +` does. A part that failed at a string or regex without its closing
   * delimiter gets the error all the same, so that every later decision is the same, but only as a follow-up of the
   * lexer's report (see `SharedParse.followUps`).
   */
  public reportMissing(
    mark: ParseMark,
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
    at?: SourceSpan,
  ): void {
    if (this.diagnostics.length !== mark.diagnostics) return;
    if (at === undefined) this.reportInsertion(code, message);
    else this.reportSpan(code, message, at);
    if (this.unclosedLiterals !== mark.unclosedLiterals)
      this.shared.followUps.add(this.diagnostics.at(-1)!);
  }

  public reportInsertion(
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
  ): void {
    const position = this.peek().span.start;
    this.diagnostics.push(
      createDiagnostic(
        DiagnosticSeverity.Error,
        code,
        message,
        createSourceSpan(position, position),
      ),
    );
  }

  public reportToken(
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
    token: Token,
  ): void {
    this.reportSpan(code, message, token.span);
  }

  public reportSpan(
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
    span: SourceSpan,
  ): void {
    this.diagnostics.push(createDiagnostic(DiagnosticSeverity.Error, code, message, span));
  }

  public match(kind: TokenKind): boolean {
    if (!this.check(kind)) return false;
    this.advance();
    return true;
  }

  public check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  /** The span of the word operator `kind` when it comes next, which it consumes, or `null`. */
  #matchOperator(kind: TokenKind): SourceSpan | null {
    return this.match(kind) ? this.previous().span : null;
  }

  /**
   * The TeaseScript word for the word of another language that comes next, as `function` for the `def` of
   * `def countTo(n)` (`FOREIGN_FORMS`). Unless `anyNext`, what follows it on its line must start a value that cannot go
   * on from a name, as in `elif not done`, or be a group with a block after it, as in `elif (done) {`, so that no
   * statement that reads the word as a name, such as `fun += 1` or `elif(done)`, changes.
   */
  public foreignStatementWord(anyNext = false): ForeignForm["statement"] {
    const word = this.peek();
    if (word.kind !== TokenKind.Identifier) return undefined;
    const statement = FOREIGN_FORMS.get(word.lexeme)?.statement;
    if (statement === undefined || anyNext || OPERAND_STARTS.has(this.peek(1).kind))
      return statement;
    if (this.peek(1).kind !== TokenKind.LeftParenthesis) return undefined;
    this.shared.closers ??= delimiterClosers(this.tokens);
    const closer = this.shared.closers.get(this.current + 1);
    return closer !== undefined && this.tokens[closer + 1]?.kind === TokenKind.LeftBrace
      ? statement
      : undefined;
  }

  /** Reports the word of another language that comes next (`foreignStatementWord`). */
  public reportForeignWord(): void {
    const word = this.peek();
    this.reportToken(
      parserDiagnosticCode.foreignForm,
      FOREIGN_FORMS.get(word.lexeme)!.message,
      word,
    );
  }

  /** Skips the group that the opening delimiter next starts, to after its closing one, or else to the end of the line. */
  public skipGroup(): void {
    this.shared.closers ??= delimiterClosers(this.tokens);
    const closer = this.shared.closers.get(this.current);
    if (closer === undefined) this.synchronizeStatement();
    else this.current = closer + 1;
  }

  /** `not`, or `!`, which is reported and read as `not` (V30 §39). */
  public matchNot(): boolean {
    return this.match(TokenKind.KeywordNot) || this.#matchSymbol(TokenKind.Bang, "one") !== null;
  }

  /** `|` or `||` between values: report the word operator and continue as `or` (V30 §5, §39). */
  #matchSymbolicOr(): SourceSpan | null {
    if (!this.check(TokenKind.Pipe)) return null;
    if (this.peek(1).kind === TokenKind.Pipe) return this.#matchSymbol(TokenKind.Pipe, "oneOrTwo");
    const span = this.advance().span;
    this.reportSpan(
      parserDiagnosticCode.foreignForm,
      "Use 'or' to combine conditions. '|' only separates the types of a union, as in 'integer | string'.",
      span,
    );
    return span;
  }

  /**
   * A symbol that other languages use for a word operator, such as `&&` for `and`: reports the word once
   * (`FOREIGN_FORMS`) and returns the symbol's span, so that parsing continues as with the word (V30 §5, §39), or returns
   * `null` when it does not come next. The symbol is one token of `kind`, as `!`, one or two, as `&` or `&&`, or two
   * that touch, as `??`, which is not the `?` of a type.
   */
  #matchSymbol(kind: TokenKind, form: "one" | "oneOrTwo" | "two"): SourceSpan | null {
    const first = this.peek();
    const second = this.peek(1);
    if (first.kind !== kind) return null;
    const touching = second.kind === kind && second.span.start.offset === first.span.end.offset;
    if (form === "two" && !touching) return null;
    this.advance();
    const last = form !== "one" && second.kind === kind ? this.advance() : first;
    const symbol = last === first ? first.lexeme : first.lexeme + last.lexeme;
    const span = spanFrom(first.span, last.span);
    this.reportSpan(parserDiagnosticCode.foreignForm, FOREIGN_FORMS.get(symbol)!.message, span);
    return span;
  }

  /**
   * Whether the expression parser skips a newline after the token at `index`: a binary operator, the comma of a compact
   * choice, or a symbol that it reads as a word operator, such as `&&` or the second `?` of `??`.
   */
  public continuesAfter(index: number): boolean {
    const token = this.tokens[index]!;
    const before = this.tokens[index - 1];
    return (
      continuesExpression(token.kind) ||
      (token.kind === TokenKind.Question &&
        before?.kind === TokenKind.Question &&
        before.span.end.offset === token.span.start.offset)
    );
  }

  public checkIdentifier(name: string): boolean {
    return this.check(TokenKind.Identifier) && this.peek().lexeme === name;
  }

  /** The word of `COMMANDS` that the current identifier is, when the parser reads it here as a statement or a value. */
  #commandAt(form: "statement"): StatementCommand | null;
  #commandAt(form: "value"): ValueCommand | null;
  #commandAt(form: "statement" | "value"): StatementCommand | ValueCommand | null {
    const token = this.peek();
    if (token.kind !== TokenKind.Identifier || !isCommand(token.lexeme)) return null;
    if (commandFacts(token.lexeme)?.[form] === undefined) return null;
    // EVIDENCE: invariant: the word's facts give it the form, which is what each of the two types selects.
    return token.lexeme as StatementCommand | ValueCommand;
  }

  /**
   * Whether a word is where a declaration's name belongs: an identifier, or a keyword, which `#declarationName` reads as
   * the name so that the declaration gets the protected-name diagnostic with its fix.
   */
  public checkDeclarationName(): boolean {
    return isWord(this.peek());
  }

  /**
   * Reads the name of a declaration. A protected name (V30 §38) is an error that names another, as for `let wait = 5`,
   * which gives the name check's diagnostic (TSV001) also here, where the name is read, so it is reported when a later
   * use of the name, such as `${timer}`, cannot be parsed and the name check does not run.
   */
  public declarationName(declaration: "label" | "speaker" | "other"): Identifier {
    const token = this.advance();
    if (PROTECTED_NAMES.has(token.lexeme))
      this.reportToken(
        parserDiagnosticCode.protectedName,
        protectedNameMessage(token.lexeme, declaration),
        token,
      );
    return this.identifier(token);
  }

  public advance(): Token {
    const token = this.peek();
    if (token.kind !== TokenKind.EndOfFile) this.current += 1;
    return token;
  }

  public peek(distance = 0): Token {
    return this.tokens[Math.min(this.current + distance, this.tokens.length - 1)]!;
  }

  public previous(): Token {
    return this.tokens[this.current - 1]!;
  }
}

function isStatementStart(kind: TokenKind): boolean {
  return (
    kind === TokenKind.KeywordSpeaker ||
    kind === TokenKind.KeywordSay ||
    kind === TokenKind.KeywordExit ||
    kind === TokenKind.KeywordLet ||
    kind === TokenKind.KeywordIf ||
    kind === TokenKind.KeywordRepeat ||
    kind === TokenKind.KeywordFor ||
    kind === TokenKind.KeywordWhile ||
    kind === TokenKind.KeywordBreak ||
    kind === TokenKind.KeywordContinue ||
    kind === TokenKind.KeywordFunction ||
    kind === TokenKind.KeywordReturn
  );
}

function isAssignmentTarget(expression: Expression): expression is AssignmentTarget {
  return (
    expression.kind === "identifier" ||
    expression.kind === "propertyAccessExpression" ||
    expression.kind === "indexExpression"
  );
}

/**
 * Tokens after which the expression parser skips newlines: binary operators, the comma of a compact choice, and the
 * symbols it reads as `or`, `and`, and `not`.
 */
function continuesExpression(kind: TokenKind): boolean {
  return (
    isBinaryOperatorKind(kind) ||
    kind === TokenKind.Comma ||
    kind === TokenKind.KeywordNot ||
    kind === TokenKind.Bang
  );
}

/**
 * Whether the token at `index` starts a binary operator, also a symbol that the parser reads as a word operator, such
 * as `&&`, `||`, or `??`. After a value, `-` and `+` subtract and add; `not` and `!` only negate the value after them.
 * A single `|` only separates the types of a union, which the type's own context continues (see `TypeContext`).
 */
function startsBinaryOperator(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index]!;
  const next = tokens[index + 1];
  if (token.kind === TokenKind.Question || token.kind === TokenKind.Pipe)
    return next?.kind === token.kind && next.span.start.offset === token.span.end.offset;
  return isBinaryOperatorKind(token.kind);
}

/** Binary operators, and the symbols `|` and `&` that the parser reads as `or` and `and`. */
function isBinaryOperatorKind(kind: TokenKind): boolean {
  return (
    isComparisonKind(kind) ||
    kind === TokenKind.KeywordIs ||
    kind === TokenKind.KeywordOr ||
    kind === TokenKind.KeywordAnd ||
    kind === TokenKind.KeywordOtherwise ||
    kind === TokenKind.Pipe ||
    kind === TokenKind.Ampersand ||
    kind === TokenKind.RangeExclusive ||
    kind === TokenKind.RangeInclusive ||
    kind === TokenKind.Plus ||
    kind === TokenKind.Minus ||
    kind === TokenKind.Star ||
    kind === TokenKind.Slash ||
    kind === TokenKind.Percent
  );
}

const ARITHMETIC_OPERATORS: ReadonlySet<string> = new Set(["+", "-", "*", "/", "%"]);

/** For each comparison operator, the one that holds exactly when it does not. */
const OPPOSITE_COMPARISONS: Readonly<Record<string, string>> = {
  "==": "!=",
  "!=": "==",
  "<": ">=",
  "<=": ">",
  ">": "<=",
  ">=": "<",
};

/** Arithmetic or a range, which `otherwise` takes as an operand only in parentheses (owner decision on #850). */
function isArithmetic(expression: Expression): expression is BinaryExpression | RangeExpression {
  return (
    expression.kind === "rangeExpression" ||
    (expression.kind === "binaryExpression" && ARITHMETIC_OPERATORS.has(expression.operator))
  );
}

/** An `otherwise` without parentheses, which a comparison, a type test, `not`, `and`, or `or` takes only in them. */
function isOtherwise(expression: Expression): expression is BinaryExpression {
  return expression.kind === "binaryExpression" && expression.operator === "otherwise";
}

/** A sign before a value, as in `-x`, which `otherwise` takes as its left operand only in parentheses. */
function isSign(expression: Expression): expression is UnaryExpression {
  return expression.kind === "unaryExpression" && expression.operator !== "not";
}

function isComparisonKind(kind: TokenKind): boolean {
  return (
    kind === TokenKind.EqualEqual ||
    kind === TokenKind.BangEqual ||
    kind === TokenKind.Less ||
    kind === TokenKind.LessEqual ||
    kind === TokenKind.Greater ||
    kind === TokenKind.GreaterEqual
  );
}

function binaryOperator(token: Token): BinaryExpression["operator"] {
  // EVIDENCE: invariant: precedence parsers call this only after matching a binary-operator token kind.
  return token.lexeme as BinaryExpression["operator"];
}

function tokenValue(token: Token): string {
  return "value" in token ? token.value : "";
}

const CLOSERS: Readonly<Partial<Record<TokenKind, TokenKind>>> = {
  [TokenKind.RightParenthesis]: TokenKind.LeftParenthesis,
  [TokenKind.RightBracket]: TokenKind.LeftBracket,
  [TokenKind.RightBrace]: TokenKind.LeftBrace,
  [TokenKind.InterpolationEnd]: TokenKind.InterpolationStart,
};

function newlineRuns(tokens: readonly Token[]): SharedParse["newlineRuns"] {
  const starts = new Int32Array(tokens.length);
  const ends = new Int32Array(tokens.length);
  const newline = (index: number) => tokens[index]?.kind === TokenKind.Newline;
  for (let index = 0; index < tokens.length; index += 1)
    starts[index] = newline(index) && newline(index - 1) ? starts[index - 1]! : index;
  for (let index = tokens.length - 1; index >= 0; index -= 1)
    ends[index] = !newline(index) ? index : newline(index + 1) ? ends[index + 1]! : index + 1;
  return { starts, ends };
}

function innermostOpeners(tokens: readonly Token[]): (TokenKind | undefined)[] {
  const contexts: (TokenKind | undefined)[] = [];
  const openers: TokenKind[] = [];
  for (const token of tokens) {
    const innermost = openers.at(-1);
    contexts.push(innermost);
    if (
      token.kind === TokenKind.LeftParenthesis ||
      token.kind === TokenKind.LeftBracket ||
      token.kind === TokenKind.LeftBrace ||
      token.kind === TokenKind.InterpolationStart
    )
      openers.push(token.kind);
    else if (CLOSERS[token.kind] !== undefined && innermost === CLOSERS[token.kind]) openers.pop();
  }
  return contexts;
}

/**
 * Whether `value` starts with the say mode or skip word `word` itself and a unit after it: the bare word, or a mode with
 * its named options, as in `bubble(color: "red") s`, also before a `calendar` without a unit (`unitless`). A member, an
 * element, or a call with values stays a value.
 */
function unitAfterWord(value: Expression, word: Token, unitless: WeakSet<Expression>): boolean {
  let node = value;
  for (;;) {
    const operand =
      node.kind === "unitExpression" || node.kind === "angleExpression"
        ? node.operand
        : unitless.has(node)
          ? node
          : undefined;
    if (operand !== undefined) {
      if (operand.span.start.offset !== word.span.start.offset) return false;
      return (
        operand.kind === "identifier" ||
        ((word.lexeme === "bubble" || word.lexeme === "prose") &&
          operand.kind === "callExpression" &&
          operand.callee.kind === "identifier" &&
          operand.arguments.every((argument) => argument.kind === "namedArgument"))
      );
    }
    if (node.kind === "binaryExpression") node = node.left;
    else if (node.kind === "rangeExpression") node = node.start;
    else if (node.kind === "typeTestExpression") node = node.value;
    else return false;
  }
}
