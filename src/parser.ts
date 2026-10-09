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
  GlobalStatement,
  FunctionParameter,
  CallFileStatement,
  FallbackStatement,
  GotoStatement,
  TransferTarget,
  Identifier,
  IfStatement,
  LabelStatement,
  LetStatement,
  NamedArgument,
  ObjectLiteral,
  ObjectProperty,
  ParenthesizedExpression,
  PositionalArgument,
  Program,
  PropertyAccessExpression,
  SayParts,
  ShowButtonParts,
  ShowButtonStatement,
  FormArgument,
  InteractionExpression,
  InteractionChoiceOption,
  WaitStatement,
  TimerStatement,
  TimerParts,
  TimerDisplay,
  HideImageStatement,
  HideCameraStatement,
  CameraPlacement,
  ShowPermanentButtonParts,
  MediaCue,
  MediaHandlers,
  MediaKind,
  MediaParts,
  MediaRepeat,
  PlayMediaStatement,
  StopAudioStatement,
  DeleteStatement,
  LoadExpression,
  SaveStatement,
  ShowImageStatement,
  CalendarDurationUnit,
  DurationUnit,
  UnitExpression,
  ListLiteral,
  NumberLiteral,
  RepeatStatement,
  ReturnStatement,
  SetLiteral,
  DictEntry,
  DictLiteral,
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
  SwitchTypeTest,
  TagQueryExpression,
  TagQueryStep,
  TypeAnnotation,
  TypeName,
  UnaryExpression,
  WhileStatement,
} from "./ast.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { lex } from "./lexer.js";
import { readMisplacedHeader, readScriptHeader, type ScriptHeader } from "./script-header.js";
import { isTagListOption, tagPredicateSteps } from "./tag-query.js";
import { calendarDurationUnit, elapsedDurationUnit, UNIT_OPERANDS } from "./duration.js";
import { createSourcePosition, createSourceSpan, type SourceSpan } from "./source.js";
import { TokenKind, type Token } from "./token.js";

export interface ParseResult {
  readonly program: Program;
  /** The file's `---` header, or `null` when it has none. */
  readonly header: ScriptHeader | null;
  readonly diagnostics: readonly Diagnostic[];
  /**
   * Every statement and media cue the parser read, also one it could not read and left out of the program, and the
   * inside of every statement block. Language tooling finds the statement at a position with them.
   */
  readonly statementRanges: readonly StatementRange[];
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

// Commands that #parseStatement dispatches by name. A line that starts with one starts a statement; only `showButton`
// also has an expression form, used after `=`, an operator, or an opening delimiter. `showCamera`, like `timer`, is
// not listed, so its value form may start a line after `:`.
const statementOnlyCommands: ReadonlySet<string> = new Set([
  "showButton",
  "showImage",
  "hideImage",
  "hideCamera",
  "stopAudio",
  "save",
  "delete",
  "switch",
  "label",
  "goto",
  "call",
  "fallback",
  "end",
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
  expectedLabelName: "TSP039",
  invalidLoadForm: "TSP040",
  invalidTagQuery: "TST001",
} as const;

const MEDIA_ARGUMENTS = ["file", "async", "repeat", "startAt", "endAt", "volume"] as const;

/**
 * How a type continues (V30 §1): a statement type ends at a newline; inside `()`, a newline may also precede `|` or
 * a postfix form; and the type of an `is` test also ends before `||`, the rejected symbolic `or` (V30 §5).
 */
type TypeContext = "statement" | "delimited" | "typeTest" | "delimitedTypeTest";

type StorageDelimiter = "as" | "default";
/** What the parsers over one token list share. */
interface SharedParse {
  /** For each token, whether its innermost enclosing opener is `(` or `[`, where a newline may continue a type (V30 §1). */
  readonly bracketed: readonly boolean[];
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
   * For each newline token, the index of the first newline of its run and of the token after the run, so that skipping
   * a run, or giving it back after a missing closer, costs the same at every level of nesting.
   */
  readonly newlineRuns: { readonly starts: Int32Array; readonly ends: Int32Array };
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
  /**
   * The statement ranges its parse recorded: `list` from `from` up to `to`. `list` only grows, so a nested value shares
   * it rather than copying its ranges into every value around it.
   */
  readonly ranges: {
    readonly list: readonly StatementRange[];
    readonly from: number;
    readonly to: number;
  };
  readonly recovered: boolean;
}
/** The compact interaction commands other than `choose`, and the kind of answer each asks for. */
const INTERACTION_KINDS: ReadonlyMap<string, InteractionExpression["interactionKind"]> = new Map([
  ["askText", "text"],
  ["askNumber", "number"],
  ["askInteger", "integer"],
  ["askDate", "date"],
  ["askTime", "time"],
  ["askDateTime", "datetime"],
  ["askBoolean", "boolean"],
  ["askForm", "form"],
  ["askBooleans", "booleans"],
]);
/** The named arguments of each basic ask and of `askForm`, in the order the message suggests them. */
const ASK_OPTIONS: readonly string[] = ["prefill", "hint"];
const FORM_OPTIONS: readonly string[] = [
  "fields",
  "hint",
  "submit",
  "cancel",
  "outro",
  "timeout",
  "onTimeout",
];
/** The asks that name every argument other than the question, with their names; the question may be `message:`. */
const NAMED_ASK_OPTIONS: ReadonlyMap<InteractionExpression["interactionKind"], readonly string[]> =
  new Map([
    ["form", FORM_OPTIONS],
    ["boolean", ["yesText", "noText", "prefill", "message"]],
    ["booleans", ["texts", "prefill", "cancel", "message"]],
  ]);
/**
 * The earlier name of an ask's `prefill:`, which is a compile error that names the fix (owner decision on #512,
 * 2026-10-08): `default:`, or `defaults:` for `askBooleans`.
 */
function removedPrefillName(kind: InteractionExpression["interactionKind"]): string | null {
  if (kind === "booleans") return "defaults";
  return kind === "choice" || kind === "form" ? null : "default";
}
const NO_STORAGE_DELIMITERS: ReadonlySet<StorageDelimiter> = new Set();
const OPENING_TOKENS: ReadonlySet<TokenKind> = new Set([
  TokenKind.LeftParenthesis,
  TokenKind.LeftBracket,
  TokenKind.LeftBrace,
  TokenKind.InterpolationStart,
]);
const CLOSING_TOKENS: ReadonlySet<TokenKind> = new Set([
  TokenKind.RightParenthesis,
  TokenKind.RightBracket,
  TokenKind.RightBrace,
  TokenKind.InterpolationEnd,
]);
/** Expressions that end at their own last token, so a following `, name:` cannot belong to them. */
const SELF_DELIMITED_EXPRESSIONS: ReadonlySet<Expression["kind"]> = new Set([
  "stringLiteral",
  "identifier",
  "parenthesizedExpression",
  "propertyAccessExpression",
  "indexExpression",
  "callExpression",
]);
const SAVE_VALUE_DELIMITERS: ReadonlySet<StorageDelimiter> = new Set(["as"]);

/** Parses the accepted core-language milestone. */
export function parse(source: string): ParseResult {
  const header = readScriptHeader(lex(source));
  const parser = new Parser(header.programTokens);
  const program = parser.parseProgram();

  return Object.freeze({
    program,
    header: header.header,
    diagnostics: Object.freeze([...header.diagnostics, ...parser.diagnostics]),
    statementRanges: Object.freeze(parser.statementRanges),
  });
}

class Parser {
  readonly #diagnostics: Diagnostic[] = [];
  /**
   * A speculative parser keeps its own, so only the statements of the parse that counts are listed, also those of a
   * `say` value it reuses.
   */
  readonly #statementRanges: StatementRange[] = [];
  #current = 0;
  #commaLookahead: {
    readonly at: number;
    readonly insideDelimiters: boolean;
    readonly offset: number | null;
  } | null = null;
  #recoveredAtStatementBoundary = false;
  /**
   * Inside a media cue position, a permanent button's text, or the head of a block statement such as `if` or `switch`,
   * where the following block `{` ends a compact interaction.
   */
  #blockEndsCompactInteraction = false;
  /**
   * The `save` `as` that ends an enclosing storage operand, and a bare `default` after a `load` key, the earlier form
   * that `load` reports with its fix. A compact interaction stops at them, and a bare interaction leaves the `as` to
   * `save`; groupings such as parentheses start without them.
   */
  #storageDelimiters: ReadonlySet<StorageDelimiter> = NO_STORAGE_DELIMITERS;
  /** Inside `()`, `[]`, or an object literal, where a line break does not end an expression (V30 §2). */
  #insideDelimiters = false;
  /** What every parser over these tokens shares: a speculative parser computes none of it again. */
  readonly #shared: SharedParse;

  public constructor(
    private readonly tokens: readonly Token[],
    shared: SharedParse = {
      bracketed: bracketContexts(tokens),
      closers: null,
      sayValues: new Map(),
      recoveredStrings: new WeakSet(),
      newlineRuns: newlineRuns(tokens),
    },
  ) {
    this.#shared = shared;
  }

  public get diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  public get statementRanges(): readonly StatementRange[] {
    return this.#statementRanges;
  }

  public parseProgram(): Program {
    const statements: Statement[] = [];
    this.#skipNewlines();
    while (!this.#check(TokenKind.EndOfFile)) {
      const startIndex = this.#current;
      const diagnosticCount = this.#diagnostics.length;
      const statement = runParse(this.#parseStatement());
      if (statement !== null) statements.push(statement);
      this.#endStatement(startIndex, diagnosticCount, false);
    }

    return Object.freeze({
      kind: "program",
      statements: Object.freeze(statements),
      span: createSourceSpan(createSourcePosition(0, 0, 0), this.#peek().span.end),
    });
  }

  *#parseStatement(): ParseTask<Statement | null> {
    const misplacedHeader = readMisplacedHeader(this.tokens, this.#current);
    if (misplacedHeader !== null) {
      this.#diagnostics.push(misplacedHeader.diagnostic);
      this.#current = misplacedHeader.next;
      return null;
    }
    if (this.#checkIdentifier("showButton")) {
      return yield* parseChild(this.#parseShowButtonStatement());
    }
    if (this.#checkIdentifier("timer")) {
      return yield* parseChild(this.#parseTimerStatement());
    }
    if (this.#checkIdentifier("showPermanentButton")) {
      const parts = yield* parseChild(this.#parseShowPermanentButtonParts());
      return parts === null
        ? null
        : Object.freeze({ kind: "showPermanentButtonStatement", ...parts });
    }
    if (this.#checkIdentifier("showImage")) {
      return this.#parseShowImageStatement();
    }
    if (this.#checkIdentifier("hideImage")) {
      return this.#parseHideImageStatement();
    }
    if (this.#checkIdentifier("showCamera")) {
      const parts = this.#parseShowCameraParts();
      return parts === null ? null : Object.freeze({ kind: "showCameraStatement", ...parts });
    }
    if (this.#checkIdentifier("hideCamera")) {
      return this.#parseHideCameraStatement();
    }
    if (this.#checkIdentifier("stopAudio")) {
      return this.#parseStopAudioStatement();
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
    if (this.#checkIdentifier("label")) {
      return this.#parseLabelStatement();
    }
    if (
      this.#checkIdentifier("goto") ||
      this.#checkIdentifier("call") ||
      this.#checkIdentifier("fallback")
    ) {
      return yield* parseChild(this.#parseTransferStatement());
    }
    if (this.#checkIdentifier("end")) {
      return Object.freeze({ kind: "endStatement", span: copySpan(this.#advance().span) });
    }
    if (this.#checkIdentifier("global")) {
      return yield* parseChild(this.#parseGlobalStatement());
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
      case TokenKind.KeywordSay: {
        const parts = yield* parseChild(this.#parseSayParts(true));
        return parts === null ? null : Object.freeze({ kind: "sayStatement", ...parts });
      }
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
        return yield* parseChild(this.#parseFunctionDeclaration(null));
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

  /**
   * `say [as speaker] [bubble(options) | prose(options)] [skippable | unskippable] text [, pacing]`, or its bounded form
   * with the text and pacing in parentheses, `say("Waiting.", instant)`. A statement reads parentheses as the bounded
   * form only when a comma follows their first value; others group a value as before, as in `say (a) + b`. A value reads
   * them as the bounded form, so it ends at its `)`. Before that form a mode is written with its options, `say bubble() ("Plain", instant)`, while
   * `say bubble("x")` shows the value of a call; as a value, a skip word before parentheses is the modifier.
   */
  *#parseSayParts(statement: boolean): ParseTask<SayParts | null> {
    const keyword = this.#advance();
    let speaker: Identifier | null = null;
    if (this.#match(TokenKind.KeywordAs)) {
      if (!this.#check(TokenKind.Identifier)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedSpeakerIdentifier,
          "Expected a speaker identifier after 'as'.",
        );
        if (statement) this.#synchronizeStatement();
        return null;
      }
      speaker = this.#identifier(this.#advance());
    }

    const presentation =
      this.#check(TokenKind.Identifier) &&
      ["bubble", "prose"].includes(this.#peek().lexeme) &&
      (this.#atSayModeBeforeBoundedText() ||
        !(yield* parseChild(this.#canParseCompleteSayValue(statement))))
        ? yield* parseChild(this.#parseSayPresentation())
        : null;

    let skipPolicy: SayParts["skipPolicy"] = null;
    if (
      (this.#checkIdentifier("skippable") || this.#checkIdentifier("unskippable")) &&
      ((!statement && this.#peek(1).kind === TokenKind.LeftParenthesis) ||
        !(yield* parseChild(this.#canParseCompleteSayValue(statement))))
    ) {
      skipPolicy = this.#peek().lexeme === "skippable" ? "skippable" : "unskippable";
      this.#advance();
    }

    if (
      this.#check(TokenKind.LeftParenthesis) &&
      (!statement || (yield* parseChild(this.#opensBoundedSayText())))
    ) {
      const bounded = yield* parseChild(this.#withinDelimiters(this.#parseBoundedSayText()));
      if (bounded === null) {
        if (statement) this.#synchronizeStatement();
        return null;
      }
      return Object.freeze({
        presentation,
        speaker,
        skipPolicy,
        value: bounded.value,
        pacing: bounded.pacing,
        span: spanFrom(keyword.span, bounded.end),
      });
    }

    const valueStart = this.#peek().kind;
    const value = yield* parseChild(this.#parseOr());
    if (value === null) {
      if (valueStart !== TokenKind.StringStart)
        this.#reportInsertion(
          parserDiagnosticCode.expectedString,
          "Expected a string after 'say'.",
        );
      if (statement) this.#synchronizeStatement();
      return null;
    }
    let pacing: SayParts["pacing"] = null;
    let endSpan = value.span;
    if (this.#match(TokenKind.Comma)) {
      if (this.#canParseInstantPacingAlias(statement)) {
        endSpan = this.#advance().span;
        pacing = "instant";
      } else {
        const parsedPacing = yield* parseChild(this.#parseOr());
        if (parsedPacing === null) {
          this.#reportInsertion(
            parserDiagnosticCode.expectedExpression,
            "Expected a pacing value after ','.",
          );
          if (statement) this.#synchronizeStatement();
          return null;
        }
        pacing = parsedPacing;
        endSpan = parsedPacing.span;
      }
    }
    return Object.freeze({
      presentation,
      speaker,
      skipPolicy,
      value,
      pacing,
      span: spanFrom(keyword.span, endSpan),
    });
  }

  /** A `say` used as a value, parsed once per position and context (see `SharedParse.sayValues`). */
  *#parseSayValue(): ParseTask<SayParts | null> {
    const start = this.#current;
    const parsed = this.#shared.sayValues.get(start) ?? [];
    const known = parsed.find(
      (value) =>
        value.insideDelimiters === this.#insideDelimiters &&
        value.storageDelimiters === this.#storageDelimiters &&
        value.blockEndsCompactInteraction === this.#blockEndsCompactInteraction &&
        value.recoveredAtStatementBoundary === this.#recoveredAtStatementBoundary,
    );
    if (known !== undefined) {
      this.#diagnostics.push(...known.diagnostics);
      const { list, from, to } = known.ranges;
      for (let index = from; index < to; index += 1) this.#statementRanges.push(list[index]!);
      this.#current = known.end;
      this.#recoveredAtStatementBoundary = known.recovered;
      return known.parts;
    }
    const context = {
      insideDelimiters: this.#insideDelimiters,
      storageDelimiters: this.#storageDelimiters,
      blockEndsCompactInteraction: this.#blockEndsCompactInteraction,
      recoveredAtStatementBoundary: this.#recoveredAtStatementBoundary,
    };
    const diagnosticCount = this.#diagnostics.length;
    const rangeCount = this.#statementRanges.length;
    const parts = yield* parseChild(this.#parseSayParts(false));
    parsed.push({
      ...context,
      parts,
      end: this.#current,
      diagnostics: this.#diagnostics.slice(diagnosticCount),
      ranges: { list: this.#statementRanges, from: rangeCount, to: this.#statementRanges.length },
      recovered: this.#recoveredAtStatementBoundary,
    });
    this.#shared.sayValues.set(start, parsed);
    return parts;
  }

  /** The parentheses of a bounded `say`: its text, then optionally its pacing, until `)`. */
  *#parseBoundedSayText(): ParseTask<{
    readonly value: Expression;
    readonly pacing: SayParts["pacing"];
    readonly end: SourceSpan;
  } | null> {
    this.#advance();
    this.#skipNewlines();
    const value = yield* parseChild(this.#parseRequiredExpressionTask());
    if (value === null) return null;
    this.#skipNewlines();
    let pacing: SayParts["pacing"] = null;
    if (this.#match(TokenKind.Comma)) {
      this.#skipNewlines();
      let after = 1;
      while (this.#peek(after).kind === TokenKind.Newline) after += 1;
      if (
        this.#checkIdentifier("instant") &&
        this.#peek(after).kind === TokenKind.RightParenthesis
      ) {
        this.#advance();
        pacing = "instant";
      } else {
        pacing = yield* parseChild(this.#parseRequiredExpressionTask());
        if (pacing === null) return null;
      }
      this.#skipNewlines();
    }
    if (!this.#match(TokenKind.RightParenthesis)) {
      this.#reportMissingCloser(
        parserDiagnosticCode.expectedDelimiter,
        "Expected ')' after the text and pacing of 'say'.",
      );
      return null;
    }
    return { value, pacing, end: copySpan(this.#previous().span) };
  }

  /**
   * Whether the `bubble` or `prose` here is a mode with options, none or named ones only, followed by the parentheses of
   * a bounded `say`: `bubble() ("Plain", instant)` is no chained call.
   */
  #atSayModeBeforeBoundedText(): boolean {
    if (this.#peek(1).kind !== TokenKind.LeftParenthesis) return false;
    let first = 2;
    while (this.#peek(first).kind === TokenKind.Newline) first += 1;
    if (
      this.#peek(first).kind !== TokenKind.RightParenthesis &&
      !(isPropertyName(this.#peek(first)) && this.#peek(first + 1).kind === TokenKind.Colon)
    )
      return false;
    this.#shared.closers ??= delimiterClosers(this.tokens);
    const closer = this.#shared.closers.get(this.#current + 1);
    return (
      closer !== undefined &&
      this.#peek(closer + 1 - this.#current).kind === TokenKind.LeftParenthesis
    );
  }

  /** `bubble` or `prose`, with its named options in parentheses or none, as the presentation object of a `say`. */
  *#parseSayPresentation(): ParseTask<ObjectLiteral> {
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
        const value = yield* parseChild(this.#withinDelimiters(this.#parseColonValueTask(true)));
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
        this.#reportMissingCloser(
          parserDiagnosticCode.expectedExpression,
          "Expected ')' after presentation options.",
        );
    }
    return { kind: "objectLiteral", properties, span: spanFrom(mode.span, endSpan) };
  }

  /**
   * `skippable` and `unskippable` predate their modifier meaning as ordinary
   * identifiers. Keep that interpretation whenever the existing say grammar
   * can consume a complete value (and optional pacing) from this position,
   * also one that recovered from an error, such as a string with a failed
   * interpolation.
   */
  *#canParseCompleteSayValue(statement: boolean): ParseTask<boolean> {
    const speculative = new Parser(this.tokens, this.#shared);
    speculative.#current = this.#current;

    const value = yield* parseChild(speculative.#parseOr());
    if (value === null) return false;
    // A unit after the word itself, as in `say bubble() s` or `say skippable ms`, is the earlier modifier followed by
    // text whose name is a unit word.
    if (unitAfterWord(value, this.#peek())) return false;

    if (speculative.#match(TokenKind.Comma)) {
      if (speculative.#canParseInstantPacingAlias(statement)) {
        speculative.#advance();
      } else {
        const pacing = yield* parseChild(speculative.#parseOr());
        if (pacing === null) return false;
      }
    }

    return speculative.#isSayBoundary(statement);
  }

  /**
   * Whether the `(` here, after a `say` statement's mode and skip word, holds the text and pacing of its bounded form: a
   * comma follows its first value, also one that recovered from an error, such as a string with a failed interpolation.
   * Grouping parentheses, valid or not, hold one value.
   */
  *#opensBoundedSayText(): ParseTask<boolean> {
    const speculative = new Parser(this.tokens, this.#shared);
    speculative.#current = this.#current + 1;
    speculative.#skipNewlines();
    const value = yield* parseChild(speculative.#withinDelimiters(speculative.#parseOr()));
    if (value === null) return false;
    speculative.#skipNewlines();
    return speculative.#check(TokenKind.Comma);
  }

  /** The end of a compact `say`: of its statement, or as a value also of an enclosing `()` or `[]`. */
  #isSayBoundary(statement: boolean): boolean {
    return (
      this.#check(TokenKind.Newline) ||
      this.#check(TokenKind.RightBrace) ||
      this.#check(TokenKind.EndOfFile) ||
      (!statement &&
        (this.#check(TokenKind.RightParenthesis) || this.#check(TokenKind.RightBracket)))
    );
  }

  /** `instant` remains an identifier unless it fills the entire pacing slot. */
  #canParseInstantPacingAlias(statement: boolean): boolean {
    if (!this.#checkIdentifier("instant")) return false;
    const speculative = new Parser(this.tokens, this.#shared);
    speculative.#current = this.#current;
    speculative.#advance();
    return speculative.#isSayBoundary(statement);
  }

  #parseLabelStatement(): LabelStatement | null {
    const keyword = this.#advance();
    if (!this.#check(TokenKind.Identifier)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedLabelName,
        "Expected a label name after 'label'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const name = this.#identifier(this.#advance());
    return Object.freeze({ kind: "labelStatement", name, span: spanFrom(keyword.span, name.span) });
  }

  /** `goto`, `call`, or `fallback`, followed by a label, or by a quoted file path and an optional label. */
  *#parseTransferStatement(): ParseTask<
    GotoStatement | CallFileStatement | FallbackStatement | null
  > {
    const keyword = this.#advance();
    if (keyword.lexeme === "fallback" && this.#checkIdentifier("none")) {
      const none = this.#advance();
      return Object.freeze({
        kind: "fallbackStatement",
        target: null,
        span: spanFrom(keyword.span, none.span),
      });
    }
    const tagged = this.#checkIdentifier("tagged");
    const target = yield* parseChild(this.#parseTransferTarget(keyword));
    if (target === null) {
      // A statement at the start of a continued line, after a trailing comma or option name, is kept.
      if (tagged && this.#previous().kind === TokenKind.Newline && this.#atStatementStart()) {
        this.#recoveredAtStatementBoundary = true;
      } else {
        this.#synchronizeStatement();
      }
      return null;
    }
    const span = spanFrom(keyword.span, target.span);
    switch (keyword.lexeme) {
      case "goto":
        return Object.freeze({ kind: "gotoStatement", target, span });
      case "call":
        return Object.freeze({ kind: "callFileStatement", target, span });
      default:
        return Object.freeze({ kind: "fallbackStatement", target, span });
    }
  }

  *#parseTransferTarget(keyword: Token): ParseTask<TransferTarget | null> {
    // `goto tagged "punishment"` picks a file by its tags, a target computed when the statement runs (ADR 0023).
    if (this.#checkIdentifier("tagged")) {
      const query = this.#parseTaggedQuery("scripts");
      if (query === null) return null;
      return Object.freeze({ kind: "scriptTarget", expression: query, span: copySpan(query.span) });
    }
    // A computed target is a `script(...)` call or a grouped expression, as in `goto (next)`.
    if (
      this.#check(TokenKind.LeftParenthesis) ||
      (this.#checkIdentifier("script") && this.#peek(1).kind === TokenKind.LeftParenthesis)
    ) {
      const expression = this.#parseExpression();
      if (expression === null) return null;
      return Object.freeze({ kind: "scriptTarget", expression, span: copySpan(expression.span) });
    }
    if (this.#check(TokenKind.Identifier)) {
      const label = this.#identifier(this.#advance());
      return Object.freeze({ kind: "labelTarget", label, span: copySpan(label.span) });
    }
    const start = this.#peek();
    if (!this.#match(TokenKind.StringStart)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedLabelName,
        `Expected a label name or a quoted file path after '${keyword.lexeme}'.`,
      );
      return null;
    }
    const literal = yield* parseChild(this.#parseStringLiteral(start));
    if (literal === null || this.#shared.recoveredStrings.has(literal)) return null;
    if (literal.form !== "singleLine" || literal.parts.some((part) => part.kind !== "stringText")) {
      this.#reportSpan(
        parserDiagnosticCode.expectedLabelName,
        "A file path is plain text in quotes. To build a path from values, use script(...).",
        literal.span,
      );
      return null;
    }
    const path = literal.parts
      .map((part) => (part.kind === "stringText" ? part.value : ""))
      .join("");
    const label = this.#check(TokenKind.Identifier) ? this.#identifier(this.#advance()) : null;
    return Object.freeze({
      kind: "fileTarget",
      path,
      pathSpan: copySpan(literal.span),
      label,
      span: spanFrom(literal.span, (label ?? literal).span),
    });
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
        "Wait uses command syntax. Write 'wait 1 s'.",
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
    const { duration: delay, unit } = this.#timerDuration(duration, "wait");
    return Object.freeze({
      kind: "waitStatement",
      duration: delay,
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
    const written = this.#parseExpression();
    if (written === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected a timer duration such as '30 s' or '(5..10) s' after 'timer'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    let end = written.span;
    const { duration, unit } = this.#timerDuration(written, "timer");
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

  /**
   * A wait or timer keeps the exact unit after its duration apart, because only they take a range with a unit:
   * `timer (5..10) min` draws whole minutes. A calendar unit stays with its operand, which a wait or timer refuses like
   * any calendar duration. A unit after the end of an unparenthesized range, as in `timer 5..10 s`, belongs to the end
   * alone, so the range must be in parentheses.
   */
  #timerDuration(
    written: Expression,
    command: "wait" | "timer" | "duration:",
  ): { duration: Expression; unit: DurationUnit | null } {
    if (written.kind === "unitExpression" && !written.calendar)
      return { duration: written.operand, unit: written.unit };
    if (
      written.kind !== "rangeExpression" ||
      (written.end.kind !== "durationLiteral" && written.end.kind !== "unitExpression")
    )
      return { duration: written, unit: null };
    const end = written.end.kind === "durationLiteral" ? written.end.amount : written.end.operand;
    const range = `${this.#textOf(written.start.span, end.span)}`;
    const unit = this.#textOf(written.end.unitSpan, written.end.unitSpan);
    this.#reportSpan(
      parserDiagnosticCode.unsupportedDurationUnit,
      `A unit after a range belongs to its end alone. Put the range in parentheses, as in '${command} (${range}) ${unit}'.`,
      written.span,
    );
    return {
      duration: Object.freeze({ ...written, end, span: spanFrom(written.start.span, end.span) }),
      unit: written.end.calendar ? null : written.end.unit,
    };
  }

  /** The source text from the start of `first` to the end of `last`, from tokens already read. */
  #textOf(first: SourceSpan, last: SourceSpan): string {
    // Tokens are in source order, so the first one is found by halving, whatever was read since.
    let low = 0;
    let high = this.#current;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.tokens[middle]!.span.start.offset < first.start.offset) low = middle + 1;
      else high = middle;
    }
    let end = low;
    while (end < this.#current && this.tokens[end]!.span.end.offset <= last.end.offset) end += 1;
    return this.#sourceText(low, end);
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
            `Unknown timer argument '${name}'. Use duration, async, display, label, repeat, or persist.`,
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
    const parts = this.#timerDuration(duration, "duration:");
    return {
      form: "named",
      async: flags.async,
      display,
      duration: parts.duration,
      unit: parts.unit,
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

  /**
   * `showPermanentButton <text>[, persist: true|false] { ... }`: the text and its options are followed by the required
   * block with the click action.
   */
  *#parseShowPermanentButtonParts(): ParseTask<ShowPermanentButtonParts | null> {
    const command = this.#advance();
    if (
      this.#rejectAdjacentParenthesis(
        command,
        "showPermanentButton uses command syntax, such as 'showPermanentButton \"Stop\" { goto stopped }'.",
      )
    ) {
      // The block belongs to the rejected command.
      if (this.#check(TokenKind.LeftBrace)) this.#skipMalformedBlock();
      return null;
    }
    const enclosing = this.#blockEndsCompactInteraction;
    this.#blockEndsCompactInteraction = true;
    const textStart = this.#current;
    const text = yield* parseChild(this.#parseOr());
    const textEnd = this.#current;
    const options = text === null ? null : yield* parseChild(this.#parsePermanentButtonOptions());
    this.#blockEndsCompactInteraction = enclosing;
    if (text === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedInteractionText,
        "Expected button text after 'showPermanentButton'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    if (!this.#check(TokenKind.LeftBrace)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedBlock,
        "Expected '{' with what the button does when clicked, such as 'showPermanentButton \"Stop\" { goto stopped }'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const handler = yield* parseChild(
      this.#asStatements(this.#parsePermanentButtonBlock(text, textStart, textEnd)),
    );
    if (handler === null || options === null) return null;
    return {
      text,
      persist: options.persist,
      handler,
      commandSpan: copySpan(command.span),
      span: spanFrom(command.span, handler.span),
    };
  }

  /** The named options after the button text, each after a comma; `null` reports an already diagnosed failure. */
  *#parsePermanentButtonOptions(): ParseTask<{ persist: boolean } | null> {
    let persist = false;
    let valid = true;
    const seen = new Set<string>();
    for (
      let offset = this.#offsetAfterComma();
      offset !== null &&
      this.#peek(offset).kind === TokenKind.Identifier &&
      this.#peek(offset + 1).kind === TokenKind.Colon;
      offset = this.#offsetAfterComma()
    ) {
      for (let skipped = 0; skipped < offset; skipped += 1) this.#advance();
      const name = this.#advance();
      this.#advance();
      // A missing value leaves the block, also one on the next line, to the button.
      let blockOffset = 0;
      while (this.#peek(blockOffset).kind === TokenKind.Newline) blockOffset += 1;
      const atBlock = this.#peek(blockOffset).kind === TokenKind.LeftBrace;
      if (atBlock) this.#skipNewlines();
      const value = atBlock ? null : yield* parseChild(this.#parseColonValueTask(false));
      if (value === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          `Expected true or false after '${name.lexeme}:'.`,
        );
        valid = false;
      } else if (seen.has(name.lexeme)) {
        this.#reportSpan(
          parserDiagnosticCode.invalidMediaForm,
          `Duplicate showPermanentButton option '${name.lexeme}'.`,
          name.span,
        );
        valid = false;
      } else if (name.lexeme !== "persist") {
        this.#reportSpan(
          parserDiagnosticCode.invalidMediaForm,
          `Unknown showPermanentButton option '${name.lexeme}'. The only option is 'persist'.`,
          name.span,
        );
        valid = false;
      } else if (value.kind !== "booleanLiteral") {
        this.#reportSpan(
          parserDiagnosticCode.invalidMediaForm,
          "showPermanentButton option 'persist' must be the literal true or false.",
          value.span,
        );
        valid = false;
      } else {
        persist = value.value;
      }
      seen.add(name.lexeme);
    }
    return valid ? { persist } : null;
  }

  /**
   * The click action of a permanent button. A first line `persist: ...`, the earlier spelling of the option, is reported
   * with the command that replaces it; `text` is the button text, written by the tokens from `textStart` to `textEnd`.
   */
  *#parsePermanentButtonBlock(
    text: Expression,
    textStart: number,
    textEnd: number,
  ): ParseTask<Block | null> {
    const leftBrace = this.#advance();
    this.#skipNewlines();
    if (this.#checkIdentifier("persist") && this.#peek(1).kind === TokenKind.Colon) {
      let written = this.#sourceText(textStart, textEnd);
      // Text such as a compact `choose` would take the option as its own, so it is grouped.
      if (!SELF_DELIMITED_EXPRESSIONS.has(text.kind)) written = `(${written})`;
      this.#reportToken(
        parserDiagnosticCode.invalidMediaForm,
        `Write 'persist:' on the command instead of in the block: 'showPermanentButton ${written}, persist: true {'.`,
        this.#peek(),
      );
      this.#synchronizeStatement(true);
      this.#finishStatement(true);
      this.#skipNewlines();
    }
    const statements: Statement[] = [];
    while (!this.#check(TokenKind.RightBrace) && !this.#check(TokenKind.EndOfFile)) {
      const startIndex = this.#current;
      const diagnosticCount = this.#diagnostics.length;
      const statement = yield* parseChild(this.#parseStatement());
      if (statement !== null) statements.push(statement);
      this.#endStatement(startIndex, diagnosticCount, true);
    }
    if (!this.#closeBlock(leftBrace)) return null;
    const span = spanFrom(leftBrace.span, this.#previous().span);
    return Object.freeze({ kind: "block", statements: Object.freeze(statements), span });
  }

  /**
   * The source of the tokens from `start` up to `end`, with one space where the source separates two of them. A line
   * break between tokens separates them too, but not right after an opening bracket or before a closing one; one inside
   * a token, as in a block string, stays.
   */
  #sourceText(start: number, end: number): string {
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
    const tagged = this.#checkIdentifier("tagged");
    const image = tagged ? this.#parseTaggedQuery("images") : this.#parseExpression();
    if (image === null) {
      if (!tagged) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an image file or null after 'showImage'.",
        );
      }
      // A statement at the start of a continued line, after a trailing comma or option name, is kept.
      if (tagged && this.#previous().kind === TokenKind.Newline && this.#atStatementStart()) {
        this.#recoveredAtStatementBoundary = true;
      } else {
        this.#synchronizeStatement(true);
      }
      return null;
    }
    return Object.freeze({
      kind: "showImageStatement",
      image,
      span: spanFrom(command.span, image.span),
    });
  }

  /**
   * `showImage tagged "bedroom", "punishment" > 3, none: ["outdoor"]` or `goto tagged "punishment", from: "rooms/*.tease"`:
   * comma-separated tag predicates, then `all:`, `none:`, or `any:` options, and for scripts `from:`. A candidate
   * needs all of them (ADR 0023).
   */
  #parseTaggedQuery(catalog: TagQueryExpression["catalog"]): TagQueryExpression | null {
    const tagged = this.#advance();
    const example =
      catalog === "images" ? 'showImage tagged "bedroom"' : 'goto tagged "punishment"';
    if (this.#check(TokenKind.Newline) || this.#check(TokenKind.EndOfFile)) {
      this.#reportInsertion(
        parserDiagnosticCode.invalidTagQuery,
        `Expected a tag after 'tagged', such as ${example}.`,
      );
      return null;
    }
    const filters: TagQueryStep[][] = [];
    const options = new Set<string>();
    let from: TagQueryExpression["from"] = null;
    let end = tagged.span;
    do {
      this.#skipNewlines();
      // A statement on the line after a trailing comma is not a tag; the caller keeps it.
      if (this.#previous().kind === TokenKind.Newline && this.#atStatementStart()) {
        this.#reportInsertion(parserDiagnosticCode.invalidTagQuery, "Expected a tag after ','.");
        return null;
      }
      if (isPropertyName(this.#peek()) && this.#peek(1).kind === TokenKind.Colon) {
        const name = this.#advance();
        this.#advance();
        const value = runParse(this.#parseColonValueTask(true));
        if (value === null) return null;
        end = value.span;
        if (catalog === "scripts" && name.lexeme === "from") {
          from = this.#tagQueryFrom(value, name.span, options);
          if (from === null) return null;
          continue;
        }
        const filter = this.#tagListFilter(
          name.lexeme,
          name.span,
          value,
          options,
          `tagged takes all:, none:, ${catalog === "scripts" ? "any:, and from:" : "and any:"}.`,
        );
        if (filter === null) return null;
        filters.push([filter]);
        continue;
      }
      if (options.size > 0) {
        this.#reportToken(
          parserDiagnosticCode.invalidTagQuery,
          `Write the tags before all:, none:, ${catalog === "scripts" ? "any:, or from:" : "or any:"}.`,
          this.#peek(),
        );
        return null;
      }
      const predicate = runParse(this.#parseRequiredExpressionTask());
      if (predicate === null) return null;
      const steps = this.#tagPredicate(predicate);
      if (steps === null) return null;
      filters.push(steps);
      end = predicate.span;
    } while (this.#match(TokenKind.Comma));
    return tagQuery(catalog, "random", filters, from, spanFrom(tagged.span, end));
  }

  /**
   * `findImages(where: …, all: …, none: …, any: …)` or `findScripts(…, from: …)` after its `(`: the list of matches
   * (ADR 0023). After a reported error it is the plain call, so the surrounding expression still parses.
   */
  *#finishFindQuery(
    callee: Expression,
    left: Token,
    catalog: TagQueryExpression["catalog"],
  ): ParseTask<TagQueryExpression | CallExpression> {
    const call = yield* parseChild(this.#finishCall(callee, left));
    const name = catalog === "images" ? "findImages" : "findScripts";
    const takes = `${name} takes where:, all:, none:, ${catalog === "scripts" ? "any:, and from:" : "and any:"}.`;
    const filters: TagQueryStep[][] = [];
    const options = new Set<string>();
    let from: TagQueryExpression["from"] = null;
    for (const argument of call.arguments) {
      if (argument.kind === "positionalArgument") {
        this.#reportSpan(
          parserDiagnosticCode.invalidTagQuery,
          `${name} takes named arguments: ${takes.slice(name.length + " takes ".length)}`,
          argument.span,
        );
        return call;
      }
      const option = argument.name.name;
      if (option === "where") {
        if (options.has(option)) {
          this.#reportSpan(
            parserDiagnosticCode.invalidTagQuery,
            "The option 'where' appears more than once. Combine the tags with 'and'.",
            argument.name.span,
          );
          return call;
        }
        options.add(option);
        const steps = this.#tagPredicate(argument.value);
        if (steps === null) return call;
        filters.push(steps);
        continue;
      }
      if (catalog === "scripts" && option === "from") {
        from = this.#tagQueryFrom(argument.value, argument.name.span, options);
        if (from === null) return call;
        continue;
      }
      const filter = this.#tagListFilter(
        option,
        argument.name.span,
        argument.value,
        options,
        takes,
      );
      if (filter === null) return call;
      filters.push([filter]);
    }
    return tagQuery(catalog, "list", filters, from, call.span);
  }

  /** A script query's `from:`: a path or glob written out in quotes, as for `goto` (ADR 0022). */
  #tagQueryFrom(
    value: Expression,
    nameSpan: SourceSpan,
    options: Set<string>,
  ): TagQueryExpression["from"] {
    if (options.has("from")) {
      this.#reportSpan(
        parserDiagnosticCode.invalidTagQuery,
        "The option 'from' appears more than once.",
        nameSpan,
      );
      return null;
    }
    options.add("from");
    if (value.kind === "stringLiteral" && this.#shared.recoveredStrings.has(value)) return null;
    if (
      value.kind !== "stringLiteral" ||
      value.form !== "singleLine" ||
      value.parts.some((part) => part.kind !== "stringText")
    ) {
      this.#reportSpan(
        parserDiagnosticCode.invalidTagQuery,
        'from: takes a file path or glob written out in quotes, such as from: "modules/*.tease".',
        value.span,
      );
      return null;
    }
    return Object.freeze({
      pattern: value.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join(""),
      span: copySpan(value.span),
    });
  }

  #tagPredicate(predicate: Expression): TagQueryStep[] | null {
    return tagPredicateSteps(
      predicate,
      (message, span) => this.#reportSpan(parserDiagnosticCode.invalidTagQuery, message, span),
      (literal) => this.#shared.recoveredStrings.has(literal),
    );
  }

  /** An `all:`, `none:`, or `any:` option; each may appear once. */
  #tagListFilter(
    name: string,
    nameSpan: SourceSpan,
    value: Expression,
    options: Set<string>,
    takes: string,
  ): TagQueryStep | null {
    if (!isTagListOption(name)) {
      this.#reportSpan(
        parserDiagnosticCode.invalidTagQuery,
        `Unknown option '${name}'. ${takes}`,
        nameSpan,
      );
      return null;
    }
    if (options.has(name)) {
      this.#reportSpan(
        parserDiagnosticCode.invalidTagQuery,
        `The option '${name}' appears more than once.`,
        nameSpan,
      );
      return null;
    }
    options.add(name);
    return Object.freeze({
      kind: "tagList",
      option: name,
      value,
      span: spanFrom(nameSpan, value.span),
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
   * `load(<key>[, default: <value>])`, or the compact `load <key>[, default: <value>]`, whose operands are full
   * expressions, so `(load "k") == null` needs parentheses. Like the prefill of an ask, the compact `, default:` binds to
   * the nearest `load` before it. The default is evaluated only when the key is absent.
   */
  *#parseLoadExpression(): ParseTask<LoadExpression | null> {
    const command = this.#advance();
    // Whitespace does not matter: `load ("k")` is the bounded form too, so its `)` ends the load.
    if (this.#check(TokenKind.LeftParenthesis)) {
      const call = yield* parseChild(
        this.#withinDelimiters(this.#finishCall(this.#identifier(command), this.#advance())),
      );
      const parts = this.#boundedArguments(
        command,
        call,
        ["default"],
        parserDiagnosticCode.invalidLoadForm,
      );
      if (parts === null) return null;
      if (parts.value === null) {
        this.#reportSpan(
          parserDiagnosticCode.expectedStorageKey,
          "Expected a storage key in 'load(...)', such as 'load(\"name\", default: \"\")'.",
          call.span,
        );
        return null;
      }
      return Object.freeze({
        kind: "loadExpression",
        key: parts.value,
        defaultValue: parts.options.get("default") ?? null,
        span: copySpan(call.span),
      });
    }
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
    } else if (defaultOffset !== null && this.#atNamedDefault(defaultOffset)) {
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

  /**
   * The arguments of a bounded command form such as `load("k", default: 0)`: at most one unnamed value, which comes
   * first, and each option of `names` at most once. `null` reports an already diagnosed failure.
   */
  #boundedArguments(
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
          this.#reportSpan(
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
        this.#reportSpan(
          code,
          `Unknown ${command.lexeme} option '${name}'. Use ${names.map((known) => `'${known}:'`).join(" or ")}.`,
          argument.name.span,
        );
        valid = false;
      } else if (options.has(name)) {
        this.#reportSpan(code, `Duplicate ${command.lexeme} option '${name}'.`, argument.name.span);
        valid = false;
      } else {
        options.set(name, argument.value);
      }
    }
    return valid ? { value, options } : null;
  }

  /** `showCamera [stage]`: the contextual word `stage` directly after the command places the view over the Stage. */
  #parseShowCameraParts(): { placement: CameraPlacement; span: SourceSpan } | null {
    const command = this.#advance();
    if (
      this.#rejectAdjacentParenthesis(
        command,
        "showCamera uses command syntax. Write 'showCamera' or 'showCamera stage'.",
      )
    )
      return null;
    if (!this.#checkIdentifier("stage"))
      return { placement: "window", span: copySpan(command.span) };
    const word = this.#advance();
    return { placement: "stage", span: spanFrom(command.span, word.span) };
  }

  #parseHideCameraStatement(): HideCameraStatement | null {
    const command = this.#advance();
    if (
      this.#rejectAdjacentParenthesis(command, "hideCamera takes no arguments. Write 'hideCamera'.")
    )
      return null;
    return Object.freeze({ kind: "hideCameraStatement", span: copySpan(command.span) });
  }

  #parseHideImageStatement(): HideImageStatement | null {
    const command = this.#advance();
    if (
      this.#rejectAdjacentParenthesis(command, "hideImage takes no arguments. Write 'hideImage'.")
    )
      return null;
    return Object.freeze({ kind: "hideImageStatement", span: copySpan(command.span) });
  }

  /**
   * `stopAudio` stops every sound and takes no arguments. Anything after it on the line is reported and skipped; an
   * enclosing block keeps its closing brace.
   */
  #parseStopAudioStatement(): StopAudioStatement | null {
    const command = this.#advance();
    let braces = 0;
    const atEnd = () =>
      this.#check(TokenKind.Newline) ||
      this.#check(TokenKind.EndOfFile) ||
      (braces === 0 && this.#check(TokenKind.RightBrace));
    if (atEnd()) return Object.freeze({ kind: "stopAudioStatement", span: copySpan(command.span) });
    const first = this.#peek();
    let last = first;
    while (!atEnd()) {
      last = this.#advance();
      if (last.kind === TokenKind.LeftBrace) braces += 1;
      else if (last.kind === TokenKind.RightBrace) braces -= 1;
    }
    this.#reportSpan(
      parserDiagnosticCode.invalidMediaForm,
      "stopAudio takes no arguments. To stop one sound, keep its handle and call stop() on it.",
      spanFrom(first.span, last.span),
    );
    return null;
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
    let braces = 0;
    while (!this.#check(TokenKind.Newline) && !this.#check(TokenKind.EndOfFile)) {
      // An unclosed group never takes the closing brace of an enclosing block on the same line; braces opened inside
      // the group, as in an object argument, close there.
      if (depth > 0 && braces === 0 && this.#check(TokenKind.RightBrace)) break;
      const token = this.#advance();
      if (token.kind === TokenKind.LeftBrace) braces += 1;
      else if (token.kind === TokenKind.RightBrace) braces -= 1;
      else if (token.kind === TokenKind.LeftParenthesis) depth += 1;
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
            `Unknown ${command.lexeme} argument '${name.name}'. Use ${MEDIA_ARGUMENTS.join(", ")}.`,
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
      this.#reportMissingCloser(
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
      const diagnosticCount = this.#diagnostics.length;
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
      this.#endStatement(startIndex, diagnosticCount, true);
    }
    if (!this.#closeBlock(leftBrace)) return false;
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

  /**
   * `global function ...`, or `global name[: Type] = value[, default: start]`. Like the prefill of an ask, a
   * `, default:` belongs to the nearest construct before it that takes one, so `global level = load "level", default: 1`
   * gives the fallback to `load`.
   */
  *#parseGlobalStatement(): ParseTask<GlobalStatement | FunctionDeclaration | null> {
    const keyword = this.#advance();
    if (this.#check(TokenKind.KeywordFunction))
      return yield* parseChild(this.#parseFunctionDeclaration(keyword));
    if (!this.#checkDeclarationName()) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedIdentifier,
        "Expected a variable identifier or 'function' after 'global'.",
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
        "Expected '=' in the global declaration.",
      );
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const value = this.#parseRequiredExpression();
    if (value === null) {
      this.#synchronizeStatement();
      return null;
    }
    const defaultOffset = this.#offsetAfterComma();
    if (defaultOffset === null || !this.#atNamedDefault(defaultOffset))
      return Object.freeze({
        kind: "globalStatement",
        name,
        typeAnnotation,
        initial: value,
        assignment: null,
        span: spanFrom(keyword.span, value.span),
      });
    for (let skipped = 0; skipped < defaultOffset + 2; skipped += 1) this.#advance();
    const start = yield* parseChild(this.#parseColonValueTask(true));
    if (start === null) {
      this.#synchronizeStatement();
      return null;
    }
    const span = spanFrom(keyword.span, start.span);
    return Object.freeze({
      kind: "globalStatement",
      name,
      typeAnnotation,
      initial: start,
      assignment: Object.freeze({
        kind: "assignmentStatement",
        operator: "=",
        target: name,
        value,
        span: copySpan(span),
      }),
      span,
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

  /** A type name or a parenthesized type, followed by any number of `[]`, `set`, `dict`, and `?` in source order. */
  *#parsePostfixTypeTask(context: TypeContext): ParseTask<TypeAnnotation | null> {
    const first = this.#peek();
    let type: TypeAnnotation;
    if (this.#match(TokenKind.LeftParenthesis)) {
      this.#skipContinuationNewlines();
      const inner = yield* parseChild(this.#parseTypeTask("delimited"));
      if (inner === null) return null;
      this.#skipContinuationNewlines();
      if (!this.#match(TokenKind.RightParenthesis)) {
        this.#reportMissingCloser(
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
      const renamed = RENAMED_TYPE_NAMES.get(first.lexeme);
      if (first.kind === TokenKind.Identifier && renamed !== undefined)
        this.#reportToken(
          parserDiagnosticCode.invalidType,
          `'${first.lexeme}' is not a type. Use '${renamed}'.`,
          first,
        );
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
      } else if (this.#matchDictTypeOperator(context)) {
        type = Object.freeze({
          kind: "dictType",
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

  /** Matches the contextual type operator `dict` in `T dict`, which is a name rather than a keyword token. */
  #matchDictTypeOperator(context: TypeContext): boolean {
    let offset = 0;
    if (context === "delimited" || context === "delimitedTypeTest") {
      while (this.#peek(offset).kind === TokenKind.Newline) offset += 1;
    }
    const token = this.#peek(offset);
    if (token.kind !== TokenKind.Identifier || token.lexeme !== "dict") return false;
    this.#skipContinuationNewlines();
    this.#advance();
    return true;
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
    const condition = this.#parseBlockHead();
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
    const subject = this.#parseBlockHead();
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
        let typeTest: SwitchTypeTest | null = null;
        let values: readonly Expression[] | null = Object.freeze([]);
        if (this.#check(TokenKind.KeywordIs)) {
          typeTest = yield* parseChild(this.#parseCaseTypeTestTask());
          if (typeTest === null) values = null;
        } else {
          values = this.#parseCaseValues();
        }
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
                typeTest,
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

  /** `is T` or `is not T` after `case`: one type, or a union for several, as in `case is integer | string`. */
  *#parseCaseTypeTestTask(): ParseTask<SwitchTypeTest | null> {
    const keyword = this.#advance();
    this.#skipContinuationNewlines();
    const negated = this.#match(TokenKind.KeywordNot);
    this.#skipContinuationNewlines();
    if (this.#atComparedValue()) {
      this.#reportToken(
        parserDiagnosticCode.invalidType,
        "'case is' checks a type. To compare with a value, write the value itself, as in 'case \"open\"'.",
        this.#peek(),
      );
      return null;
    }
    const type = yield* parseChild(this.#parseTypeTask("typeTest"));
    if (type === null) return null;
    if (this.#check(TokenKind.Comma)) {
      this.#reportToken(
        parserDiagnosticCode.invalidSwitchForm,
        "A type case tests one type. For several, write a union, as in 'case is integer | string'.",
        this.#peek(),
      );
      return null;
    }
    return Object.freeze({
      kind: "switchTypeTest",
      type,
      negated,
      span: spanFrom(keyword.span, type.span),
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
    const count = this.#parseBlockHead();
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
    // `for key, value in dict`: the second name receives each entry's value.
    let valueVariable: Identifier | null = null;
    if (this.#match(TokenKind.Comma)) {
      // A line may break after the comma (V30 §1) before `value in`; another next line stays for recovery.
      let offset = 0;
      while (this.#peek(offset).kind === TokenKind.Newline) offset += 1;
      const next = this.#peek(offset).kind;
      if (
        (next === TokenKind.Identifier || next === TokenKind.KeywordSet) &&
        this.#peek(offset + 1).kind === TokenKind.KeywordIn
      )
        this.#skipNewlines();
      if (!this.#checkDeclarationName()) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedIdentifier,
          "Expected a value-variable identifier after ',', as in 'for key, value in dict'.",
        );
        this.#synchronizeStatement();
        return null;
      }
      valueVariable = this.#identifier(this.#advance());
    }
    if (!this.#match(TokenKind.KeywordIn)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedIn,
        valueVariable === null
          ? "Expected 'in' after the loop variable."
          : "Expected 'in' after the loop variables.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const iterable = this.#parseBlockHead();
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
      valueVariable,
      iterable,
      body,
      span: spanFrom(keyword.span, body.span),
    });
  }

  *#parseWhileStatement(): ParseTask<WhileStatement | null> {
    const keyword = this.#advance();
    const condition = this.#parseBlockHead();
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

  /** A function declaration; `globalKeyword` is the `global` before a global function. */
  *#parseFunctionDeclaration(globalKeyword: Token | null): ParseTask<FunctionDeclaration | null> {
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
        this.#reportMissingCloser(
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
      global: globalKeyword !== null,
      name,
      parameters: Object.freeze(parameters),
      returnTypeAnnotation,
      body,
      span: spanFrom((globalKeyword ?? keyword).span, body.span),
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
      const diagnosticCount = this.#diagnostics.length;
      const statement = yield* parseChild(this.#parseStatement());
      if (statement !== null) statements.push(statement);
      this.#endStatement(startIndex, diagnosticCount, true);
    }
    if (!this.#closeBlock(leftBrace)) return null;
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
    if (
      expression.kind !== "callExpression" &&
      !(expression.kind === "tagQueryExpression" && expression.select === "list") &&
      // `askBooleans(...)` was a call, which a statement may discard the answer of.
      !(expression.kind === "interactionExpression" && expression.interactionKind === "booleans")
    ) {
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

  /**
   * The expression before the block of `if`, `while`, `repeat`, `for`, or `switch`, where the block's `{` ends a compact
   * interaction, so `if askBoolean { ... }` asks without a question.
   */
  #parseBlockHead(): Expression | null {
    const enclosing = this.#blockEndsCompactInteraction;
    this.#blockEndsCompactInteraction = true;
    try {
      return this.#parseRequiredExpression();
    } finally {
      this.#blockEndsCompactInteraction = enclosing;
    }
  }

  #parseExpression(): Expression | null {
    return runParse(this.#parseOr());
  }

  *#parseRequiredExpressionTask(): ParseTask<Expression | null> {
    const diagnosticCount = this.#diagnostics.length;
    const expression = yield* parseChild(this.#parseOr());
    // A failed expression that already reported its own error needs no generic one after it.
    if (expression === null && this.#diagnostics.length === diagnosticCount) {
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
        "'is' checks a type. Use '==' to compare values.",
        compared?.span ?? first.span,
      );
      return value;
    }
    const type = yield* parseChild(
      this.#parseTypeTask(
        this.#shared.bracketed[this.#current] === true ? "delimitedTypeTest" : "typeTest",
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
    const start = this.#current;
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
        if (
          expression.kind === "identifier" &&
          (expression.name === "findImages" || expression.name === "findScripts")
        ) {
          expression = yield* parseChild(
            this.#withinDelimiters(
              this.#finishFindQuery(
                expression,
                this.#previous(),
                expression.name === "findImages" ? "images" : "scripts",
              ),
            ),
          );
          continue;
        }
        expression = yield* parseChild(
          this.#withinDelimiters(this.#finishCall(expression, this.#previous())),
        );
        continue;
      }
      break;
    }
    return expression === null ? null : this.#parseUnitSuffix(expression, start);
  }

  /**
   * A unit after a name, a member such as `p.delay` or `list[i]`, a call, or parentheses gives the number before it
   * that unit, as a number literal takes one: `count s`, `(count / 2) min`, `randomInteger(5..=10) s` (ADR 0026 §8).
   * It binds tighter than `*` and `+`, so `a + b s` is `a + (b s)`. One duration has one unit: a second unit or a
   * second amount right after it is an error, and parts are added with `+`.
   */
  #parseUnitSuffix(expression: Expression, start: number): Expression {
    let result = expression;
    const token = this.#peek();
    if (UNIT_OPERANDS.has(expression.kind) && token.kind === TokenKind.Identifier) {
      const withUnit = (
        unit:
          | { readonly calendar: false; readonly unit: DurationUnit }
          | { readonly calendar: true; readonly unit: CalendarDurationUnit },
        last: Token,
      ): UnitExpression =>
        Object.freeze({
          kind: "unitExpression",
          operand: expression,
          ...unit,
          unitSpan: spanFrom(token.span, last.span),
          span: spanFrom(expression.span, last.span),
        });
      const exact = elapsedDurationUnit(token.lexeme);
      const after = this.#peek(1);
      const calendar =
        token.lexeme === "calendar" && after.kind === TokenKind.Identifier
          ? calendarDurationUnit(after.lexeme)
          : undefined;
      // A month or a year written out needs `calendar` here too. A short `mo` or `y` stays a name, as in `${x y}`.
      const withoutCalendar =
        token.lexeme.length > 2 ? calendarDurationUnit(token.lexeme) : undefined;
      if (exact !== undefined) {
        this.#advance();
        result = withUnit({ calendar: false, unit: exact }, token);
      } else if (calendar !== undefined) {
        this.#advance();
        result = withUnit({ calendar: true, unit: calendar }, this.#advance());
      } else if (withoutCalendar !== undefined) {
        this.#reportCalendarUnitWithoutCalendar(this.#sourceText(start, this.#current), token);
        result = withUnit({ calendar: true, unit: withoutCalendar }, this.#advance());
      }
    }
    if (result.kind !== "durationLiteral" && result.kind !== "unitExpression") return result;
    // `5 s ms` or `1 h 30 min`: the parts of a duration are added with `+`.
    const next = this.#peek();
    const unitWord = (candidate: Token): boolean =>
      candidate.kind === TokenKind.Identifier &&
      (candidate.lexeme === "calendar" ||
        elapsedDurationUnit(candidate.lexeme) !== undefined ||
        calendarDurationUnit(candidate.lexeme) !== undefined);
    if (unitWord(next)) {
      this.#advance();
      this.#reportToken(
        parserDiagnosticCode.unsupportedDurationUnit,
        `This duration already has a unit. Remove the '${next.lexeme}' after it.`,
        next,
      );
    } else if (next.kind === TokenKind.NumberLiteral && unitWord(this.#peek(1))) {
      this.#advance();
      this.#advance();
      this.#reportSpan(
        parserDiagnosticCode.unsupportedDurationUnit,
        "Add the parts of a duration with '+', as in '1 h + 30 min'.",
        spanFrom(next.span, this.#previous().span),
      );
    }
    return result;
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
      this.#reportMissingCloser(
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

  /**
   * A unit identifier directly after a number literal on the same line forms a duration literal: an exact unit, or
   * `calendar` and a calendar unit (ADR 0026). A month or year without `calendar` is an error that suggests it.
   */
  #parseDurationUnit(amount: NumberLiteral): Expression {
    if (!this.#check(TokenKind.Identifier)) return amount;
    const token = this.#peek();
    const literal = (
      unit:
        | { readonly calendar: false; readonly unit: DurationUnit }
        | { readonly calendar: true; readonly unit: CalendarDurationUnit },
      last: Token,
    ): Expression =>
      Object.freeze({
        kind: "durationLiteral",
        amount,
        ...unit,
        unitSpan: copySpan(last.span),
        span: spanFrom(amount.span, last.span),
      });
    if (token.lexeme === "calendar") {
      this.#advance();
      const next = this.#peek();
      const unit =
        next.kind === TokenKind.Identifier ? calendarDurationUnit(next.lexeme) : undefined;
      if (unit === undefined) {
        this.#reportToken(
          parserDiagnosticCode.unsupportedDurationUnit,
          "Expected a calendar unit after 'calendar': day, week, month, or year.",
          token,
        );
        return amount;
      }
      return literal({ calendar: true, unit }, this.#advance());
    }
    const exact = elapsedDurationUnit(token.lexeme);
    if (exact !== undefined) return literal({ calendar: false, unit: exact }, this.#advance());
    const calendar = calendarDurationUnit(token.lexeme);
    if (calendar === undefined) return amount;
    this.#reportCalendarUnitWithoutCalendar(amount.raw, token);
    return literal({ calendar: true, unit: calendar }, this.#advance());
  }

  /** A month or a year after `amount` without `calendar`; days and weeks are exact units. */
  #reportCalendarUnitWithoutCalendar(amount: string, unit: Token): void {
    this.#reportToken(
      parserDiagnosticCode.unsupportedDurationUnit,
      `A ${calendarDurationUnit(unit.lexeme) === "mo" ? "month" : "year"} has no fixed length. Write '${amount} calendar ${unit.lexeme}'.`,
      unit,
    );
  }

  *#parsePrimary(): ParseTask<Expression | null> {
    const token = this.#peek();
    if (
      this.#checkIdentifier("askText") ||
      this.#checkIdentifier("askNumber") ||
      this.#checkIdentifier("askInteger") ||
      this.#checkIdentifier("askDate") ||
      this.#checkIdentifier("askTime") ||
      this.#checkIdentifier("askDateTime") ||
      this.#checkIdentifier("askBoolean") ||
      this.#checkIdentifier("askForm") ||
      this.#checkIdentifier("askBooleans") ||
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
    if (this.#checkIdentifier("showCamera")) {
      const parts = this.#parseShowCameraParts();
      return parts === null ? null : Object.freeze({ kind: "showCameraExpression", ...parts });
    }
    if (this.#checkIdentifier("showPermanentButton")) {
      const parts = yield* parseChild(this.#parseShowPermanentButtonParts());
      return parts === null
        ? null
        : Object.freeze({ kind: "showPermanentButtonExpression", ...parts });
    }
    if (this.#checkIdentifier("playAudio") || this.#checkIdentifier("playVideo")) {
      const parts = yield* parseChild(this.#parseMediaParts());
      return parts === null ? null : Object.freeze({ kind: "playMediaExpression", ...parts });
    }
    if (this.#checkIdentifier("load")) {
      return yield* parseChild(this.#parseLoadExpression());
    }
    // At the start of a line outside brackets, `say` begins a statement, so a value continued onto it ends before it.
    if (
      this.#check(TokenKind.KeywordSay) &&
      (this.#insideDelimiters || this.#previous()?.kind !== TokenKind.Newline)
    ) {
      const parts = yield* parseChild(this.#parseSayValue());
      return parts === null ? null : Object.freeze({ kind: "sayExpression", ...parts });
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
    if (this.#checkIdentifier("dict") && this.#peek(1).kind === TokenKind.LeftBrace) {
      this.#advance();
      this.#advance();
      return yield* parseChild(this.#withinDelimiters(this.#parseDictLiteral(token)));
    }
    // The protected constant `pi` (V30 §13) is the number it names.
    if (this.#checkIdentifier("pi")) {
      this.#advance();
      return Object.freeze({
        kind: "numberLiteral",
        raw: "pi",
        value: 3.141592653589793,
        numericType: "number",
        span: copySpan(token.span),
      });
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
    const interactionKind = INTERACTION_KINDS.get(command.lexeme) ?? "choice";
    if (this.#check(TokenKind.LeftParenthesis) && interactionKind !== "choice")
      return yield* parseChild(this.#parseBoundedAsk(command, interactionKind, null, null));
    if (this.#check(TokenKind.LeftParenthesis)) {
      this.#reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        `Parenthesized ${command.lexeme} arguments are not supported in the compact interaction syntax.`,
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
        return null;
      }
      speaker = this.#identifier(this.#advance());
    }
    if (this.#check(TokenKind.LeftParenthesis) && interactionKind !== "choice")
      return yield* parseChild(this.#parseBoundedAsk(command, interactionKind, asSpan, speaker));
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
      const names = NAMED_ASK_OPTIONS.get(interactionKind) ?? ASK_OPTIONS;
      // The earlier name of the prefill is read as an option too, so its error names the fix wherever it is written.
      const removed = removedPrefillName(interactionKind);
      const recognized = removed === null ? names : [...names, removed];
      const question =
        isExpressionStart(this.#peek()) &&
        !(this.#blockEndsCompactInteraction && this.#check(TokenKind.LeftBrace)) &&
        !this.#atStorageDelimiter() &&
        this.#askOptionAt(0, recognized) === null
          ? yield* parseChild(this.#parseOr())
          : null;
      // The named options follow in any order, each after a comma, or first without a question.
      const named: FormArgument[] = [];
      let end = question?.span ?? speaker?.span ?? command.span;
      let offset = question === null ? 0 : this.#offsetAfterComma();
      for (;;) {
        if (offset === null && this.#askOptionAt(0, recognized) !== null) {
          this.#reportInsertion(
            parserDiagnosticCode.expectedDelimiter,
            `Expected ',' before '${this.#peek().lexeme}:'.`,
          );
          offset = 0;
        }
        const option = offset === null ? null : this.#askOptionAt(offset, recognized);
        if (option === null) {
          // A form names every argument, as do askBoolean and askBooleans, so another `name:` after a comma is a
          // misspelled one.
          const unknown = offset === null ? null : this.#peek(offset);
          if (
            NAMED_ASK_OPTIONS.has(interactionKind) &&
            unknown?.kind === TokenKind.Identifier &&
            this.#peek(offset! + 1).kind === TokenKind.Colon
          ) {
            this.#reportSpan(
              parserDiagnosticCode.unsupportedInteractionForm,
              `Unknown ${command.lexeme} option '${unknown.lexeme}'. Use ${names.map((known) => `'${known}:'`).join(", ")}.`,
              unknown.span,
            );
            this.#synchronizeStatement();
          }
          break;
        }
        for (let skipped = 0; skipped < offset!; skipped += 1) this.#advance();
        const name = this.#renamedAskOption(
          command,
          interactionKind,
          this.#identifier(this.#advance()),
        );
        this.#advance();
        const value = yield* parseChild(this.#parseColonValueTask(false));
        if (value === null) {
          this.#reportInsertion(
            parserDiagnosticCode.expectedInteractionText,
            name.name === "prefill"
              ? "Expected a prefill value after 'prefill:'."
              : name.name === "hint"
                ? "Expected hint text after 'hint:'."
                : `Expected a value after '${name.name}:'.`,
          );
          if (this.#previous().kind === TokenKind.Newline && this.#atStatementStart())
            this.#recoveredAtStatementBoundary = true;
          break;
        }
        if (named.some((argument) => argument.name.name === name.name)) {
          this.#reportSpan(
            parserDiagnosticCode.unsupportedInteractionForm,
            `Duplicate ${command.lexeme} option '${name.name}'.`,
            name.span,
          );
        } else named.push(Object.freeze({ name, value }));
        end = value.span;
        offset = this.#offsetAfterComma();
      }
      if (this.#check(TokenKind.KeywordAs) && !this.#atStorageDelimiter()) {
        this.#reportSpan(
          parserDiagnosticCode.unsupportedInteractionForm,
          `The 'as speaker' clause must appear immediately after '${command.lexeme}'.`,
          this.#peek().span,
        );
        this.#synchronizeStatement();
      }
      return this.#askExpression(
        command,
        interactionKind,
        asSpan,
        speaker,
        question,
        named,
        spanFrom(command.span, end),
      );
    }

    const options: InteractionChoiceOption[] = [];
    let prefill: Expression | null = null;
    let missingChoiceOptionWasReported = false;
    while (!this.#isInteractionChoiceTerminator()) {
      // `prefill:` names the preselected button's value once, after the options, so no option is labelled `prefill`.
      if (this.#checkIdentifier("prefill") && this.#peek(1).kind === TokenKind.Colon) {
        const name = this.#advance();
        this.#advance();
        prefill = yield* parseChild(this.#parseColonValueTask(false));
        if (prefill === null) {
          this.#reportInsertion(
            parserDiagnosticCode.expectedInteractionText,
            "Expected a prefill value after 'prefill:'.",
          );
          if (this.#previous().kind === TokenKind.Newline && this.#atStatementStart())
            this.#recoveredAtStatementBoundary = true;
          break;
        }
        if (options.length === 0) {
          missingChoiceOptionWasReported = true;
          this.#reportSpan(
            parserDiagnosticCode.expectedChoiceOption,
            "choose takes one 'prefill:', after its options, as in 'choose 5, 10, prefill: 10'.",
            name.span,
          );
          this.#skipInteractionRest();
        } else if (
          !this.#isInteractionChoiceTerminator() &&
          !(this.#blockEndsCompactInteraction && this.#check(TokenKind.LeftBrace))
        ) {
          this.#reportSpan(
            parserDiagnosticCode.unsupportedInteractionForm,
            "choose takes one 'prefill:', after its options, as in 'choose 5, 10, prefill: 10'.",
            this.#peek().span,
          );
          this.#skipInteractionRest();
        }
        break;
      }
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
      // As for a prefill, inside delimiters a comma on the next line continues the options.
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
    const end = prefill?.span ?? options.at(-1)?.expression.span ?? speaker?.span ?? command.span;
    return Object.freeze({
      kind: "interactionExpression",
      interactionKind,
      commandSpan: copySpan(command.span),
      asSpan,
      speaker,
      question: null,
      hint: null,
      prefill,
      options: Object.freeze(options),
      formArguments: Object.freeze([]),
      span: spanFrom(command.span, end),
    });
  }

  /**
   * `askText [as speaker] ([question][, hint: text][, prefill: value])` and the other basic asks: the parentheses hold
   * the arguments of the compact form, so `)` ends the ask and both forms give the same interaction.
   */
  *#parseBoundedAsk(
    command: Token,
    interactionKind: Exclude<InteractionExpression["interactionKind"], "choice">,
    asSpan: SourceSpan | null,
    speaker: Identifier | null,
  ): ParseTask<InteractionExpression | null> {
    const written = yield* parseChild(
      this.#withinDelimiters(this.#finishCall(this.#identifier(command), this.#advance())),
    );
    const call: CallExpression = Object.freeze({
      ...written,
      arguments: Object.freeze(
        written.arguments.map((argument) =>
          argument.kind === "namedArgument"
            ? Object.freeze({
                ...argument,
                name: this.#renamedAskOption(command, interactionKind, argument.name),
              })
            : argument,
        ),
      ),
    });
    const parts = this.#boundedArguments(
      command,
      call,
      NAMED_ASK_OPTIONS.get(interactionKind) ?? ASK_OPTIONS,
      parserDiagnosticCode.unsupportedInteractionForm,
    );
    if (this.#check(TokenKind.KeywordAs) && !this.#atStorageDelimiter()) {
      this.#reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        `The 'as speaker' clause must appear immediately after '${command.lexeme}'.`,
        this.#peek().span,
      );
      this.#synchronizeStatement();
    }
    if (parts === null) return null;
    // The arguments were checked to be known and unique, so the named ones are the options in written order.
    const named = call.arguments.flatMap((argument) =>
      argument.kind === "namedArgument"
        ? [Object.freeze({ name: argument.name, value: argument.value })]
        : [],
    );
    return this.#askExpression(
      command,
      interactionKind,
      asSpan,
      speaker,
      parts.value,
      named,
      spanFrom(command.span, call.span),
    );
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

  /**
   * `name`, or for the earlier name of the ask's prefill, such as `default:`, the error that names the fix and `prefill`
   * at its place, so that the ask is checked as the author meant it.
   */
  #renamedAskOption(
    command: Token,
    interactionKind: InteractionExpression["interactionKind"],
    name: Identifier,
  ): Identifier {
    if (name.name !== removedPrefillName(interactionKind)) return name;
    this.#reportSpan(
      parserDiagnosticCode.unsupportedInteractionForm,
      `${command.lexeme} has no '${name.name}:'. Use 'prefill:'.`,
      name.span,
    );
    return Object.freeze({ ...name, name: "prefill" });
  }

  /** The named option of an ask among `names`, such as `hint:` or `prefill:`, at `offset` tokens ahead, or `null`. */
  #askOptionAt(offset: number, names: readonly string[]): string | null {
    const token = this.#peek(offset);
    if (token.kind !== TokenKind.Identifier || this.#peek(offset + 1).kind !== TokenKind.Colon)
      return null;
    return names.includes(token.lexeme) ? token.lexeme : null;
  }

  /**
   * A basic ask, `askForm`, `askBoolean`, or `askBooleans` from its question and named options in written order. A basic
   * ask keeps `hint:` and `prefill:`; the others keep every option, and a form needs `fields:`, or `texts:` and
   * `prefill:` for `askBooleans`.
   */
  #askExpression(
    command: Token,
    interactionKind: Exclude<InteractionExpression["interactionKind"], "choice">,
    asSpan: SourceSpan | null,
    speaker: Identifier | null,
    question: Expression | null,
    named: readonly FormArgument[],
    span: SourceSpan,
  ): InteractionExpression {
    const keepsArguments = NAMED_ASK_OPTIONS.has(interactionKind);
    const has = (name: string) => named.some((argument) => argument.name.name === name);
    if (interactionKind === "form" && !has("fields"))
      this.#reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        "askForm needs its fields, as in 'fields: { enabled: false }'.",
        command.span,
      );
    for (const required of interactionKind === "booleans" ? ["texts", "prefill"] : [])
      if (!has(required))
        this.#reportSpan(
          parserDiagnosticCode.unsupportedInteractionForm,
          `askBooleans needs ${required}:, as in 'askBooleans "Choose", texts: ["A", "B"], prefill: [true, false]'.`,
          command.span,
        );
    if (question !== null && has("message"))
      this.#reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        `${command.lexeme} has a question and 'message:'. Keep one.`,
        named.find((argument) => argument.name.name === "message")!.name.span,
      );
    const option = (name: string) =>
      keepsArguments
        ? null
        : (named.find((argument) => argument.name.name === name)?.value ?? null);
    return Object.freeze({
      kind: "interactionExpression",
      interactionKind,
      commandSpan: copySpan(command.span),
      asSpan,
      speaker,
      question,
      hint: option("hint"),
      prefill: option("prefill"),
      options: Object.freeze([]),
      formArguments: Object.freeze(keepsArguments ? [...named] : []),
      span,
    });
  }

  /** `default:` at `offset` tokens ahead, the named fallback of `load` or the session-start value of a `global`. */
  #atNamedDefault(offset: number): boolean {
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
        this.#reportMissingCloser(
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

  /** `dict{ ... }` after its `{`: entries `key: value`, where a key is a name, quoted text, or `[expression]`. */
  *#parseDictLiteral(start: Token): ParseTask<DictLiteral> {
    const entries: DictEntry[] = [];
    this.#skipNewlines();
    while (!this.#check(TokenKind.RightBrace) && !this.#check(TokenKind.EndOfFile)) {
      const keyStart = this.#peek();
      const key = yield* parseChild(this.#parseDictKey());
      if (key === null) {
        this.#synchronizeDelimited(TokenKind.RightBrace);
        break;
      }
      if (!this.#match(TokenKind.Colon)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedColon,
          "Expected ':' after the dict key.",
        );
        this.#synchronizeDelimited(TokenKind.RightBrace);
        break;
      }
      const value = yield* parseChild(this.#parseColonValueTask(true));
      if (value === null) break;
      entries.push(
        Object.freeze({ kind: "dictEntry", key, value, span: spanFrom(keyStart.span, value.span) }),
      );
      this.#skipNewlines();
      if (!this.#match(TokenKind.Comma)) break;
      this.#skipNewlines();
      if (this.#check(TokenKind.RightBrace)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedPropertyName,
          "Expected a dict entry after ','.",
        );
        break;
      }
    }
    const end = this.#consumeClosingDelimiter(
      TokenKind.RightBrace,
      "Expected '}' after the dict literal.",
    );
    return Object.freeze({
      kind: "dictLiteral",
      entries: Object.freeze(entries),
      span: spanFrom(start.span, end),
    });
  }

  /** A dict key: quoted text, `[expression]`, or a name, which is its own text. */
  *#parseDictKey(): ParseTask<Expression | null> {
    const token = this.#peek();
    if (this.#match(TokenKind.StringStart))
      return yield* parseChild(this.#parseStringLiteral(token));
    if (this.#match(TokenKind.LeftBracket)) {
      this.#skipNewlines();
      const key = yield* parseChild(this.#parseRequiredExpressionTask());
      if (key === null) return null;
      this.#skipNewlines();
      if (!this.#match(TokenKind.RightBracket)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedDelimiter,
          "Expected ']' after the computed dict key.",
        );
        return null;
      }
      return key;
    }
    if (!isPropertyName(token)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedPropertyName,
        "Expected a dict key: a name, quoted text, or [expression].",
      );
      return null;
    }
    this.#advance();
    const text: StringText = Object.freeze({
      kind: "stringText",
      raw: token.lexeme,
      value: token.lexeme,
      span: copySpan(token.span),
    });
    return Object.freeze({
      kind: "stringLiteral",
      form: "singleLine",
      parts: Object.freeze([text]),
      span: copySpan(token.span),
    });
  }

  *#parseStringLiteral(start: Token): ParseTask<StringLiteral | null> {
    const parts: StringPart[] = [];
    let valid = true;
    let recovered = false;
    while (!this.#check(TokenKind.StringEnd) && !this.#check(TokenKind.EndOfFile)) {
      if (this.#match(TokenKind.StringText)) {
        parts.push(this.#stringText(this.#previous()));
        continue;
      }
      if (this.#match(TokenKind.InterpolationStart)) {
        const diagnosticCount = this.#diagnostics.length;
        // An interpolation without an expression is left out.
        const interpolation = yield* parseChild(this.#parseStringInterpolation(this.#previous()));
        if (interpolation !== null) parts.push(interpolation);
        // Also when only the lexer reported a missing `}`.
        recovered ||=
          interpolation === null ||
          this.#diagnostics.length !== diagnosticCount ||
          this.#previous().kind !== TokenKind.InterpolationEnd;
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
    const literal: StringLiteral = Object.freeze({
      kind: "stringLiteral",
      form: start.lexeme.length === 3 ? "block" : "singleLine",
      parts: Object.freeze(parts),
      span: spanFrom(start.span, this.#previous().span),
    });
    if (recovered) this.#shared.recoveredStrings.add(literal);
    return literal;
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
    // Only a failure that reported nothing itself gets an error here.
    const reported = this.#diagnostics.length !== diagnosticCount;
    if (expression === null) {
      if (!reported) {
        this.#reportToken(
          parserDiagnosticCode.unsupportedStringExpression,
          "Expected a supported expression inside the string interpolation.",
          this.#peek(),
        );
      }
      this.#synchronizeInterpolation();
      this.#match(TokenKind.InterpolationEnd);
      return null;
    }
    this.#skipNewlines();
    if (!this.#match(TokenKind.InterpolationEnd)) {
      if (!reported && !this.#check(TokenKind.StringEnd) && !this.#check(TokenKind.EndOfFile)) {
        const message = this.#check(TokenKind.Colon)
          ? "Only identifiers and chained property access are supported in string interpolation."
          : "Only one complete expression is allowed in string interpolation.";
        this.#reportToken(parserDiagnosticCode.unsupportedStringExpression, message, this.#peek());
      }
      this.#synchronizeInterpolation();
      this.#match(TokenKind.InterpolationEnd);
    }
    // An expression that reported an error, or that more follows, stays as written so far: the error is reported once.
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
    this.#reportMissingCloser(parserDiagnosticCode.expectedDelimiter, message);
    return this.#previous().span;
  }

  /**
   * Reports a missing closing delimiter where its line ends: the newlines skipped while looking for it are given back,
   * so the statement on the next line still parses, as after `f("a"`.
   */
  #reportMissingCloser(
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
  ): void {
    if (this.#current > 0 && this.#previous().kind === TokenKind.Newline)
      this.#current = this.#shared.newlineRuns.starts[this.#current - 1]!;
    this.#reportInsertion(code, message);
  }

  /**
   * Ends the statement of a statement list that started at token `start` at the line break, `}`, or end of file after
   * it, records its range, and skips the line breaks before the next statement. `diagnosticCount` is the number of
   * diagnostics before it.
   */
  #endStatement(start: number, diagnosticCount: number, inBlock: boolean): void {
    if (this.#current === start) this.#advance();
    // Recovery has already stopped at the next statement.
    if (this.#recoveredAtStatementBoundary) this.#recoveredAtStatementBoundary = false;
    else this.#finishStatement(inBlock);
    let end = this.#current;
    // A statement with an error may be unfinished, such as one that ends in a comma or misses a list's `]`, so it also
    // holds the line breaks after it, where an author completes it, as a recovered one does.
    if (this.#diagnostics.length > diagnosticCount && this.tokens[end]!.kind === TokenKind.Newline)
      end = this.#shared.newlineRuns.ends[end]!;
    this.#statementRanges.push(
      Object.freeze({
        kind: "statement",
        start: this.tokens[start]!.span.start.offset,
        end: this.tokens[end]!.span.start.offset,
      }),
    );
    this.#skipNewlines();
  }

  /** Reads the `}` of the statement block opened by `leftBrace`, or reports it missing, and records the block's range. */
  #closeBlock(leftBrace: Token): boolean {
    const closed = this.#match(TokenKind.RightBrace);
    if (!closed)
      this.#reportInsertion(
        parserDiagnosticCode.expectedRightBrace,
        "Expected '}' to close the block.",
      );
    this.#statementRanges.push(
      Object.freeze({
        kind: "block",
        start: leftBrace.span.end.offset,
        end: (closed ? this.#previous() : this.#peek()).span.start.offset,
      }),
    );
    return closed;
  }

  /** Stops at the line break, `}`, or end of file after a statement, reporting and skipping the rest of its line. */
  #finishStatement(inBlock: boolean): void {
    if (
      this.#check(TokenKind.Newline) ||
      this.#check(TokenKind.EndOfFile) ||
      (inBlock && this.#check(TokenKind.RightBrace))
    ) {
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

  /**
   * Skips the rest of a malformed compact interaction: to the end of its statement, or inside a grouping to the
   * grouping's closing delimiter, which the grouping then reads, so the statements after it still parse.
   */
  #skipInteractionRest(): void {
    if (!this.#insideDelimiters) {
      this.#synchronizeStatement();
      return;
    }
    let depth = 0;
    while (!this.#check(TokenKind.EndOfFile)) {
      if (OPENING_TOKENS.has(this.#peek().kind)) depth += 1;
      else if (CLOSING_TOKENS.has(this.#peek().kind)) {
        if (depth === 0) return;
        depth -= 1;
      }
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

  /** A statement that ends an unclosed block, such as a speaker missing its closing brace, which a value cannot start. */
  #isRecoveredTopLevelStatement(): boolean {
    return (
      (this.#atStatementStart() || this.#checkIdentifier("showCamera")) &&
      this.#peek(1).kind !== TokenKind.Colon
    );
  }

  /** A statement keyword, or a protected statement-only command, which can never be a value. */
  #atStatementStart(): boolean {
    const token = this.#peek();
    return (
      isStatementStart(token.kind) ||
      (token.kind === TokenKind.Identifier && statementOnlyCommands.has(token.lexeme))
    );
  }

  /** Newline tokens delimit statements unless a caller explicitly skips them. */
  #skipNewlines(): void {
    if (this.#check(TokenKind.Newline))
      this.#current = this.#shared.newlineRuns.ends[this.#current]!;
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
      "absoluteDateTime",
      "duration",
      "calendarDuration",
      "list",
      "dict",
      "object",
      "range",
      "timer",
      "media",
      "messageHandle",
      "script",
    ] as const
  ).map((name) => [name, name]),
);

/** The earlier names of types, which are compile errors that name the fix (ADR 0026). */
const RENAMED_TYPE_NAMES: ReadonlyMap<string, TypeName> = new Map([
  ["timestamp", "absoluteDateTime"],
]);

/** The type name a token spells in type position; `speaker`, `set`, and `null` are keywords elsewhere. */
function typeName(token: Token): TypeName | undefined {
  switch (token.kind) {
    case TokenKind.Identifier:
      return IDENTIFIER_TYPE_NAMES.get(token.lexeme) ?? RENAMED_TYPE_NAMES.get(token.lexeme);
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

/** A query whose candidates must pass every filter, each a complete postfix predicate. */
function tagQuery(
  catalog: TagQueryExpression["catalog"],
  select: TagQueryExpression["select"],
  filters: readonly (readonly TagQueryStep[])[],
  from: TagQueryExpression["from"],
  span: SourceSpan,
): TagQueryExpression {
  const steps: TagQueryStep[] = [];
  filters.forEach((filter, index) => {
    for (const step of filter) steps.push(step);
    if (index > 0) steps.push({ kind: "and" });
  });
  return Object.freeze({
    kind: "tagQueryExpression",
    catalog,
    select,
    steps: Object.freeze(steps),
    from,
    span: copySpan(span),
  });
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
    token.kind === TokenKind.KeywordSay ||
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
function delimiterClosers(tokens: readonly Token[]): Map<number, number> {
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

/**
 * Whether `value` starts with the say mode or skip word `word` itself and a unit after it: the bare word, or a mode with
 * its named options, as in `bubble(color: "red") s`. A member, an element, or a call with values stays a value.
 */
function unitAfterWord(value: Expression, word: Token): boolean {
  let node = value;
  for (;;) {
    if (node.kind === "unitExpression") {
      const operand = node.operand;
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
    else return false;
  }
}
