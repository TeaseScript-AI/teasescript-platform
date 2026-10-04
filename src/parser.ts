import { isMessagePresentationOption } from "./message-presentation.js";
import { parseChild, runParse, type ParseTask } from "./parse-continuation.js";
import type {
  AssignmentStatement,
  AssignmentTarget,
  BinaryExpression,
  Block,
  CallArgument,
  CallExpression,
  BreakStatement,
  ContinueStatement,
  Expression,
  ExpressionStatement,
  ForStatement,
  FunctionDeclaration,
  FunctionParameter,
  Identifier,
  IfStatement,
  LetStatement,
  NamedArgument,
  ObjectLiteral,
  ObjectProperty,
  ParenthesizedExpression,
  PositionalArgument,
  Program,
  PropertyAccessExpression,
  SayStatement,
  ShowButtonParts,
  ShowButtonStatement,
  InteractionExpression,
  InteractionChoiceOption,
  WaitStatement,
  TimerStatement,
  TimerParts,
  TimerDisplay,
  HideImageStatement,
  MediaCue,
  MediaHandlers,
  MediaKind,
  MediaParts,
  MediaRepeat,
  PlayMediaStatement,
  DeleteStatement,
  LoadExpression,
  SaveStatement,
  ShowImageStatement,
  DurationUnit,
  ListLiteral,
  NumberLiteral,
  RepeatStatement,
  ReturnStatement,
  SetLiteral,
  SpeakerDeclaration,
  SpeakerProperty,
  SpeakerSetterStatement,
  Statement,
  StringInterpolation,
  StringLiteral,
  StringPart,
  StringText,
  SwitchCase,
  SwitchStatement,
  TypeAnnotation,
  TypeName,
  UnaryExpression,
  WhileStatement,
} from "./ast.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { lex } from "./lexer.js";
import { elapsedDurationUnit, isCalendarDurationUnit } from "./duration.js";
import { createSourcePosition, createSourceSpan, type SourceSpan } from "./source.js";
import { TokenKind, type Token } from "./token.js";

export interface ParseResult {
  readonly program: Program;
  readonly diagnostics: readonly Diagnostic[];
}

// Commands that #parseStatement dispatches by name. A line that starts with one starts a statement; only `showButton`
// also has an expression form, used after `=`, an operator, or an opening delimiter.
const statementOnlyCommands: ReadonlySet<string> = new Set([
  "showButton",
  "showImage",
  "hideImage",
  "save",
  "delete",
  "switch",
]);

const parserDiagnosticCode = {
  expectedStatement: "TSP001",
  expectedStatementEnd: "TSP002",
  expectedSpeakerIdentifier: "TSP003",
  expectedPropertyName: "TSP004",
  expectedColon: "TSP005",
  expectedString: "TSP006",
  expectedRightBrace: "TSP007",
  expectedStringExpression: "TSP008",
  unsupportedStringExpression: "TSP009",
  expectedPropertyAfterDot: "TSP010",
  expectedPropertyEnd: "TSP011",
  expectedExpression: "TSP012",
  expectedIdentifier: "TSP013",
  expectedEqual: "TSP014",
  invalidAssignmentTarget: "TSP015",
  invalidExpressionStatement: "TSP016",
  expectedDelimiter: "TSP017",
  expectedBlock: "TSP018",
  mixedArguments: "TSP019",
  chainedComparison: "TSP020",
  invalidType: "TSP021",
  chainedRange: "TSP022",
  expectedIn: "TSP023",
  expectedFunctionName: "TSP024",
  expectedParameter: "TSP025",
  emptyFunctionParameters: "TSP026",
  expectedInteractionText: "TSP028",
  expectedInteractionSpeaker: "TSP029",
  expectedChoiceOption: "TSP030",
  expectedChoiceSeparator: "TSP031",
  unsupportedInteractionForm: "TSP032",
  unsupportedDurationUnit: "TSP033",
  invalidTimerForm: "TSP034",
  invalidMediaForm: "TSP035",
  expectedStorageKey: "TSP036",
  symbolicOperator: "TSP037",
  invalidSwitchForm: "TSP038",
} as const;

const MEDIA_ARGUMENTS = ["file", "async", "repeat", "startAt", "endAt", "volume"] as const;

/**
 * How a type continues (V30 §1): a statement type ends at a newline; inside `()`, a newline may also precede `|` or
 * a postfix form; and the type of an `is` test also ends before `||`, the rejected symbolic `or` (V30 §5).
 */
type TypeContext = "statement" | "delimited" | "typeTest" | "delimitedTypeTest";

type StorageDelimiter = "as" | "default";
const NO_STORAGE_DELIMITERS: ReadonlySet<StorageDelimiter> = new Set();
const SAVE_VALUE_DELIMITERS: ReadonlySet<StorageDelimiter> = new Set(["as"]);

/** Parses the accepted core-language milestone. */
export function parse(source: string): ParseResult {
  const lexResult = lex(source);
  const parser = new Parser(lexResult.tokens);
  const program = parser.parseProgram();

  return Object.freeze({
    program,
    diagnostics: Object.freeze([...lexResult.diagnostics, ...parser.diagnostics]),
  });
}

class Parser {
  readonly #diagnostics: Diagnostic[] = [];
  #current = 0;
  #commaLookahead: {
    readonly at: number;
    readonly insideDelimiters: boolean;
    readonly offset: number | null;
  } | null = null;
  #recoveredAtStatementBoundary = false;
  /** Inside a media cue position or a switch subject, where the following block `{` ends a compact interaction. */
  #blockEndsCompactInteraction = false;
  /**
   * The `save` `as` that ends an enclosing storage operand, and a bare `default` after a `load` key, the earlier form
   * that `load` reports with its fix. A compact interaction stops at them, and a bare interaction leaves the `as` to
   * `save`; groupings such as parentheses start without them.
   */
  #storageDelimiters: ReadonlySet<StorageDelimiter> = NO_STORAGE_DELIMITERS;
  /** For each token, whether its innermost enclosing opener is `(` or `[`, where a newline may continue a type (V30 §1). */
  readonly #bracketed: readonly boolean[];

  public constructor(
    private readonly tokens: readonly Token[],
    // A speculative parser over the same tokens shares the contexts instead of computing them again.
    bracketed: readonly boolean[] = bracketContexts(tokens),
  ) {
    this.#bracketed = bracketed;
  }

  public get diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  public parseProgram(): Program {
    const statements: Statement[] = [];
    this.#skipNewlines();
    while (!this.#check(TokenKind.EndOfFile)) {
      const startIndex = this.#current;
      const statement = runParse(this.#parseStatement());
      if (statement !== null) statements.push(statement);
      if (this.#current === startIndex) this.#advance();

      if (this.#recoveredAtStatementBoundary) {
        this.#recoveredAtStatementBoundary = false;
      } else {
        this.#finishStatement(false);
      }
      this.#skipNewlines();
    }

    return Object.freeze({
      kind: "program",
      statements: Object.freeze(statements),
      span: createSourceSpan(createSourcePosition(0, 0, 0), this.#peek().span.end),
    });
  }

  *#parseStatement(): ParseTask<Statement | null> {
    if (this.#checkIdentifier("showButton")) {
      return yield* parseChild(this.#parseShowButtonStatement());
    }
    if (this.#checkIdentifier("timer")) {
      return yield* parseChild(this.#parseTimerStatement());
    }
    if (this.#checkIdentifier("showImage")) {
      return this.#parseShowImageStatement();
    }
    if (this.#checkIdentifier("hideImage")) {
      return this.#parseHideImageStatement();
    }
    if (this.#checkIdentifier("save")) {
      return this.#parseSaveStatement();
    }
    if (this.#checkIdentifier("delete")) {
      return this.#parseDeleteStatement();
    }
    if (this.#checkIdentifier("switch")) {
      return yield* parseChild(this.#parseSwitchStatement());
    }
    if (this.#checkIdentifier("playAudio") || this.#checkIdentifier("playVideo")) {
      const parts = yield* parseChild(this.#parseMediaParts());
      return parts === null
        ? null
        : Object.freeze({ kind: "playMediaStatement", ...parts } satisfies PlayMediaStatement);
    }
    if (
      this.#check(TokenKind.KeywordWait) &&
      this.#peek(1).kind === TokenKind.LeftParenthesis &&
      this.#peek(2).kind === TokenKind.RightParenthesis
    ) {
      return this.#parseAssignmentOrExpressionStatement();
    }
    switch (this.#peek().kind) {
      case TokenKind.KeywordSpeaker:
        return this.#parseSpeakerStatement();
      case TokenKind.KeywordSay:
        return this.#parseSayStatement();
      case TokenKind.KeywordWait:
        return this.#parseWaitStatement();
      case TokenKind.KeywordExit:
        return this.#parseExitStatement();
      case TokenKind.KeywordLet:
        return this.#parseLetStatement();
      case TokenKind.KeywordIf:
        return yield* parseChild(this.#parseIfStatement());
      case TokenKind.KeywordRepeat:
        return yield* parseChild(this.#parseRepeatStatement());
      case TokenKind.KeywordFor:
        return yield* parseChild(this.#parseForStatement());
      case TokenKind.KeywordWhile:
        return yield* parseChild(this.#parseWhileStatement());
      case TokenKind.KeywordBreak:
        return this.#parseLoopControl("breakStatement");
      case TokenKind.KeywordContinue:
        return this.#parseLoopControl("continueStatement");
      case TokenKind.KeywordFunction:
        return yield* parseChild(this.#parseFunctionDeclaration());
      case TokenKind.KeywordReturn:
        return this.#parseReturnStatement();
      default:
        if (isExpressionStart(this.#peek())) {
          return this.#parseAssignmentOrExpressionStatement();
        }
        this.#reportToken(
          parserDiagnosticCode.expectedStatement,
          "Expected a supported TeaseScript statement.",
          this.#peek(),
        );
        this.#synchronizeStatement();
        return null;
    }
  }

  *#parseShowButtonStatement(): ParseTask<ShowButtonStatement | null> {
    const parts = yield* parseChild(this.#parseShowButtonParts());
    if (parts === null) return null;
    if (this.#check(TokenKind.Comma)) {
      this.#reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        "showButton accepts only background: and timeout: after the button text.",
        this.#peek().span,
      );
      this.#synchronizeStatement();
    }
    return Object.freeze({ kind: "showButtonStatement", ...parts });
  }

  /**
   * `showButton [as speaker] label [, background: colour] [, timeout: duration]`. A comma that is not followed by one
   * of the two options is left to the enclosing statement, list, call, or object.
   */
  *#parseShowButtonParts(): ParseTask<ShowButtonParts | null> {
    const command = this.#advance();
    if (this.#check(TokenKind.LeftParenthesis)) {
      this.#reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        "Parenthesized showButton arguments are not supported in the compact interaction syntax.",
        this.#peek().span,
      );
      this.#synchronizeStatement();
      return null;
    }
    let asSpan: SourceSpan | null = null;
    let speaker: Identifier | null = null;
    if (!this.#atStorageDelimiter() && this.#match(TokenKind.KeywordAs)) {
      asSpan = copySpan(this.#previous().span);
      if (!this.#check(TokenKind.Identifier)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedInteractionSpeaker,
          "Expected a speaker identifier after 'as'.",
        );
        this.#synchronizeStatement();
        return null;
      }
      speaker = this.#identifier(this.#advance());
    }
    if (this.#check(TokenKind.LeftParenthesis)) {
      this.#reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        "Parenthesized showButton arguments are not supported in the compact interaction syntax.",
        this.#peek().span,
      );
      this.#synchronizeStatement();
      return null;
    }
    const label = yield* parseChild(this.#parseOr());
    if (label === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedInteractionText,
        "Expected button text after 'showButton'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    let background: Expression | null = null;
    let timeout: Expression | null = null;
    for (
      let offset = this.#offsetAfterComma();
      offset !== null;
      offset = this.#offsetAfterComma()
    ) {
      const name = this.#peek(offset);
      const option =
        name.kind === TokenKind.Identifier &&
        (name.lexeme === "background" || name.lexeme === "timeout") &&
        this.#peek(offset + 1).kind === TokenKind.Colon
          ? name.lexeme
          : null;
      if (option === null) break;
      for (let skipped = 0; skipped < offset + 2; skipped += 1) this.#advance();
      const value = yield* parseChild(this.#parseColonValueTask(false));
      if (value === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedInteractionText,
          option === "background"
            ? "Expected a button background colour."
            : "Expected a button timeout, such as timeout: 5 or timeout: 500 ms.",
        );
        // A statement at the start of a continued line is kept, as for choice values.
        if (this.#previous().kind === TokenKind.Newline && this.#atStatementStart())
          this.#recoveredAtStatementBoundary = true;
        return null;
      }
      if ((option === "background" ? background : timeout) !== null) {
        this.#reportSpan(
          parserDiagnosticCode.unsupportedInteractionForm,
          `showButton accepts one ${option}: option.`,
          name.span,
        );
      }
      if (option === "background") background = value;
      else timeout = value;
    }
    if (this.#check(TokenKind.KeywordAs) && !this.#atStorageDelimiter()) {
      this.#reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        "The 'as speaker' clause must appear immediately after 'showButton'.",
        this.#peek().span,
      );
      this.#synchronizeStatement();
    }
    const last = [background, timeout].reduce<Expression>(
      (latest, option) =>
        option !== null && option.span.end.offset > latest.span.end.offset ? option : latest,
      label,
    );
    return {
      commandSpan: copySpan(command.span),
      asSpan,
      speaker,
      label,
      background,
      timeout,
      span: spanFrom(command.span, last.span),
    };
  }

  #parseSpeakerStatement(): SpeakerDeclaration | SpeakerSetterStatement | null {
    const keyword = this.#advance();
    if (!this.#checkDeclarationName()) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedSpeakerIdentifier,
        "Expected a speaker identifier after 'speaker'.",
      );
      if (this.#check(TokenKind.LeftBrace)) this.#skipMalformedBlock();
      else this.#synchronizeStatement();
      return null;
    }

    const name = this.#identifier(this.#advance());
    if (this.#match(TokenKind.LeftBrace)) {
      return this.#parseSpeakerDeclaration(keyword, name);
    }
    return Object.freeze({
      kind: "speakerSetterStatement",
      speaker: name,
      span: spanFrom(keyword.span, name.span),
    });
  }

  #parseSpeakerDeclaration(keyword: Token, name: Identifier): SpeakerDeclaration {
    const leftBrace = this.#previous();
    const properties: SpeakerProperty[] = [];
    let lastSpan = leftBrace.span;

    while (!this.#check(TokenKind.EndOfFile)) {
      this.#skipNewlines();
      if (this.#match(TokenKind.RightBrace)) {
        return this.#speakerDeclaration(keyword, name, properties, this.#previous().span);
      }
      if (this.#isRecoveredTopLevelStatement()) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedRightBrace,
          "Expected '}' to close the speaker declaration.",
        );
        this.#recoveredAtStatementBoundary = true;
        return this.#speakerDeclaration(keyword, name, properties, lastSpan);
      }

      const property = this.#parseSpeakerProperty();
      if (property !== null) {
        properties.push(property);
        lastSpan = property.span;
      }
      if (
        property !== null &&
        !this.#check(TokenKind.Newline) &&
        !this.#check(TokenKind.RightBrace) &&
        !this.#check(TokenKind.EndOfFile)
      ) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedPropertyEnd,
          "Expected a newline or '}' after the speaker property.",
        );
        this.#synchronizeProperty();
      }
    }

    this.#reportInsertion(
      parserDiagnosticCode.expectedRightBrace,
      "Expected '}' to close the speaker declaration.",
    );
    return this.#speakerDeclaration(keyword, name, properties, lastSpan);
  }

  #parseSpeakerProperty(): SpeakerProperty | null {
    if (!isPropertyName(this.#peek())) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedPropertyName,
        "Expected a speaker property name.",
      );
      this.#synchronizeProperty();
      return null;
    }
    const name = this.#identifier(this.#advance());
    if (!this.#match(TokenKind.Colon)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedColon,
        "Expected ':' after the speaker property name.",
      );
      this.#synchronizeProperty();
      return null;
    }
    const value = runParse(this.#parseColonValueTask(false));
    if (value === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedString,
        "Expected a string for the speaker property.",
      );
      // At the start of a continued line, the declaration recovers at the token left there.
      if (this.#previous().kind !== TokenKind.Newline) this.#synchronizeProperty();
      return null;
    }
    return Object.freeze({
      kind: "speakerProperty",
      name,
      value,
      span: spanFrom(name.span, value.span),
    });
  }

  #parseSayStatement(): SayStatement | null {
    const keyword = this.#advance();
    let speaker: Identifier | null = null;
    if (this.#match(TokenKind.KeywordAs)) {
      if (!this.#check(TokenKind.Identifier)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedSpeakerIdentifier,
          "Expected a speaker identifier after 'as'.",
        );
        this.#synchronizeStatement();
        return null;
      }
      speaker = this.#identifier(this.#advance());
    }

    const presentation = this.#parseSayPresentation();

    let skipPolicy: SayStatement["skipPolicy"] = null;
    if (this.#check(TokenKind.Identifier) && !this.#canParseCompleteSayValue()) {
      const policy = this.#peek().lexeme;
      if (policy === "skippable" || policy === "unskippable") {
        skipPolicy = policy;
        this.#advance();
      }
    }

    const valueStart = this.#peek().kind;
    const value = this.#parseExpression();
    if (value === null) {
      if (valueStart === TokenKind.StringStart) {
        this.#synchronizeStatement();
        return null;
      }
      this.#reportInsertion(parserDiagnosticCode.expectedString, "Expected a string after 'say'.");
      this.#synchronizeStatement();
      return null;
    }
    let pacing: SayStatement["pacing"] = null;
    let endSpan = value.span;
    if (this.#match(TokenKind.Comma)) {
      if (this.#canParseInstantPacingAlias()) {
        endSpan = this.#advance().span;
        pacing = "instant";
      } else {
        const parsedPacing = this.#parseExpression();
        if (parsedPacing === null) {
          this.#reportInsertion(
            parserDiagnosticCode.expectedExpression,
            "Expected a pacing value after ','.",
          );
          this.#synchronizeStatement();
          return null;
        }
        pacing = parsedPacing;
        endSpan = parsedPacing.span;
      }
    }
    return Object.freeze({
      kind: "sayStatement",
      presentation,
      speaker,
      skipPolicy,
      value,
      pacing,
      span: spanFrom(keyword.span, endSpan),
    });
  }

  #parseSayPresentation(): ObjectLiteral | null {
    if (
      !this.#check(TokenKind.Identifier) ||
      !["bubble", "prose"].includes(this.#peek().lexeme) ||
      this.#canParseCompleteSayValue()
    )
      return null;
    const mode = this.#advance();
    const properties: ObjectProperty[] = [
      {
        kind: "objectProperty",
        name: { kind: "identifier", name: "kind", span: mode.span },
        value: {
          kind: "stringLiteral",
          form: "singleLine",
          span: mode.span,
          parts: [{ kind: "stringText", raw: mode.lexeme, value: mode.lexeme, span: mode.span }],
        },
        span: mode.span,
      },
    ];
    let endSpan = mode.span;
    if (this.#match(TokenKind.LeftParenthesis)) {
      this.#skipNewlines();
      while (!this.#check(TokenKind.RightParenthesis) && !this.#check(TokenKind.EndOfFile)) {
        if (!isPropertyName(this.#peek())) {
          this.#reportInsertion(
            parserDiagnosticCode.expectedPropertyName,
            "Expected a named presentation option.",
          );
          break;
        }
        const name = this.#identifier(this.#advance());
        if (!isMessagePresentationOption(mode.lexeme === "prose" ? "prose" : "bubble", name.name))
          this.#reportInsertion(
            parserDiagnosticCode.expectedPropertyName,
            `Unknown ${mode.lexeme} presentation option '${name.name}'.`,
          );
        if (properties.some((property) => property.name.name === name.name))
          this.#reportInsertion(
            parserDiagnosticCode.expectedPropertyName,
            `Duplicate presentation option '${name.name}'.`,
          );
        if (!this.#match(TokenKind.Colon)) {
          this.#reportInsertion(
            parserDiagnosticCode.expectedColon,
            "Expected ':' after presentation option.",
          );
          break;
        }
        // Presentation options are a `()` grouping, where a line break does not end a value.
        const value = runParse(this.#withinDelimiters(this.#parseColonValueTask(true)));
        if (value === null) break;
        properties.push({
          kind: "objectProperty",
          name,
          value,
          span: spanFrom(name.span, value.span),
        });
        this.#skipNewlines();
        if (!this.#match(TokenKind.Comma)) break;
        this.#skipNewlines();
      }
      if (this.#match(TokenKind.RightParenthesis)) endSpan = this.#previous().span;
      else
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected ')' after presentation options.",
        );
    }
    return { kind: "objectLiteral", properties, span: spanFrom(mode.span, endSpan) };
  }

  /**
   * `skippable` and `unskippable` predate their modifier meaning as ordinary
   * identifiers. Keep that interpretation whenever the existing say grammar
   * can consume a complete value (and optional pacing) from this position.
   */
  #canParseCompleteSayValue(): boolean {
    const speculative = new Parser(this.tokens, this.#bracketed);
    speculative.#current = this.#current;

    const value = speculative.#parseExpression();
    if (value === null || speculative.#diagnostics.length > 0) return false;

    if (speculative.#match(TokenKind.Comma)) {
      if (speculative.#canParseInstantPacingAlias()) {
        speculative.#advance();
      } else {
        const pacing = speculative.#parseExpression();
        if (pacing === null || speculative.#diagnostics.length > 0) return false;
      }
    }

    return speculative.#isSayStatementBoundary();
  }

  #isSayStatementBoundary(): boolean {
    return (
      this.#check(TokenKind.Newline) ||
      this.#check(TokenKind.RightBrace) ||
      this.#check(TokenKind.EndOfFile)
    );
  }

  /** `instant` remains an identifier unless it fills the entire pacing slot. */
  #canParseInstantPacingAlias(): boolean {
    if (!this.#checkIdentifier("instant")) return false;
    const speculative = new Parser(this.tokens, this.#bracketed);
    speculative.#current = this.#current;
    speculative.#advance();
    return speculative.#isSayStatementBoundary();
  }

  #parseExitStatement(): Statement {
    const keyword = this.#advance();
    return Object.freeze({ kind: "exitStatement", span: copySpan(keyword.span) });
  }

  #parseWaitStatement(): WaitStatement | null {
    const keyword = this.#advance();
    if (
      this.#check(TokenKind.LeftParenthesis) &&
      this.#peek().span.start.offset === keyword.span.end.offset
    ) {
      this.#reportToken(
        parserDiagnosticCode.expectedExpression,
        "Wait uses command syntax; write 'wait 1' rather than 'wait(1)'.",
        this.#peek(),
      );
      this.#synchronizeStatement();
      return null;
    }
    const duration = this.#parseExpression();
    if (duration === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected a duration after 'wait'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const unit = this.#parseTrailingDurationUnit("wait");
    return Object.freeze({
      kind: "waitStatement",
      duration,
      unit,
      span: spanFrom(keyword.span, duration.span),
    });
  }

  *#parseTimerStatement(): ParseTask<TimerStatement | null> {
    const parts = yield* parseChild(this.#parseTimerParts());
    return parts === null ? null : Object.freeze({ kind: "timerStatement", ...parts });
  }

  /**
   * Parses `timer [async] [visible|mystery|hidden] <duration> [unit] ["label"] [{ ... }]` or
   * `timer(name: value, ...) [{ ... }]`. The modifiers are contextual words directly after `timer`.
   */
  *#parseTimerParts(): ParseTask<TimerParts | null> {
    const command = this.#advance();
    if (
      this.#check(TokenKind.LeftParenthesis) &&
      this.#peek().span.start.offset === command.span.end.offset
    ) {
      return yield* parseChild(this.#withinDelimiters(this.#parseNamedTimer(command)));
    }
    const async = this.#checkIdentifier("async");
    if (async) this.#advance();
    let display: TimerDisplay | null = null;
    for (const candidate of ["visible", "mystery", "hidden"] as const) {
      if (this.#checkIdentifier(candidate)) {
        this.#advance();
        display = candidate;
        break;
      }
    }
    let duration = this.#parseExpression();
    if (duration === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected a timer duration such as '10', '30 s', or '5..10' after 'timer'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    let end = duration.span;
    let unit: DurationUnit | null;
    // In `timer 5..10 s` the unit belongs to the whole range, not only to its end bound.
    if (duration.kind === "rangeExpression" && duration.end.kind === "durationLiteral") {
      unit = duration.end.unit;
      end = duration.end.span;
      duration = Object.freeze({
        ...duration,
        end: duration.end.amount,
        span: spanFrom(duration.start.span, duration.end.amount.span),
      });
    } else {
      unit = this.#parseTrailingDurationUnit("timer");
      if (unit !== null) end = this.#previous().span;
    }
    let label: Expression | null = null;
    if (this.#match(TokenKind.StringStart)) {
      label = yield* parseChild(this.#parseStringLiteral(this.#previous()));
      if (label === null) return null;
      end = label.span;
    }
    const handler = yield* parseChild(this.#parseTimerHandler());
    if (handler === false) return null;
    return {
      form: "short",
      async,
      display,
      duration,
      unit,
      label,
      repeat: false,
      persist: false,
      handler,
      commandSpan: copySpan(command.span),
      span: spanFrom(command.span, handler?.span ?? end),
    };
  }

  *#parseNamedTimer(command: Token): ParseTask<TimerParts | null> {
    const call = yield* parseChild(this.#finishCall(this.#identifier(command), this.#advance()));
    let duration: Expression | null = null;
    let display: Expression | null = null;
    let label: Expression | null = null;
    const flags = { async: false, repeat: false, persist: false };
    let valid = true;
    const seen = new Set<string>();
    for (const argument of call.arguments) {
      if (argument.kind !== "namedArgument") {
        this.#reportSpan(
          parserDiagnosticCode.invalidTimerForm,
          "The parenthesized timer form uses named arguments, such as 'timer(duration: 10 s)'.",
          argument.span,
        );
        valid = false;
        continue;
      }
      const name = argument.name.name;
      if (seen.has(name)) {
        this.#reportSpan(
          parserDiagnosticCode.invalidTimerForm,
          `Duplicate timer argument '${name}'.`,
          argument.name.span,
        );
        valid = false;
        continue;
      }
      seen.add(name);
      switch (name) {
        case "duration":
          duration = argument.value;
          break;
        case "display":
          display = argument.value;
          break;
        case "label":
          label = argument.value;
          break;
        case "async":
        case "repeat":
        case "persist":
          if (argument.value.kind !== "booleanLiteral") {
            this.#reportSpan(
              parserDiagnosticCode.invalidTimerForm,
              `Timer argument '${name}' must be the literal true or false.`,
              argument.value.span,
            );
            valid = false;
          } else {
            flags[name] = argument.value.value;
          }
          break;
        default:
          this.#reportSpan(
            parserDiagnosticCode.invalidTimerForm,
            `Unknown timer argument '${name}'; use duration, async, display, label, repeat, or persist.`,
            argument.name.span,
          );
          valid = false;
      }
    }
    if (duration === null && valid) {
      this.#reportSpan(
        parserDiagnosticCode.invalidTimerForm,
        "The parenthesized timer form requires a 'duration' argument.",
        call.span,
      );
    }
    const handler = yield* parseChild(this.#parseTimerHandler());
    if (handler === false || duration === null || !valid) return null;
    return {
      form: "named",
      async: flags.async,
      display,
      duration,
      unit: null,
      label,
      repeat: flags.repeat,
      persist: flags.persist,
      handler,
      commandSpan: copySpan(command.span),
      span: spanFrom(command.span, handler?.span ?? call.span),
    };
  }

  /** Parses an optional expiry block on the same line; `false` reports an already diagnosed failure. */
  *#parseTimerHandler(): ParseTask<Block | null | false> {
    if (!this.#check(TokenKind.LeftBrace)) return null;
    const block = yield* parseChild(this.#parseBlock());
    return block ?? false;
  }

  /** `showImage <file>` uses command syntax; the V30 parenthesized layered-image form is not supported. */
  #parseShowImageStatement(): ShowImageStatement | null {
    const command = this.#advance();
    if (
      this.#rejectAdjacentParenthesis(
        command,
        "showImage uses command syntax, such as 'showImage \"room.jpg\"'.",
      )
    )
      return null;
    const image = this.#parseExpression();
    if (image === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected an image file or null after 'showImage'.",
      );
      this.#synchronizeStatement(true);
      return null;
    }
    return Object.freeze({
      kind: "showImageStatement",
      image,
      span: spanFrom(command.span, image.span),
    });
  }

  /** `save <value> as <key>`; both operands are full expressions. */
  #parseSaveStatement(): SaveStatement | null {
    const command = this.#advance();
    const value = this.#parseStorageOperand(SAVE_VALUE_DELIMITERS);
    if (value === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected a value to save after 'save'.",
      );
      this.#synchronizeStatement(true);
      return null;
    }
    if (!this.#match(TokenKind.KeywordAs)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedStorageKey,
        "Expected 'as' and a storage key, such as 'save score as \"player.score\"'.",
      );
      this.#synchronizeStatement(true);
      return null;
    }
    const key = this.#parseStorageOperand(NO_STORAGE_DELIMITERS);
    if (key === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedStorageKey,
        "Expected a storage key after 'as'.",
      );
      this.#synchronizeStatement(true);
      return null;
    }
    return Object.freeze({
      kind: "saveStatement",
      value,
      key,
      span: spanFrom(command.span, key.span),
    });
  }

  #parseDeleteStatement(): DeleteStatement | null {
    const command = this.#advance();
    const key = this.#parseStorageOperand(NO_STORAGE_DELIMITERS);
    if (key === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedStorageKey,
        "Expected a storage key after 'delete'.",
      );
      this.#synchronizeStatement(true);
      return null;
    }
    return Object.freeze({ kind: "deleteStatement", key, span: spanFrom(command.span, key.span) });
  }

  /**
   * `load <key>[, default: <value>]`; both operands are full expressions, so `(load "k") == null` needs parentheses.
   * Like the default answer of an ask, the `, default:` binds to the nearest `load` before it. The default is
   * evaluated only when the key is absent.
   */
  *#parseLoadExpression(): ParseTask<LoadExpression | null> {
    const command = this.#advance();
    // The key ends at a bare `default`, the earlier fallback form, so that the message below names the fix.
    const enclosing = this.#storageDelimiters;
    this.#storageDelimiters = new Set([...enclosing, "default"]);
    const key = yield* parseChild(this.#parseOr());
    this.#storageDelimiters = enclosing;
    if (key === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedStorageKey,
        "Expected a storage key after 'load'.",
      );
      return null;
    }
    let defaultOffset = this.#offsetAfterComma();
    if (defaultOffset === null && this.#checkIdentifier("default")) {
      // The removed V30 form `load "k" default v`, or a missing comma before `default:`.
      this.#reportToken(
        parserDiagnosticCode.expectedDelimiter,
        "Write a fallback for load as 'load key, default: value', with a comma and a colon.",
        this.#peek(),
      );
      // Recover with the fallback as written, so the rest of the statement parses normally.
      defaultOffset = this.#peek(1).kind === TokenKind.Colon ? 0 : -1;
    }
    let defaultValue: Expression | null = null;
    if (defaultOffset === -1) {
      this.#advance();
      defaultValue = yield* parseChild(this.#parseOr());
    } else if (defaultOffset !== null && this.#atInteractionDefault(defaultOffset)) {
      for (let skipped = 0; skipped < defaultOffset + 2; skipped += 1) this.#advance();
      defaultValue = yield* parseChild(this.#parseColonValueTask(false));
      if (defaultValue === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected a fallback value after 'default:'.",
        );
        if (this.#previous().kind === TokenKind.Newline && this.#atStatementStart())
          this.#recoveredAtStatementBoundary = true;
      }
    }
    return Object.freeze({
      kind: "loadExpression",
      key,
      defaultValue,
      span: spanFrom(command.span, (defaultValue ?? key).span),
    });
  }

  #parseHideImageStatement(): HideImageStatement | null {
    const command = this.#advance();
    if (
      this.#rejectAdjacentParenthesis(command, "hideImage takes no arguments; write 'hideImage'.")
    )
      return null;
    return Object.freeze({ kind: "hideImageStatement", span: copySpan(command.span) });
  }

  /**
   * Reports and skips a parenthesized group written directly after a command that uses command syntax. Recovery stops at
   * the end of the line, so an enclosing block keeps its closing brace.
   */
  #rejectAdjacentParenthesis(command: Token, message: string): boolean {
    if (
      !this.#check(TokenKind.LeftParenthesis) ||
      this.#peek().span.start.offset !== command.span.end.offset
    )
      return false;
    this.#reportToken(parserDiagnosticCode.invalidMediaForm, message, this.#peek());
    let depth = 0;
    while (!this.#check(TokenKind.Newline) && !this.#check(TokenKind.EndOfFile)) {
      const token = this.#advance();
      if (token.kind === TokenKind.LeftParenthesis) depth += 1;
      else if (token.kind === TokenKind.RightParenthesis && --depth === 0) break;
    }
    return true;
  }

  /**
   * Parses `playAudio|playVideo [async] [repeat] <file> [{ ... }]` or `playAudio|playVideo(name: value, ...) [{ ... }]`.
   * `async` and `repeat` are recognized only directly after the command; `playAudio (async)` uses a variable.
   */
  *#parseMediaParts(): ParseTask<MediaParts | null> {
    const command = this.#advance();
    const media: MediaKind = command.lexeme === "playAudio" ? "audio" : "video";
    if (
      this.#check(TokenKind.LeftParenthesis) &&
      this.#peek().span.start.offset === command.span.end.offset
    ) {
      return yield* parseChild(this.#withinDelimiters(this.#parseNamedMedia(command, media)));
    }
    const async = this.#checkIdentifier("async");
    if (async) this.#advance();
    let repeat: MediaRepeat | null = null;
    if (this.#check(TokenKind.KeywordRepeat)) {
      repeat = Object.freeze({ kind: "indefinite", span: copySpan(this.#advance().span) });
    }
    const file = yield* parseChild(this.#parseOr());
    if (file === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedExpression,
        `Expected a media file such as "sounds/bell.mp3" after '${command.lexeme}'.`,
      );
      this.#synchronizeStatement(true);
      return null;
    }
    const handlers = yield* parseChild(this.#parseMediaHandlers());
    if (handlers === false) return null;
    return {
      media,
      form: "short",
      async,
      file,
      repeat,
      startAt: null,
      endAt: null,
      volume: null,
      handlers,
      commandSpan: copySpan(command.span),
      span: spanFrom(command.span, handlers === null ? file.span : mediaHandlersSpan(handlers)),
    };
  }

  /** The named form; `repeat:` also accepts `<count> times`. */
  *#parseNamedMedia(command: Token, media: MediaKind): ParseTask<MediaParts | null> {
    const left = this.#advance();
    const values: Partial<Record<(typeof MEDIA_ARGUMENTS)[number], Expression>> = {};
    let repeat: MediaRepeat | null = null;
    let async = false;
    let valid = true;
    this.#skipNewlines();
    while (!this.#check(TokenKind.RightParenthesis) && !this.#check(TokenKind.EndOfFile)) {
      if (!isPropertyName(this.#peek()) || this.#peek(1).kind !== TokenKind.Colon) {
        const value = yield* parseChild(this.#parseRequiredExpressionTask());
        this.#reportSpan(
          parserDiagnosticCode.invalidMediaForm,
          `The parenthesized ${command.lexeme} form uses named arguments, such as '${command.lexeme}(file: "${media === "audio" ? "sounds/bell.mp3" : "videos/intro.mp4"}")'.`,
          value?.span ?? this.#peek().span,
        );
        valid = false;
        if (value === null) break;
      } else {
        const name = this.#identifier(this.#advance());
        this.#advance();
        const value = yield* parseChild(this.#parseColonValueTask(true));
        if (value === null) {
          valid = false;
          break;
        }
        const argument = MEDIA_ARGUMENTS.find((candidate) => candidate === name.name);
        if (argument === undefined) {
          this.#reportSpan(
            parserDiagnosticCode.invalidMediaForm,
            `Unknown ${command.lexeme} argument '${name.name}'; use ${MEDIA_ARGUMENTS.join(", ")}.`,
            name.span,
          );
          valid = false;
        } else if (Object.hasOwn(values, name.name)) {
          this.#reportSpan(
            parserDiagnosticCode.invalidMediaForm,
            `Duplicate ${command.lexeme} argument '${name.name}'.`,
            name.span,
          );
          valid = false;
        } else {
          values[argument] = value;
        }
        if (name.name === "async") {
          if (value.kind !== "booleanLiteral") {
            this.#reportSpan(
              parserDiagnosticCode.invalidMediaForm,
              `${command.lexeme} argument 'async' must be the literal true or false.`,
              value.span,
            );
            valid = false;
          } else {
            async = value.value;
          }
        }
        if (name.name === "repeat") {
          if (this.#checkIdentifier("times")) {
            const times = this.#advance();
            repeat = Object.freeze({
              kind: "times",
              count: value,
              span: spanFrom(value.span, times.span),
            });
          } else {
            repeat = Object.freeze({ kind: "value", value, span: copySpan(value.span) });
          }
        }
      }
      this.#skipNewlines();
      if (!this.#match(TokenKind.Comma)) break;
      this.#skipNewlines();
      if (this.#check(TokenKind.RightParenthesis)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an argument after ','.",
        );
        valid = false;
        break;
      }
    }
    if (!this.#match(TokenKind.RightParenthesis)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedDelimiter,
        `Expected ')' after the ${command.lexeme} arguments.`,
      );
      this.#synchronizeStatement(true);
      return null;
    }
    const right = this.#previous();
    const file = values.file ?? null;
    if (file === null && valid) {
      this.#reportSpan(
        parserDiagnosticCode.invalidMediaForm,
        `The parenthesized ${command.lexeme} form requires a 'file' argument.`,
        spanFrom(left.span, right.span),
      );
    }
    const handlers = yield* parseChild(this.#parseMediaHandlers());
    if (handlers === false || file === null || !valid) return null;
    return {
      media,
      form: "named",
      async,
      file,
      repeat,
      startAt: values.startAt ?? null,
      endAt: values.endAt ?? null,
      volume: values.volume ?? null,
      handlers,
      commandSpan: copySpan(command.span),
      span: spanFrom(command.span, handlers === null ? right.span : mediaHandlersSpan(handlers)),
    };
  }

  /**
   * An optional block on the same line. Its top level holds either ordinary statements (a compact block) or cue
   * declarations; `false` reports an already diagnosed failure.
   */
  *#parseMediaHandlers(): ParseTask<MediaHandlers | null | false> {
    if (!this.#check(TokenKind.LeftBrace)) return null;
    return yield* parseChild(this.#asStatements(this.#parseMediaHandlerBlock()));
  }

  *#parseMediaHandlerBlock(): ParseTask<MediaHandlers | false> {
    const leftBrace = this.#advance();
    this.#skipNewlines();
    const cueMode = this.#isMediaCueStart();
    const statements: Statement[] = [];
    const cues: MediaCue[] = [];
    while (!this.#check(TokenKind.RightBrace) && !this.#check(TokenKind.EndOfFile)) {
      const startIndex = this.#current;
      const cueStart = this.#isMediaCueStart();
      if (cueStart !== cueMode) {
        this.#reportToken(
          parserDiagnosticCode.invalidMediaForm,
          "A media block holds either cue declarations (at, beforeEnd, finish) or ordinary statements, not both.",
          this.#peek(),
        );
      }
      if (cueStart) {
        const cue = yield* parseChild(this.#parseMediaCue());
        if (cue !== null) cues.push(cue);
      } else {
        const statement = yield* parseChild(this.#parseStatement());
        if (statement !== null) statements.push(statement);
      }
      if (this.#current === startIndex) this.#advance();
      if (this.#recoveredAtStatementBoundary) {
        this.#recoveredAtStatementBoundary = false;
      } else {
        this.#finishStatement(true);
      }
      this.#skipNewlines();
    }
    if (!this.#match(TokenKind.RightBrace)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedRightBrace,
        "Expected '}' to close the block.",
      );
      return false;
    }
    const span = spanFrom(leftBrace.span, this.#previous().span);
    return cueMode
      ? Object.freeze({ kind: "cues", cues: Object.freeze(cues), span })
      : Object.freeze({
          kind: "compact",
          body: Object.freeze({ kind: "block", statements: Object.freeze(statements), span }),
        });
  }

  /**
   * `at` and `beforeEnd` followed by a cue position and `{`, and `finish` followed by `{`, start a cue declaration. The
   * position may continue across lines like any expression, and a leading `{` belongs to an object-literal position. A
   * call or index written directly after the word, and logical lines without a top-level `{` or with a top-level
   * assignment, such as `at (1)` or `beforeEnd [1] = 2`, stay ordinary statements. The scan is linear in the line and
   * never reparses a cue position.
   */
  #isMediaCueStart(): boolean {
    const token = this.#peek();
    if (token.kind !== TokenKind.Identifier) return false;
    const next = this.#peek(1);
    if (token.lexeme === "finish") return next.kind === TokenKind.LeftBrace;
    if (token.lexeme !== "at" && token.lexeme !== "beforeEnd") return false;
    if (!isExpressionStart(next)) return false;
    if (
      next.span.start.offset === token.span.end.offset &&
      (next.kind === TokenKind.LeftParenthesis || next.kind === TokenKind.LeftBracket)
    )
      return false;
    let depth = 0;
    let previous: TokenKind = token.kind;
    for (let index = this.#current + 1; index < this.tokens.length; index += 1) {
      const kind = this.tokens[index]!.kind;
      if (kind === TokenKind.EndOfFile) return false;
      if (kind === TokenKind.Newline && continuesExpression(previous)) continue;
      previous = kind;
      if (depth === 0) {
        if (kind === TokenKind.LeftBrace && index > this.#current + 1) return true;
        if (
          kind === TokenKind.Newline ||
          kind === TokenKind.RightBrace ||
          kind === TokenKind.Equal ||
          kind === TokenKind.PlusEqual ||
          kind === TokenKind.MinusEqual
        )
          return false;
      }
      if (
        kind === TokenKind.LeftParenthesis ||
        kind === TokenKind.LeftBracket ||
        kind === TokenKind.LeftBrace ||
        kind === TokenKind.InterpolationStart
      ) {
        depth += 1;
      } else if (
        kind === TokenKind.RightParenthesis ||
        kind === TokenKind.RightBracket ||
        kind === TokenKind.RightBrace ||
        kind === TokenKind.InterpolationEnd
      ) {
        depth = Math.max(0, depth - 1);
      }
    }
    return false;
  }

  *#parseMediaCue(): ParseTask<MediaCue | null> {
    const keyword = this.#advance();
    const kind: MediaCue["kind"] =
      keyword.lexeme === "at" ? "at" : keyword.lexeme === "beforeEnd" ? "beforeEnd" : "finish";
    let offset: Expression | null = null;
    if (kind !== "finish") {
      const enclosing = this.#blockEndsCompactInteraction;
      this.#blockEndsCompactInteraction = true;
      offset = yield* parseChild(this.#parseOr());
      this.#blockEndsCompactInteraction = enclosing;
      if (offset === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          `Expected a cue position such as '30 s' after '${keyword.lexeme}'.`,
        );
        this.#synchronizeStatement(true);
        return null;
      }
    }
    if (!this.#check(TokenKind.LeftBrace)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedBlock,
        `Expected '{' to start the ${keyword.lexeme} cue block.`,
      );
      this.#synchronizeStatement(true);
      return null;
    }
    const body = yield* parseChild(this.#parseBlock());
    if (body === null) return null;
    return Object.freeze({
      kind,
      offset,
      body,
      keywordSpan: copySpan(keyword.span),
      span: spanFrom(keyword.span, body.span),
    });
  }

  /** A trailing `ms`, `s`, `min`, or `h` after a `wait` or short `timer` duration expression. */
  #parseTrailingDurationUnit(command: "wait" | "timer"): DurationUnit | null {
    if (!this.#check(TokenKind.Identifier)) return null;
    const token = this.#advance();
    const unit = elapsedDurationUnit(token.lexeme);
    if (unit !== undefined) return unit;
    this.#reportToken(
      isCalendarDurationUnit(token.lexeme)
        ? parserDiagnosticCode.unsupportedDurationUnit
        : parserDiagnosticCode.expectedStatementEnd,
      `Expected ${command} unit 'ms', 's', 'min', or 'h' (or their long forms).`,
      token,
    );
    return null;
  }

  #parseLetStatement(): LetStatement | null {
    const keyword = this.#advance();
    if (!this.#checkDeclarationName()) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedIdentifier,
        "Expected a variable identifier after 'let'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const name = this.#identifier(this.#advance());
    let typeAnnotation: TypeAnnotation | null = null;
    if (this.#match(TokenKind.Colon)) {
      typeAnnotation = this.#parseTypeAnnotation();
      if (typeAnnotation === null) {
        this.#synchronizeStatement();
        return null;
      }
    }
    if (!this.#match(TokenKind.Equal)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedEqual,
        "Expected '=' in the variable declaration.",
      );
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const initializer = this.#parseRequiredExpression();
    if (initializer === null) {
      this.#synchronizeStatement();
      return null;
    }
    return Object.freeze({
      kind: "letStatement",
      name,
      typeAnnotation,
      initializer,
      span: spanFrom(keyword.span, initializer.span),
    });
  }

  #parseTypeAnnotation(context: TypeContext = "statement"): TypeAnnotation | null {
    return runParse(this.#parseTypeTask(context));
  }

  /** A type: postfix types separated by `|` (ADR 0021). A newline may always follow `|` or `(`. */
  *#parseTypeTask(context: TypeContext): ParseTask<TypeAnnotation | null> {
    const members: TypeAnnotation[] = [];
    do {
      if (members.length > 0) this.#skipContinuationNewlines();
      const member = yield* parseChild(this.#parsePostfixTypeTask(context));
      if (member === null) return null;
      members.push(member);
    } while (this.#matchTypeOperator(TokenKind.Pipe, context));
    if (members.length === 1) return members[0]!;
    return Object.freeze({
      kind: "unionType",
      members: Object.freeze(members),
      span: spanFrom(members[0]!.span, members.at(-1)!.span),
    });
  }

  /** A type name or a parenthesized type, followed by any number of `[]`, `set`, and `?` in source order. */
  *#parsePostfixTypeTask(context: TypeContext): ParseTask<TypeAnnotation | null> {
    const first = this.#peek();
    let type: TypeAnnotation;
    if (this.#match(TokenKind.LeftParenthesis)) {
      this.#skipContinuationNewlines();
      const inner = yield* parseChild(this.#parseTypeTask("delimited"));
      if (inner === null) return null;
      this.#skipContinuationNewlines();
      if (!this.#match(TokenKind.RightParenthesis)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedDelimiter,
          "Expected ')' after the grouped type.",
        );
        return null;
      }
      type = inner;
    } else {
      const name = typeName(first);
      if (name === undefined) {
        this.#reportToken(
          parserDiagnosticCode.invalidType,
          first.kind === TokenKind.Identifier
            ? `'${first.lexeme}' is not a type. Use a type such as string, integer, number, boolean, duration, or a list type such as string[].`
            : "Expected a type such as string, integer, number, boolean, duration, or a list type such as string[].",
          first,
        );
        return null;
      }
      this.#advance();
      type = Object.freeze({ kind: "namedType", name, span: first.span });
    }
    for (;;) {
      if (this.#matchTypeOperator(TokenKind.LeftBracket, context)) {
        if (!this.#match(TokenKind.RightBracket)) {
          this.#reportInsertion(
            parserDiagnosticCode.expectedDelimiter,
            "Expected ']' in the list type.",
          );
          return null;
        }
        type = Object.freeze({
          kind: "listType",
          element: type,
          span: spanFrom(first.span, this.#previous().span),
        });
      } else if (this.#matchTypeOperator(TokenKind.KeywordSet, context)) {
        type = Object.freeze({
          kind: "setType",
          element: type,
          span: spanFrom(first.span, this.#previous().span),
        });
      } else if (this.#matchTypeOperator(TokenKind.Question, context)) {
        type = Object.freeze({
          kind: "optionalType",
          value: type,
          span: spanFrom(first.span, this.#previous().span),
        });
      } else {
        return type;
      }
    }
  }

  /** Matches `|` or a postfix type operator where the type's `context` lets it continue the type. */
  #matchTypeOperator(kind: TokenKind, context: TypeContext): boolean {
    let offset = 0;
    if (context === "delimited" || context === "delimitedTypeTest") {
      while (this.#peek(offset).kind === TokenKind.Newline) offset += 1;
    }
    if (this.#peek(offset).kind !== kind) return false;
    if (
      (context === "typeTest" || context === "delimitedTypeTest") &&
      kind === TokenKind.Pipe &&
      this.#peek(offset + 1).kind === TokenKind.Pipe
    ) {
      return false;
    }
    this.#skipContinuationNewlines();
    this.#advance();
    return true;
  }

  *#parseIfStatement(): ParseTask<IfStatement | null> {
    const keyword = this.#advance();
    const condition = this.#parseRequiredExpression();
    if (condition === null) {
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const thenBlock = yield* parseChild(this.#parseBlock());
    if (thenBlock === null) return null;

    const beforePotentialElse = this.#current;
    this.#skipNewlines();
    let elseBlock: Block | IfStatement | null = null;
    if (this.#match(TokenKind.KeywordElse)) {
      this.#skipContinuationNewlines();
      elseBlock = this.#check(TokenKind.KeywordIf)
        ? yield* parseChild(this.#parseIfStatement())
        : yield* parseChild(this.#parseBlock());
      if (elseBlock === null) return null;
    } else {
      this.#current = beforePotentialElse;
    }
    return Object.freeze({
      kind: "ifStatement",
      condition,
      thenBlock,
      elseBlock,
      span: spanFrom(keyword.span, (elseBlock ?? thenBlock).span),
    });
  }

  *#parseSwitchStatement(): ParseTask<SwitchStatement | null> {
    const keyword = this.#advance();
    if (this.#check(TokenKind.LeftBrace)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected the value to switch on, as in 'switch answer { ... }'.",
      );
      this.#skipMalformedBlock();
      return null;
    }
    const enclosingBlockEndsInteraction = this.#blockEndsCompactInteraction;
    this.#blockEndsCompactInteraction = true;
    const subject = this.#parseRequiredExpression();
    this.#blockEndsCompactInteraction = enclosingBlockEndsInteraction;
    if (subject === null) {
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    if (!this.#match(TokenKind.LeftBrace)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedBlock,
        "Expected '{' to start the switch cases.",
      );
      // Clauses that follow show that only the `{` is missing, so the switch still owns its closing `}`.
      if (!this.#checkIdentifier("case") && !this.#checkIdentifier("default")) return null;
    }
    const cases: SwitchCase[] = [];
    let defaultBlock: Block | null = null;
    /** After a clause without a block, the rest of its line is already diagnosed. */
    let recovering = false;
    this.#skipNewlines();
    while (!this.#check(TokenKind.RightBrace) && !this.#check(TokenKind.EndOfFile)) {
      const clause = this.#peek();
      const wasRecovering = recovering;
      recovering = false;
      if (this.#checkIdentifier("case")) {
        this.#advance();
        if (defaultBlock !== null) {
          this.#reportToken(
            parserDiagnosticCode.invalidSwitchForm,
            "A 'case' may not follow 'default'. Move 'default' after the last case.",
            clause,
          );
        }
        const values = this.#parseCaseValues();
        if (values === null) {
          this.#synchronizeSwitchClause();
        } else {
          this.#skipContinuationNewlines();
          const body = yield* parseChild(this.#parseBlock());
          if (body === null) {
            // A block that reached the end of the source cannot recover; a missing `{` leaves the next clause intact.
            if (this.#check(TokenKind.EndOfFile)) return null;
            recovering = true;
          } else {
            cases.push(
              Object.freeze({
                kind: "switchCase",
                values,
                body,
                span: spanFrom(clause.span, body.span),
              }),
            );
          }
        }
      } else if (this.#checkIdentifier("default")) {
        this.#advance();
        this.#skipContinuationNewlines();
        const body = yield* parseChild(this.#parseBlock());
        if (body === null) {
          if (this.#check(TokenKind.EndOfFile)) return null;
          recovering = true;
        } else if (defaultBlock === null) {
          defaultBlock = body;
        } else {
          this.#reportToken(
            parserDiagnosticCode.invalidSwitchForm,
            "A switch has only one 'default'. Remove this one or merge the two blocks.",
            clause,
          );
        }
      } else {
        if (!wasRecovering) {
          this.#reportToken(
            parserDiagnosticCode.invalidSwitchForm,
            "Expected 'case' or 'default'. Every statement in a switch belongs inside a case block.",
            clause,
          );
        }
        this.#synchronizeSwitchClause();
      }
      this.#skipNewlines();
    }
    if (!this.#match(TokenKind.RightBrace)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedRightBrace,
        "Expected '}' to close the switch.",
      );
      return null;
    }
    return Object.freeze({
      kind: "switchStatement",
      subject,
      cases: Object.freeze(cases),
      defaultBlock,
      span: spanFrom(keyword.span, this.#previous().span),
    });
  }

  /** Parses the comma-separated values after `case`; their kinds are checked semantically. */
  #parseCaseValues(): readonly Expression[] | null {
    const values: Expression[] = [];
    do {
      this.#skipContinuationNewlines();
      if (this.#check(TokenKind.LeftBrace)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected a value after 'case', as in 'case \"open\" { ... }'.",
        );
        return null;
      }
      const value = this.#parseRequiredExpression();
      if (value === null) return null;
      values.push(value);
    } while (this.#match(TokenKind.Comma));
    return Object.freeze(values);
  }

  /** Skips a malformed switch clause up to the next line, including a block that starts on it. */
  #synchronizeSwitchClause(): void {
    while (
      !this.#check(TokenKind.Newline) &&
      !this.#check(TokenKind.RightBrace) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      if (this.#check(TokenKind.LeftBrace)) {
        this.#skipMalformedBlock();
        return;
      }
      this.#advance();
    }
  }

  *#parseRepeatStatement(): ParseTask<RepeatStatement | null> {
    const keyword = this.#advance();
    const count = this.#parseRequiredExpression();
    if (count === null) {
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const body = yield* parseChild(this.#parseBlock());
    if (body === null) return null;
    return Object.freeze({
      kind: "repeatStatement",
      count,
      body,
      span: spanFrom(keyword.span, body.span),
    });
  }

  *#parseForStatement(): ParseTask<ForStatement | null> {
    const keyword = this.#advance();
    if (!this.#checkDeclarationName()) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedIdentifier,
        "Expected a loop-variable identifier after 'for'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const variable = this.#identifier(this.#advance());
    if (!this.#match(TokenKind.KeywordIn)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedIn,
        "Expected 'in' after the loop variable.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const iterable = this.#parseRequiredExpression();
    if (iterable === null) {
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const body = yield* parseChild(this.#parseBlock());
    if (body === null) return null;
    return Object.freeze({
      kind: "forStatement",
      variable,
      iterable,
      body,
      span: spanFrom(keyword.span, body.span),
    });
  }

  *#parseWhileStatement(): ParseTask<WhileStatement | null> {
    const keyword = this.#advance();
    const condition = this.#parseRequiredExpression();
    if (condition === null) {
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const body = yield* parseChild(this.#parseBlock());
    if (body === null) return null;
    return Object.freeze({
      kind: "whileStatement",
      condition,
      body,
      span: spanFrom(keyword.span, body.span),
    });
  }

  #parseLoopControl(
    kind: "breakStatement" | "continueStatement",
  ): BreakStatement | ContinueStatement {
    const keyword = this.#advance();
    return Object.freeze({ kind, span: copySpan(keyword.span) });
  }

  *#parseFunctionDeclaration(): ParseTask<FunctionDeclaration | null> {
    const keyword = this.#advance();
    if (!this.#checkDeclarationName() && !this.#check(TokenKind.KeywordWait)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedFunctionName,
        "Expected a function identifier after 'function'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const name = this.#identifier(this.#advance());
    const parameters: FunctionParameter[] = [];
    if (this.#match(TokenKind.LeftParenthesis)) {
      this.#skipNewlines();
      if (this.#check(TokenKind.RightParenthesis)) {
        this.#reportToken(
          parserDiagnosticCode.emptyFunctionParameters,
          "Parentheses are omitted when a function has no parameters.",
          this.#peek(),
        );
      }
      while (!this.#check(TokenKind.RightParenthesis) && !this.#check(TokenKind.EndOfFile)) {
        const parameter = this.#parseFunctionParameter();
        if (parameter !== null) parameters.push(parameter);
        this.#skipNewlines();
        if (!this.#match(TokenKind.Comma)) break;
        this.#skipNewlines();
        if (this.#check(TokenKind.RightParenthesis)) {
          this.#reportInsertion(
            parserDiagnosticCode.expectedParameter,
            "Expected a function parameter after ','.",
          );
          break;
        }
      }
      if (!this.#match(TokenKind.RightParenthesis)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedDelimiter,
          "Expected ')' after the function parameters.",
        );
        this.#synchronizeStatement();
        return null;
      }
    }

    let returnTypeAnnotation: TypeAnnotation | null = null;
    if (this.#match(TokenKind.Colon)) {
      returnTypeAnnotation = this.#parseTypeAnnotation();
      if (returnTypeAnnotation === null) {
        this.#synchronizeStatement();
        return null;
      }
    }
    this.#skipContinuationNewlines();
    const body = yield* parseChild(this.#parseBlock());
    if (body === null) return null;
    return Object.freeze({
      kind: "functionDeclaration",
      name,
      parameters: Object.freeze(parameters),
      returnTypeAnnotation,
      body,
      span: spanFrom(keyword.span, body.span),
    });
  }

  #parseFunctionParameter(): FunctionParameter | null {
    if (!this.#checkDeclarationName()) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedParameter,
        "Expected a function parameter identifier.",
      );
      this.#synchronizeParameter();
      return null;
    }
    const name = this.#identifier(this.#advance());
    let typeAnnotation: TypeAnnotation | null = null;
    let end = name.span;
    if (this.#match(TokenKind.Colon)) {
      typeAnnotation = this.#parseTypeAnnotation("delimited");
      if (typeAnnotation === null) {
        this.#synchronizeParameter();
        return null;
      }
      end = typeAnnotation.span;
    }
    let defaultValue: Expression | null = null;
    if (this.#match(TokenKind.Equal)) {
      this.#skipContinuationNewlines();
      // A parameter list is a `()` grouping, where a line break does not end the default.
      defaultValue = runParse(this.#withinDelimiters(this.#parseRequiredExpressionTask()));
      if (defaultValue === null) {
        this.#synchronizeParameter();
        return null;
      }
      end = defaultValue.span;
    }
    return Object.freeze({
      kind: "functionParameter",
      name,
      typeAnnotation,
      defaultValue,
      span: spanFrom(name.span, end),
    });
  }

  #parseReturnStatement(): ReturnStatement | null {
    const keyword = this.#advance();
    if (
      this.#check(TokenKind.Newline) ||
      this.#check(TokenKind.RightBrace) ||
      this.#check(TokenKind.EndOfFile)
    ) {
      return Object.freeze({ kind: "returnStatement", value: null, span: copySpan(keyword.span) });
    }
    const value = this.#parseRequiredExpression();
    if (value === null) {
      this.#synchronizeStatement();
      return null;
    }
    return Object.freeze({
      kind: "returnStatement",
      value,
      span: spanFrom(keyword.span, value.span),
    });
  }

  /** A statement block; statements inside it are not part of an enclosing cue position or switch subject. */
  *#parseBlock(): ParseTask<Block | null> {
    return yield* parseChild(this.#asStatements(this.#parseBlockStatements()));
  }

  *#parseBlockStatements(): ParseTask<Block | null> {
    if (!this.#match(TokenKind.LeftBrace)) {
      this.#reportInsertion(parserDiagnosticCode.expectedBlock, "Expected '{' to start the block.");
      return null;
    }
    const leftBrace = this.#previous();
    const statements: Statement[] = [];
    this.#skipNewlines();
    while (!this.#check(TokenKind.RightBrace) && !this.#check(TokenKind.EndOfFile)) {
      const startIndex = this.#current;
      const statement = yield* parseChild(this.#parseStatement());
      if (statement !== null) statements.push(statement);
      if (this.#current === startIndex) this.#advance();
      if (this.#recoveredAtStatementBoundary) {
        this.#recoveredAtStatementBoundary = false;
      } else {
        this.#finishStatement(true);
      }
      this.#skipNewlines();
    }
    if (!this.#match(TokenKind.RightBrace)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedRightBrace,
        "Expected '}' to close the block.",
      );
      return null;
    }
    return Object.freeze({
      kind: "block",
      statements: Object.freeze(statements),
      span: spanFrom(leftBrace.span, this.#previous().span),
    });
  }

  #parseAssignmentOrExpressionStatement(): AssignmentStatement | ExpressionStatement | null {
    const expression = this.#parseExpression();
    if (expression === null) {
      this.#synchronizeStatement();
      return null;
    }
    if (
      this.#match(TokenKind.Equal) ||
      this.#match(TokenKind.PlusEqual) ||
      this.#match(TokenKind.MinusEqual)
    ) {
      const operatorKind = this.#previous().kind;
      const operator: AssignmentStatement["operator"] =
        operatorKind === TokenKind.PlusEqual
          ? "+="
          : operatorKind === TokenKind.MinusEqual
            ? "-="
            : "=";
      this.#skipContinuationNewlines();
      const value = this.#parseRequiredExpression();
      if (value === null) {
        this.#synchronizeStatement();
        return null;
      }
      if (!isAssignmentTarget(expression)) {
        this.#reportSpan(
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
    if (expression.kind !== "callExpression") {
      if (expression.kind === "identifier") {
        this.#reportSpan(
          parserDiagnosticCode.expectedStatement,
          "Expected a supported TeaseScript statement.",
          expression.span,
        );
        this.#synchronizeStatement();
        return null;
      }
      this.#reportSpan(
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

  #parseRequiredExpression(): Expression | null {
    return runParse(this.#parseRequiredExpressionTask());
  }

  #parseExpression(): Expression | null {
    return runParse(this.#parseOr());
  }

  *#parseRequiredExpressionTask(): ParseTask<Expression | null> {
    const expression = yield* parseChild(this.#parseOr());
    if (expression === null) {
      this.#reportInsertion(parserDiagnosticCode.expectedExpression, "Expected an expression.");
    }
    return expression;
  }

  /**
   * Parses the value after a `:` that requires one. Newlines after the colon continue the statement unless the next
   * line plainly starts something else; the value is then missing, and the token stays for the enclosing recovery.
   */
  *#parseColonValueTask(required: boolean): ParseTask<Expression | null> {
    if (this.#check(TokenKind.Newline)) {
      this.#skipContinuationNewlines();
      if (this.#startsNonValueLine()) {
        if (required) {
          this.#reportInsertion(parserDiagnosticCode.expectedExpression, "Expected an expression.");
        }
        return null;
      }
    }
    return yield* parseChild(required ? this.#parseRequiredExpressionTask() : this.#parseOr());
  }

  /** A statement, a property or choice key, a closing delimiter, or the end of the file. */
  #startsNonValueLine(): boolean {
    const token = this.#peek();
    const next = this.#peek(1).kind;
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
        return this.#atStatementStart();
    }
  }

  *#parseOr(): ParseTask<Expression | null> {
    let expression = yield* parseChild(this.#parseAnd());
    while (expression !== null && (this.#match(TokenKind.KeywordOr) || this.#matchSymbolicOr())) {
      this.#skipContinuationNewlines();
      const right = yield* parseChild(this.#parseAnd());
      if (right === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an expression after 'or'.",
        );
        return null;
      }
      expression = this.#binary(expression, right, "or");
    }
    return expression;
  }

  *#parseAnd(): ParseTask<Expression | null> {
    let expression = yield* parseChild(this.#parseNot());
    while (expression !== null && this.#match(TokenKind.KeywordAnd)) {
      this.#skipContinuationNewlines();
      const right = yield* parseChild(this.#parseNot());
      if (right === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an expression after 'and'.",
        );
        return null;
      }
      expression = this.#binary(expression, right, "and");
    }
    return expression;
  }

  *#parseNot(): ParseTask<Expression | null> {
    const operators: Token[] = [];
    while (this.#match(TokenKind.KeywordNot)) {
      operators.push(this.#previous());
      this.#skipContinuationNewlines();
    }
    let expression = yield* parseChild(this.#parseComparison());
    if (expression === null) {
      for (let index = 0; index < operators.length; index += 1) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an expression after 'not'.",
        );
      }
      return null;
    }
    for (let index = operators.length - 1; index >= 0; index -= 1) {
      expression = this.#unary(operators[index]!, expression, "not");
    }
    return expression;
  }

  *#parseComparison(): ParseTask<Expression | null> {
    const left = yield* parseChild(this.#parseRange());
    if (left === null) return null;
    let expression: Expression;
    if (this.#check(TokenKind.KeywordIs)) {
      expression = yield* parseChild(this.#parseTypeTestTask(left));
    } else if (isComparisonKind(this.#peek().kind)) {
      const operator = this.#advance();
      this.#skipContinuationNewlines();
      const right = yield* parseChild(this.#parseRange());
      if (right === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an expression after the comparison operator.",
        );
        return null;
      }
      expression = this.#binary(left, right, binaryOperator(operator));
    } else {
      return left;
    }
    if (isComparisonKind(this.#peek().kind) || this.#check(TokenKind.KeywordIs)) {
      this.#reportToken(
        parserDiagnosticCode.chainedComparison,
        "Comparisons may not be chained.",
        this.#peek(),
      );
      while (isComparisonKind(this.#peek().kind) || this.#check(TokenKind.KeywordIs)) {
        if (this.#check(TokenKind.KeywordIs)) {
          yield* parseChild(this.#parseTypeTestTask(expression));
          continue;
        }
        this.#advance();
        this.#skipContinuationNewlines();
        yield* parseChild(this.#parseRange());
      }
    }
    return expression;
  }

  /** `value is T` or `value is not T`; the right operand is a type, not a value (ADR 0021). */
  *#parseTypeTestTask(value: Expression): ParseTask<Expression> {
    this.#advance();
    this.#skipContinuationNewlines();
    const negated = this.#match(TokenKind.KeywordNot);
    this.#skipContinuationNewlines();
    const first = this.#peek();
    if (this.#atComparedValue()) {
      const compared = yield* parseChild(this.#parseRange());
      this.#reportSpan(
        parserDiagnosticCode.invalidType,
        "'is' checks a type; use '==' to compare values.",
        compared?.span ?? first.span,
      );
      return value;
    }
    const type = yield* parseChild(
      this.#parseTypeTask(
        this.#bracketed[this.#current] === true ? "delimitedTypeTest" : "typeTest",
      ),
    );
    if (type === null) return value;
    return Object.freeze({
      kind: "typeTestExpression",
      value,
      type,
      negated,
      span: spanFrom(value.span, type.span),
    });
  }

  /** Whether the right operand of `is`, after any `(`, starts a value rather than a type, as in `is ("happy")`. */
  #atComparedValue(): boolean {
    let offset = 0;
    while (
      this.#peek(offset).kind === TokenKind.LeftParenthesis ||
      this.#peek(offset).kind === TokenKind.Newline
    ) {
      offset += 1;
    }
    const token = this.#peek(offset);
    // `set[1]` is a set value; `set` alone, or `set[]` for a list of sets, is a type.
    if (
      token.kind === TokenKind.KeywordSet &&
      this.#peek(offset + 1).kind === TokenKind.LeftBracket &&
      this.#peek(offset + 2).kind !== TokenKind.RightBracket
    )
      return true;
    return typeName(token) === undefined && isExpressionStart(token);
  }

  *#parseRange(): ParseTask<Expression | null> {
    const left = yield* parseChild(this.#parseAdditive());
    if (
      left === null ||
      (!this.#check(TokenKind.RangeExclusive) && !this.#check(TokenKind.RangeInclusive))
    ) {
      return left;
    }
    const operator = this.#advance();
    this.#skipContinuationNewlines();
    const right = yield* parseChild(this.#parseAdditive());
    if (right === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected an expression after the range operator.",
      );
      return null;
    }
    const expression: Expression = Object.freeze({
      kind: "rangeExpression",
      start: left,
      end: right,
      inclusive: operator.kind === TokenKind.RangeInclusive,
      span: spanFrom(left.span, right.span),
    });
    if (this.#check(TokenKind.RangeExclusive) || this.#check(TokenKind.RangeInclusive)) {
      this.#reportToken(
        parserDiagnosticCode.chainedRange,
        "Ranges may not be chained.",
        this.#peek(),
      );
      while (this.#check(TokenKind.RangeExclusive) || this.#check(TokenKind.RangeInclusive)) {
        this.#advance();
        this.#skipContinuationNewlines();
        yield* parseChild(this.#parseAdditive());
      }
    }
    return expression;
  }

  *#parseAdditive(): ParseTask<Expression | null> {
    let expression = yield* parseChild(this.#parseMultiplicative());
    while (expression !== null && (this.#check(TokenKind.Plus) || this.#check(TokenKind.Minus))) {
      const operator = this.#advance();
      this.#skipContinuationNewlines();
      const right = yield* parseChild(this.#parseMultiplicative());
      if (right === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an expression after the arithmetic operator.",
        );
        return null;
      }
      expression = this.#binary(expression, right, binaryOperator(operator));
    }
    return expression;
  }

  *#parseMultiplicative(): ParseTask<Expression | null> {
    let expression = yield* parseChild(this.#parseUnaryArithmetic());
    while (
      expression !== null &&
      (this.#check(TokenKind.Star) ||
        this.#check(TokenKind.Slash) ||
        this.#check(TokenKind.Percent))
    ) {
      const operator = this.#advance();
      this.#skipContinuationNewlines();
      const right = yield* parseChild(this.#parseUnaryArithmetic());
      if (right === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an expression after the arithmetic operator.",
        );
        return null;
      }
      expression = this.#binary(expression, right, binaryOperator(operator));
    }
    return expression;
  }

  *#parseUnaryArithmetic(): ParseTask<Expression | null> {
    const operators: Token[] = [];
    while (this.#check(TokenKind.Plus) || this.#check(TokenKind.Minus)) {
      operators.push(this.#advance());
      this.#skipContinuationNewlines();
    }
    let expression = yield* parseChild(this.#parsePostfix());
    if (expression === null) {
      for (let index = 0; index < operators.length; index += 1) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an expression after the unary operator.",
        );
      }
      return null;
    }
    for (let index = operators.length - 1; index >= 0; index -= 1) {
      const operator = operators[index]!;
      // EVIDENCE: invariant: operators contains only the plus/minus tokens collected by the loop above.
      expression = this.#unary(operator, expression, operator.lexeme as "+" | "-");
    }
    return expression;
  }

  *#parsePostfix(): ParseTask<Expression | null> {
    let expression = yield* parseChild(this.#parsePrimary());
    while (expression !== null) {
      if (this.#match(TokenKind.Dot)) {
        if (!isPropertyName(this.#peek())) {
          this.#reportInsertion(
            parserDiagnosticCode.expectedPropertyAfterDot,
            "Expected a property name after '.'.",
          );
          return expression;
        }
        const property = this.#identifier(this.#advance());
        expression = Object.freeze({
          kind: "propertyAccessExpression",
          object: expression,
          property,
          span: spanFrom(expression.span, property.span),
        } satisfies PropertyAccessExpression);
        continue;
      }
      if (this.#match(TokenKind.LeftBracket)) {
        const start = expression;
        this.#skipNewlines();
        const index = yield* parseChild(
          this.#withinDelimiters(this.#parseRequiredExpressionTask()),
        );
        this.#skipNewlines();
        if (index === null || !this.#match(TokenKind.RightBracket)) {
          if (index !== null) {
            this.#reportInsertion(
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
          span: spanFrom(start.span, this.#previous().span),
        });
        continue;
      }
      if (this.#match(TokenKind.LeftParenthesis)) {
        expression = yield* parseChild(
          this.#withinDelimiters(this.#finishCall(expression, this.#previous())),
        );
        continue;
      }
      break;
    }
    return expression;
  }

  *#finishCall(callee: Expression, left: Token): ParseTask<CallExpression> {
    const argumentsList: CallArgument[] = [];
    let sawPositional = false;
    let sawNamed = false;
    this.#skipNewlines();
    while (!this.#check(TokenKind.RightParenthesis) && !this.#check(TokenKind.EndOfFile)) {
      let argument: CallArgument | null = null;
      if (isPropertyName(this.#peek()) && this.#peek(1).kind === TokenKind.Colon) {
        const name = this.#identifier(this.#advance());
        this.#advance();
        const value = yield* parseChild(this.#parseColonValueTask(true));
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
        const value = yield* parseChild(this.#parseRequiredExpressionTask());
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
      this.#skipNewlines();
      if (!this.#match(TokenKind.Comma)) break;
      this.#skipNewlines();
      if (this.#check(TokenKind.RightParenthesis)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an argument after ','.",
        );
        break;
      }
    }

    let end = left.span;
    if (this.#match(TokenKind.RightParenthesis)) end = this.#previous().span;
    else {
      this.#reportInsertion(
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

  /** A unit identifier directly after a number literal on the same line forms a duration literal. */
  #parseDurationUnit(amount: NumberLiteral): Expression {
    if (!this.#check(TokenKind.Identifier)) return amount;
    const token = this.#peek();
    const unit = elapsedDurationUnit(token.lexeme);
    if (unit === undefined) {
      if (isCalendarDurationUnit(token.lexeme)) {
        this.#advance();
        this.#reportToken(
          parserDiagnosticCode.unsupportedDurationUnit,
          `Calendar duration unit '${token.lexeme}' is not implemented yet; use ms, s, min, or h.`,
          token,
        );
      }
      return amount;
    }
    this.#advance();
    return Object.freeze({
      kind: "durationLiteral",
      amount,
      unit,
      unitSpan: copySpan(token.span),
      span: spanFrom(amount.span, token.span),
    });
  }

  *#parsePrimary(): ParseTask<Expression | null> {
    const token = this.#peek();
    if (
      this.#checkIdentifier("askText") ||
      this.#checkIdentifier("askNumber") ||
      this.#checkIdentifier("askInteger") ||
      this.#checkIdentifier("choose")
    ) {
      return yield* parseChild(this.#parseInteractionExpression());
    }
    if (this.#checkIdentifier("showButton")) {
      const parts = yield* parseChild(this.#parseShowButtonParts());
      return parts === null ? null : Object.freeze({ kind: "showButtonExpression", ...parts });
    }
    if (this.#checkIdentifier("timer")) {
      const parts = yield* parseChild(this.#parseTimerParts());
      return parts === null ? null : Object.freeze({ kind: "timerExpression", ...parts });
    }
    if (this.#checkIdentifier("playAudio") || this.#checkIdentifier("playVideo")) {
      const parts = yield* parseChild(this.#parseMediaParts());
      return parts === null ? null : Object.freeze({ kind: "playMediaExpression", ...parts });
    }
    if (this.#checkIdentifier("load")) {
      return yield* parseChild(this.#parseLoadExpression());
    }
    if (this.#match(TokenKind.NumberLiteral)) {
      const amount: NumberLiteral = Object.freeze({
        kind: "numberLiteral",
        raw: token.lexeme,
        value: Number(token.lexeme),
        numericType: /[.eE]/u.test(token.lexeme) ? "number" : "integer",
        span: copySpan(token.span),
      });
      return this.#parseDurationUnit(amount);
    }
    if (this.#match(TokenKind.KeywordTrue)) {
      return Object.freeze({ kind: "booleanLiteral", value: true, span: copySpan(token.span) });
    }
    if (this.#match(TokenKind.KeywordFalse)) {
      return Object.freeze({ kind: "booleanLiteral", value: false, span: copySpan(token.span) });
    }
    if (this.#match(TokenKind.KeywordNull)) {
      return Object.freeze({ kind: "nullLiteral", value: null, span: copySpan(token.span) });
    }
    if (
      this.#match(TokenKind.Identifier) ||
      this.#match(TokenKind.KeywordSpeaker) ||
      this.#match(TokenKind.KeywordWait)
    ) {
      return this.#identifier(token);
    }
    if (this.#match(TokenKind.StringStart)) {
      return yield* parseChild(this.#withoutEnclosingDelimiters(this.#parseStringLiteral(token)));
    }
    if (this.#match(TokenKind.LeftParenthesis)) {
      return yield* parseChild(this.#withinDelimiters(this.#parseParenthesized(token)));
    }
    if (this.#match(TokenKind.LeftBracket)) {
      return yield* parseChild(
        this.#withinDelimiters(this.#parseCollectionLiteralElements(token, "listLiteral")),
      );
    }
    if (this.#match(TokenKind.LeftBrace)) {
      return yield* parseChild(this.#withinDelimiters(this.#parseObjectLiteral(token)));
    }
    if (this.#match(TokenKind.KeywordSet)) {
      if (!this.#match(TokenKind.LeftBracket)) {
        this.#reportInsertion(parserDiagnosticCode.expectedDelimiter, "Expected '[' after 'set'.");
        return null;
      }
      return yield* parseChild(
        this.#withinDelimiters(this.#parseCollectionLiteralElements(token, "setLiteral")),
      );
    }
    return null;
  }

  *#parseInteractionExpression(): ParseTask<InteractionExpression | null> {
    const command = this.#advance();
    if (this.#check(TokenKind.LeftParenthesis)) {
      this.#reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        `Parenthesized ${command.lexeme} arguments are not supported in the compact interaction syntax.`,
        this.#peek().span,
      );
      this.#synchronizeStatement();
      return null;
    }
    const interactionKind =
      command.lexeme === "askText"
        ? "text"
        : command.lexeme === "askNumber"
          ? "number"
          : command.lexeme === "askInteger"
            ? "integer"
            : "choice";
    let asSpan: SourceSpan | null = null;
    let speaker: Identifier | null = null;
    if (!this.#atStorageDelimiter() && this.#match(TokenKind.KeywordAs)) {
      asSpan = copySpan(this.#previous().span);
      if (!this.#check(TokenKind.Identifier)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedInteractionSpeaker,
          "Expected a speaker identifier after 'as'.",
        );
        return null;
      }
      speaker = this.#identifier(this.#advance());
    }
    if (this.#check(TokenKind.LeftParenthesis)) {
      this.#reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        `Parenthesized ${command.lexeme} arguments are not supported in the compact interaction syntax.`,
        this.#peek().span,
      );
      this.#synchronizeStatement();
      return null;
    }

    if (interactionKind !== "choice") {
      const hint =
        isExpressionStart(this.#peek()) &&
        !(this.#blockEndsCompactInteraction && this.#check(TokenKind.LeftBrace)) &&
        !this.#atStorageDelimiter() &&
        !this.#atInteractionDefault(0)
          ? yield* parseChild(this.#parseOr())
          : null;
      let defaultValue: Expression | null = null;
      let defaultOffset = hint === null ? 0 : this.#offsetAfterComma();
      if (defaultOffset === null && this.#atInteractionDefault(0)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedDelimiter,
          "Expected ',' between the hint and 'default:'.",
        );
        defaultOffset = 0;
      }
      if (defaultOffset !== null && this.#atInteractionDefault(defaultOffset)) {
        for (let skipped = 0; skipped < defaultOffset + 2; skipped += 1) this.#advance();
        defaultValue = yield* parseChild(this.#parseColonValueTask(false));
        if (defaultValue === null) {
          this.#reportInsertion(
            parserDiagnosticCode.expectedInteractionText,
            "Expected a default answer after 'default:'.",
          );
          if (this.#previous().kind === TokenKind.Newline && this.#atStatementStart())
            this.#recoveredAtStatementBoundary = true;
        }
      }
      if (this.#check(TokenKind.KeywordAs) && !this.#atStorageDelimiter()) {
        this.#reportSpan(
          parserDiagnosticCode.unsupportedInteractionForm,
          `The 'as speaker' clause must appear immediately after '${command.lexeme}'.`,
          this.#peek().span,
        );
        this.#synchronizeStatement();
      }
      const end = defaultValue?.span ?? hint?.span ?? speaker?.span ?? command.span;
      return Object.freeze({
        kind: "interactionExpression",
        interactionKind,
        commandSpan: copySpan(command.span),
        asSpan,
        speaker,
        hint,
        defaultValue,
        options: Object.freeze([]),
        span: spanFrom(command.span, end),
      });
    }

    const options: InteractionChoiceOption[] = [];
    let missingChoiceOptionWasReported = false;
    while (!this.#isInteractionChoiceTerminator()) {
      const optionValue =
        (this.#check(TokenKind.Identifier) || this.#check(TokenKind.NumberLiteral)) &&
        this.#peek(1).kind === TokenKind.Colon
          ? this.#interactionChoiceValue(this.#advance())
          : null;
      let colonSpan: SourceSpan | null = null;
      if (optionValue !== null) {
        this.#advance();
        colonSpan = copySpan(this.#previous().span);
      }
      const expression = yield* parseChild(
        optionValue === null ? this.#parseOr() : this.#parseColonValueTask(false),
      );
      if (expression === null) {
        missingChoiceOptionWasReported = true;
        this.#reportInsertion(
          parserDiagnosticCode.expectedChoiceOption,
          optionValue === null
            ? "Expected at least one choice option."
            : "Expected a choice option expression after ':'.",
        );
        if (this.#atStatementStart()) {
          this.#recoveredAtStatementBoundary = true;
        }
        break;
      }
      let separatorSpan: SourceSpan | null = null;
      // As for a default answer, inside delimiters a comma on the next line continues the options.
      const commaOffset = this.#offsetAfterComma();
      if (commaOffset !== null) {
        while (this.#check(TokenKind.Newline)) this.#advance();
        this.#advance();
        separatorSpan = copySpan(this.#previous().span);
      }
      options.push(
        Object.freeze({
          kind: "interactionChoiceOption",
          value: optionValue,
          colonSpan,
          expression,
          separatorSpan,
          span: spanFrom(optionValue?.span ?? expression.span, expression.span),
        }),
      );
      if (separatorSpan === null) {
        if (
          !this.#isInteractionChoiceTerminator() &&
          !this.#recoveredAtStatementBoundary &&
          !(this.#blockEndsCompactInteraction && this.#check(TokenKind.LeftBrace))
        ) {
          if (this.#check(TokenKind.KeywordAs)) {
            this.#reportSpan(
              parserDiagnosticCode.unsupportedInteractionForm,
              "The 'as speaker' clause must appear immediately after 'choose'.",
              this.#peek().span,
            );
          } else {
            this.#reportSpan(
              parserDiagnosticCode.expectedChoiceSeparator,
              "Expected ',' or the end of the statement after a choice option.",
              this.#peek().span,
            );
          }
          this.#synchronizeStatement();
        }
        break;
      }
      this.#skipContinuationNewlines();
      if (this.#isInteractionChoiceTerminator()) {
        missingChoiceOptionWasReported = true;
        this.#reportInsertion(
          parserDiagnosticCode.expectedChoiceOption,
          "Expected a choice option after ','.",
        );
        break;
      }
    }
    if (options.length === 0 && !missingChoiceOptionWasReported) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedChoiceOption,
        "Expected at least one choice option.",
      );
    }
    const end = options.at(-1)?.expression.span ?? speaker?.span ?? command.span;
    return Object.freeze({
      kind: "interactionExpression",
      interactionKind,
      commandSpan: copySpan(command.span),
      asSpan,
      speaker,
      hint: null,
      defaultValue: null,
      options: Object.freeze(options),
      span: spanFrom(command.span, end),
    });
  }

  #isInteractionChoiceTerminator(): boolean {
    return (
      this.#check(TokenKind.Newline) ||
      this.#check(TokenKind.EndOfFile) ||
      this.#check(TokenKind.RightBrace) ||
      this.#check(TokenKind.RightParenthesis) ||
      this.#check(TokenKind.RightBracket) ||
      this.#check(TokenKind.InterpolationEnd) ||
      this.#atStorageDelimiter()
    );
  }

  /** `default:` at `offset` tokens ahead, the named default answer of `askText` or `askNumber`. */
  #atInteractionDefault(offset: number): boolean {
    const token = this.#peek(offset);
    return (
      token.kind === TokenKind.Identifier &&
      token.lexeme === "default" &&
      this.#peek(offset + 1).kind === TokenKind.Colon
    );
  }

  /**
   * The offset of the token after a `,` and any newlines after it, or `null` without a comma. Inside delimiters a line
   * break does not end the expression, so the comma may also start the next line there (V30 §2). Nested interactions
   * that end at the same token reuse one scan of the newlines.
   */
  #offsetAfterComma(): number | null {
    const lookahead = this.#commaLookahead;
    if (lookahead?.at === this.#current && lookahead.insideDelimiters === this.#insideDelimiters)
      return lookahead.offset;
    let offset: number | null = 0;
    if (this.#insideDelimiters) while (this.#peek(offset).kind === TokenKind.Newline) offset += 1;
    if (this.#peek(offset).kind !== TokenKind.Comma) offset = null;
    else {
      offset += 1;
      while (this.#peek(offset).kind === TokenKind.Newline) offset += 1;
    }
    this.#commaLookahead = { at: this.#current, insideDelimiters: this.#insideDelimiters, offset };
    return offset;
  }

  #atStorageDelimiter(): boolean {
    return (
      (this.#storageDelimiters.has("as") && this.#check(TokenKind.KeywordAs)) ||
      // `default:` is a contextual name, such as a choice option label, not the earlier form.
      (this.#storageDelimiters.has("default") &&
        this.#checkIdentifier("default") &&
        this.#peek(1).kind !== TokenKind.Colon)
    );
  }

  /** Parses a `()`, `[]`, or object-literal grouping, where a line break does not end an expression. */
  *#withinDelimiters<T>(task: ParseTask<T>): ParseTask<T> {
    const enclosing = this.#insideDelimiters;
    this.#insideDelimiters = true;
    try {
      return yield* parseChild(this.#withoutEnclosingDelimiters(task));
    } finally {
      this.#insideDelimiters = enclosing;
    }
  }

  /** Parses a block of statements, where a line break ends a complete statement again. */
  *#asStatements<T>(task: ParseTask<T>): ParseTask<T> {
    const enclosing = this.#insideDelimiters;
    this.#insideDelimiters = false;
    try {
      return yield* parseChild(this.#withoutEnclosingDelimiters(task));
    } finally {
      this.#insideDelimiters = enclosing;
    }
  }

  /**
   * Parses a grouping or block in which the delimiters that end an enclosing operand do not apply: the storage `as`
   * and `default`, and the block `{` after a cue position or switch subject.
   */
  *#withoutEnclosingDelimiters<T>(task: ParseTask<T>): ParseTask<T> {
    const enclosingStorageDelimiters = this.#storageDelimiters;
    const enclosingBlockEndsInteraction = this.#blockEndsCompactInteraction;
    this.#storageDelimiters = NO_STORAGE_DELIMITERS;
    this.#blockEndsCompactInteraction = false;
    try {
      return yield* parseChild(task);
    } finally {
      this.#storageDelimiters = enclosingStorageDelimiters;
      this.#blockEndsCompactInteraction = enclosingBlockEndsInteraction;
    }
  }

  /** Parses a `save` or `delete` operand that ends at the given delimiters. */
  #parseStorageOperand(delimiters: ReadonlySet<StorageDelimiter>): Expression | null {
    const enclosing = this.#storageDelimiters;
    this.#storageDelimiters = delimiters;
    const operand = this.#parseExpression();
    this.#storageDelimiters = enclosing;
    return operand;
  }

  #interactionChoiceValue(token: Token): Identifier | import("./ast.js").NumberLiteral {
    if (token.kind === TokenKind.Identifier) return this.#identifier(token);
    return Object.freeze({
      kind: "numberLiteral",
      raw: token.lexeme,
      value: Number(token.lexeme),
      numericType: /[.eE]/u.test(token.lexeme) ? "number" : "integer",
      span: copySpan(token.span),
    });
  }

  *#parseParenthesized(start: Token): ParseTask<ParenthesizedExpression | null> {
    this.#skipNewlines();
    const expression = yield* parseChild(this.#parseRequiredExpressionTask());
    this.#skipNewlines();
    if (expression === null || !this.#match(TokenKind.RightParenthesis)) {
      if (expression !== null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedDelimiter,
          "Expected ')' after the expression.",
        );
      }
      return null;
    }
    return Object.freeze({
      kind: "parenthesizedExpression",
      expression,
      span: spanFrom(start.span, this.#previous().span),
    });
  }

  *#parseCollectionLiteralElements(
    start: Token,
    kind: "listLiteral" | "setLiteral",
  ): ParseTask<ListLiteral | SetLiteral> {
    const elements = yield* parseChild(this.#parseDelimitedElements(TokenKind.RightBracket));
    const end = this.#consumeClosingDelimiter(
      TokenKind.RightBracket,
      kind === "listLiteral"
        ? "Expected ']' after the list literal."
        : "Expected ']' after the set literal.",
    );
    return Object.freeze({
      kind,
      elements: Object.freeze(elements),
      span: spanFrom(start.span, end),
    });
  }

  *#parseDelimitedElements(closing: TokenKind): ParseTask<Expression[]> {
    const elements: Expression[] = [];
    this.#skipNewlines();
    while (!this.#check(closing) && !this.#check(TokenKind.EndOfFile)) {
      const value = yield* parseChild(this.#parseRequiredExpressionTask());
      if (value === null) {
        this.#synchronizeDelimited(closing);
      } else {
        elements.push(value);
      }
      this.#skipNewlines();
      if (!this.#match(TokenKind.Comma)) break;
      this.#skipNewlines();
      if (this.#check(closing)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected a collection element after ','.",
        );
        break;
      }
    }
    return elements;
  }

  *#parseObjectLiteral(start: Token): ParseTask<ObjectLiteral> {
    const properties: ObjectProperty[] = [];
    this.#skipNewlines();
    while (!this.#check(TokenKind.RightBrace) && !this.#check(TokenKind.EndOfFile)) {
      if (!isPropertyName(this.#peek())) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedPropertyName,
          "Expected an object property name.",
        );
        this.#synchronizeDelimited(TokenKind.RightBrace);
        break;
      }
      const name = this.#identifier(this.#advance());
      if (!this.#match(TokenKind.Colon)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedColon,
          "Expected ':' after the object property name.",
        );
        this.#synchronizeDelimited(TokenKind.RightBrace);
        break;
      }
      const value = yield* parseChild(this.#parseColonValueTask(true));
      if (value === null) break;
      properties.push(
        Object.freeze({
          kind: "objectProperty",
          name,
          value,
          span: spanFrom(name.span, value.span),
        }),
      );
      this.#skipNewlines();
      if (!this.#match(TokenKind.Comma)) break;
      this.#skipNewlines();
      if (this.#check(TokenKind.RightBrace)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedPropertyName,
          "Expected an object property after ','.",
        );
        break;
      }
    }
    const end = this.#consumeClosingDelimiter(
      TokenKind.RightBrace,
      "Expected '}' after the object literal.",
    );
    return Object.freeze({
      kind: "objectLiteral",
      properties: Object.freeze(properties),
      span: spanFrom(start.span, end),
    });
  }

  *#parseStringLiteral(start: Token): ParseTask<StringLiteral | null> {
    const parts: StringPart[] = [];
    let valid = true;
    while (!this.#check(TokenKind.StringEnd) && !this.#check(TokenKind.EndOfFile)) {
      if (this.#match(TokenKind.StringText)) {
        parts.push(this.#stringText(this.#previous()));
        continue;
      }
      if (this.#match(TokenKind.InterpolationStart)) {
        const interpolation = yield* parseChild(this.#parseStringInterpolation(this.#previous()));
        if (interpolation === null) valid = false;
        else parts.push(interpolation);
        continue;
      }
      this.#reportToken(
        parserDiagnosticCode.unsupportedStringExpression,
        "Unexpected token in string.",
        this.#peek(),
      );
      valid = false;
      this.#advance();
    }
    if (!this.#match(TokenKind.StringEnd)) return null;
    if (!valid) return null;
    return Object.freeze({
      kind: "stringLiteral",
      form: start.lexeme.length === 3 ? "block" : "singleLine",
      parts: Object.freeze(parts),
      span: spanFrom(start.span, this.#previous().span),
    });
  }

  *#parseStringInterpolation(start: Token): ParseTask<StringInterpolation | null> {
    this.#skipNewlines();
    if (this.#check(TokenKind.InterpolationEnd)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedStringExpression,
        "Expected an expression inside the string interpolation.",
      );
      this.#advance();
      return null;
    }
    if (this.#check(TokenKind.StringEnd) || this.#check(TokenKind.EndOfFile)) {
      return null;
    }
    const diagnosticCount = this.#diagnostics.length;
    const expression = yield* parseChild(this.#parseOr());
    if (expression === null) {
      this.#reportToken(
        parserDiagnosticCode.unsupportedStringExpression,
        "Expected a supported expression inside the string interpolation.",
        this.#peek(),
      );
      this.#synchronizeInterpolation();
      this.#match(TokenKind.InterpolationEnd);
      return null;
    }
    if (this.#diagnostics.length !== diagnosticCount) {
      this.#synchronizeInterpolation();
      this.#match(TokenKind.InterpolationEnd);
      return null;
    }
    this.#skipNewlines();
    if (!this.#match(TokenKind.InterpolationEnd)) {
      if (!this.#check(TokenKind.StringEnd) && !this.#check(TokenKind.EndOfFile)) {
        const message = this.#check(TokenKind.Colon)
          ? "Only identifiers and chained property access are supported in string interpolation."
          : "Only one complete expression is allowed in string interpolation.";
        this.#reportToken(parserDiagnosticCode.unsupportedStringExpression, message, this.#peek());
      }
      this.#synchronizeInterpolation();
      this.#match(TokenKind.InterpolationEnd);
      return null;
    }
    return Object.freeze({
      kind: "stringInterpolation",
      expression,
      span: spanFrom(start.span, this.#previous().span),
    });
  }

  #binary(
    left: Expression,
    right: Expression,
    operator: BinaryExpression["operator"],
  ): BinaryExpression {
    return Object.freeze({
      kind: "binaryExpression",
      operator,
      left,
      right,
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

  #speakerDeclaration(
    keyword: Token,
    name: Identifier,
    properties: readonly SpeakerProperty[],
    end: SourceSpan,
  ): SpeakerDeclaration {
    return Object.freeze({
      kind: "speakerDeclaration",
      name,
      properties: Object.freeze([...properties]),
      span: spanFrom(keyword.span, end),
    });
  }

  #identifier(token: Token): Identifier {
    return Object.freeze({ kind: "identifier", name: token.lexeme, span: copySpan(token.span) });
  }

  #stringText(token: Token): StringText {
    return Object.freeze({
      kind: "stringText",
      raw: token.lexeme,
      value: tokenValue(token),
      span: copySpan(token.span),
    });
  }

  #consumeClosingDelimiter(kind: TokenKind, message: string): SourceSpan {
    this.#skipNewlines();
    if (this.#match(kind)) return this.#previous().span;
    this.#reportInsertion(parserDiagnosticCode.expectedDelimiter, message);
    return this.#previous().span;
  }

  #finishStatement(inBlock: boolean): void {
    if (this.#check(TokenKind.Newline)) {
      this.#skipNewlines();
      return;
    }
    if (this.#check(TokenKind.EndOfFile) || (inBlock && this.#check(TokenKind.RightBrace))) {
      return;
    }
    this.#reportInsertion(
      parserDiagnosticCode.expectedStatementEnd,
      "Expected a newline after the statement.",
    );
    this.#synchronizeStatement(inBlock);
  }

  #skipMalformedBlock(): void {
    let depth = 0;
    while (!this.#check(TokenKind.EndOfFile)) {
      if (this.#match(TokenKind.LeftBrace)) depth += 1;
      else if (this.#match(TokenKind.RightBrace)) {
        depth -= 1;
        if (depth === 0) return;
      } else this.#advance();
    }
  }

  #synchronizeStatement(stopAtRightBrace = false): void {
    while (
      !this.#check(TokenKind.Newline) &&
      !this.#check(TokenKind.EndOfFile) &&
      !(stopAtRightBrace && this.#check(TokenKind.RightBrace))
    ) {
      this.#advance();
    }
  }

  #synchronizeProperty(): void {
    while (
      !this.#check(TokenKind.Newline) &&
      !this.#check(TokenKind.RightBrace) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      this.#advance();
    }
  }

  #synchronizeDelimited(closing: TokenKind): void {
    while (
      !this.#check(TokenKind.Comma) &&
      !this.#check(closing) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      this.#advance();
    }
  }

  #synchronizeParameter(): void {
    while (
      !this.#check(TokenKind.Comma) &&
      !this.#check(TokenKind.RightParenthesis) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      this.#advance();
    }
  }

  #synchronizeInterpolation(): void {
    while (
      !this.#check(TokenKind.InterpolationEnd) &&
      !this.#check(TokenKind.StringEnd) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      this.#advance();
    }
  }

  #isRecoveredTopLevelStatement(): boolean {
    return this.#atStatementStart() && this.#peek(1).kind !== TokenKind.Colon;
  }

  /** A statement keyword, or a protected statement-only command, which can never be a value. */
  #atStatementStart(): boolean {
    const token = this.#peek();
    return (
      isStatementStart(token.kind) ||
      (token.kind === TokenKind.Identifier && statementOnlyCommands.has(token.lexeme))
    );
  }

  #skipNewlines(): void {
    while (this.#match(TokenKind.Newline)) {
      // Newline tokens delimit statements unless a caller explicitly skips them.
    }
  }

  #skipContinuationNewlines(): void {
    this.#skipNewlines();
  }

  #reportPositionalAfterNamed(span: SourceSpan): void {
    this.#reportSpan(
      parserDiagnosticCode.mixedArguments,
      "A positional argument may not follow a named argument. Move it before the named arguments, or name it too.",
      span,
    );
  }

  #reportInsertion(
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
  ): void {
    const position = this.#peek().span.start;
    this.#diagnostics.push(
      createDiagnostic(
        DiagnosticSeverity.Error,
        code,
        message,
        createSourceSpan(position, position),
      ),
    );
  }

  #reportToken(
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
    token: Token,
  ): void {
    this.#reportSpan(code, message, token.span);
  }

  #reportSpan(
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
    span: SourceSpan,
  ): void {
    this.#diagnostics.push(createDiagnostic(DiagnosticSeverity.Error, code, message, span));
  }

  #match(kind: TokenKind): boolean {
    if (!this.#check(kind)) return false;
    this.#advance();
    return true;
  }

  #check(kind: TokenKind): boolean {
    return this.#peek().kind === kind;
  }

  /** `|` or `||` between values: report the word operator and continue as `or` (V30 §5, §39). */
  #matchSymbolicOr(): boolean {
    if (!this.#check(TokenKind.Pipe)) return false;
    const first = this.#advance();
    const last = this.#match(TokenKind.Pipe) ? this.#previous() : first;
    this.#reportSpan(
      parserDiagnosticCode.symbolicOperator,
      "Use 'or' to combine conditions. '|' only separates the types of a union, as in 'integer | string'.",
      spanFrom(first.span, last.span),
    );
    return true;
  }

  #checkIdentifier(name: string): boolean {
    return this.#check(TokenKind.Identifier) && this.#peek().lexeme === name;
  }

  /** The protected keyword `set` parses as a declared name so that its declaration gets the protected-name diagnostic. */
  #checkDeclarationName(): boolean {
    return this.#check(TokenKind.Identifier) || this.#check(TokenKind.KeywordSet);
  }

  #advance(): Token {
    const token = this.#peek();
    if (token.kind !== TokenKind.EndOfFile) this.#current += 1;
    return token;
  }

  #peek(distance = 0): Token {
    return this.tokens[Math.min(this.#current + distance, this.tokens.length - 1)]!;
  }

  #previous(): Token {
    return this.tokens[this.#current - 1]!;
  }
}

const IDENTIFIER_TYPE_NAMES: ReadonlyMap<string, TypeName> = new Map(
  (
    [
      "string",
      "boolean",
      "integer",
      "number",
      "date",
      "time",
      "datetime",
      "duration",
      "list",
      "object",
      "range",
      "timer",
      "media",
    ] as const
  ).map((name) => [name, name]),
);

/** The type name a token spells in type position; `speaker`, `set`, and `null` are keywords elsewhere. */
function typeName(token: Token): TypeName | undefined {
  switch (token.kind) {
    case TokenKind.Identifier:
      return IDENTIFIER_TYPE_NAMES.get(token.lexeme);
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
]);

function mediaHandlersSpan(handlers: MediaHandlers): SourceSpan {
  return handlers.kind === "compact" ? handlers.body.span : handlers.span;
}

function isPropertyName(token: Token): boolean {
  return propertyNameKinds.has(token.kind);
}

function isExpressionStart(token: Token): boolean {
  return (
    token.kind === TokenKind.Identifier ||
    token.kind === TokenKind.NumberLiteral ||
    token.kind === TokenKind.StringStart ||
    token.kind === TokenKind.KeywordSpeaker ||
    token.kind === TokenKind.KeywordWait ||
    token.kind === TokenKind.KeywordTrue ||
    token.kind === TokenKind.KeywordFalse ||
    token.kind === TokenKind.KeywordNull ||
    token.kind === TokenKind.KeywordSet ||
    token.kind === TokenKind.KeywordNot ||
    token.kind === TokenKind.LeftParenthesis ||
    token.kind === TokenKind.LeftBracket ||
    token.kind === TokenKind.LeftBrace ||
    token.kind === TokenKind.Plus ||
    token.kind === TokenKind.Minus
  );
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

/** Tokens after which the expression parser skips newlines: binary operators and the comma of a compact choice. */
function continuesExpression(kind: TokenKind): boolean {
  return (
    isComparisonKind(kind) ||
    kind === TokenKind.KeywordIs ||
    kind === TokenKind.Comma ||
    kind === TokenKind.KeywordOr ||
    kind === TokenKind.KeywordAnd ||
    kind === TokenKind.KeywordNot ||
    kind === TokenKind.RangeExclusive ||
    kind === TokenKind.RangeInclusive ||
    kind === TokenKind.Plus ||
    kind === TokenKind.Minus ||
    kind === TokenKind.Star ||
    kind === TokenKind.Slash ||
    kind === TokenKind.Percent
  );
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

function spanFrom(start: SourceSpan, end: SourceSpan): SourceSpan {
  return createSourceSpan(start.start, end.end);
}

function copySpan(span: SourceSpan): SourceSpan {
  return createSourceSpan(span.start, span.end);
}

const CLOSERS: Readonly<Partial<Record<TokenKind, TokenKind>>> = {
  [TokenKind.RightParenthesis]: TokenKind.LeftParenthesis,
  [TokenKind.RightBracket]: TokenKind.LeftBracket,
  [TokenKind.RightBrace]: TokenKind.LeftBrace,
  [TokenKind.InterpolationEnd]: TokenKind.InterpolationStart,
};

/**
 * For each token, whether the innermost delimiter around it is `(` or `[`. A block, an object, or text inside them
 * starts again, so a newline there ends a statement as usual.
 */
function bracketContexts(tokens: readonly Token[]): boolean[] {
  const contexts: boolean[] = [];
  const openers: TokenKind[] = [];
  for (const token of tokens) {
    const innermost = openers.at(-1);
    contexts.push(innermost === TokenKind.LeftParenthesis || innermost === TokenKind.LeftBracket);
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
