import type { OwnedDiagnosticCode } from "./diagnostic-codes.js";
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
  RangeExpression,
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
  ShowPopupParts,
  ShowPopupStatement,
  OpenUrlStatement,
  ExportTextStatement,
  AngleExpression,
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
import {
  COMMANDS,
  commandFacts,
  isAsk,
  isCommand,
  KEYWORD_TOKENS,
  PROTECTED_NAME_CODE,
  protectedNameMessage,
  startsCallForm,
  TEASESCRIPT_PROTECTED_NAMES,
  type StatementCommand,
  type ValueCommand,
} from "./language-facts.js";
import { VALUE_KIND_NAMES, VALUE_KINDS } from "./value-kinds.js";
import { lex } from "./lexer.js";
import { readMisplacedHeader, readScriptHeader, type ScriptHeader } from "./script-header.js";
import { isTagListOption, tagPredicateSteps } from "./tag-query.js";
import { angleUnit } from "./angle.js";
import { calendarDurationUnit, elapsedDurationUnit, UNIT_OPERANDS } from "./duration.js";
import { createSourcePosition, createSourceSpan, type SourceSpan } from "./source.js";
import { TokenKind, type Token } from "./token.js";

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
  expectedSpeakerAfterAs: "TSP029",
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
  mixedOtherwise: "TSP041",
  invalidTagQuery: "TST001",
  // The name check's code, also given where the parser reads the name (see `#declarationName`).
  protectedName: PROTECTED_NAME_CODE,
} as const satisfies Record<string, OwnedDiagnosticCode<"parser", "error">>;

/** The named arguments of the named form of `playAudio` and `playVideo`, which needs `file:` (V30 §22). */
export const MEDIA_ARGUMENTS = ["file", "async", "repeat", "startAt", "endAt", "volume"] as const;

/**
 * How a type continues (V30 §1): a statement type ends at a newline; inside `()`, a newline may also precede `|` or
 * a postfix form; and the type of an `is` test also ends before `||`, the rejected symbolic `or` (V30 §5).
 */
type TypeContext = "statement" | "delimited" | "typeTest" | "delimitedTypeTest";

type StorageDelimiter = "as" | "default";
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
/** The modes of a message, `bubble` and `prose`, which a `say` or an ask's question may write. */
const PRESENTATION_MODES: ReadonlySet<string> = new Set(["bubble", "prose"]);
/** Tokens that may start an expression but also continue the one before them, as `(` calls and `-` subtracts. */
const EXPRESSION_CONTINUATIONS: ReadonlySet<TokenKind> = new Set([
  TokenKind.LeftParenthesis,
  TokenKind.LeftBracket,
  TokenKind.Plus,
  TokenKind.Minus,
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
/** The one named argument of `askChoice`, written once after its options. */
const CHOICE_OPTIONS: readonly string[] = ["prefill"];
/** The one named argument of `askPassword`: a password is never suggested, so it has no `prefill:`. */
const PASSWORD_OPTIONS: readonly string[] = ["hint"];
/** The named options of `showButton` after its label. */
export const SHOW_BUTTON_OPTIONS: readonly string[] = ["background", "timeout"];
/** The named arguments of `showPopup` besides its message, which it takes first or as `message:` (V30 §31). */
export const SHOW_POPUP_OPTIONS: readonly string[] = ["buttonText"];
/** The named arguments of `openUrl` after its web address (V30 §33). */
export const OPEN_URL_OPTIONS: readonly string[] = ["buttonText", "alwaysButton"];
/** The named arguments of `exportText` after its text (V30 §31). */
export const EXPORT_TEXT_OPTIONS: readonly string[] = ["title", "fileName"];
/** A timer's displays, written after `timer` in its short form and as `display:` in its named form (V30 §27). */
export const TIMER_DISPLAYS = ["visible", "mystery", "hidden"] as const;
/** The named arguments of the named timer form, which needs `duration:` (V30 §27). */
export const TIMER_ARGUMENTS = [
  "duration",
  "async",
  "display",
  "label",
  "repeat",
  "persist",
] as const;
/** The named options of `showPermanentButton` after its text (V30 §28). */
export const PERMANENT_BUTTON_OPTIONS: readonly string[] = ["persist"];

/** The named arguments of an ask, such as `prefill:` and `hint:` of `askText`, as the parser accepts them. */
export function askOptionNames(kind: InteractionExpression["interactionKind"]): readonly string[] {
  if (kind === "choice") return CHOICE_OPTIONS;
  return kind === "password" ? PASSWORD_OPTIONS : (NAMED_ASK_OPTIONS.get(kind) ?? ASK_OPTIONS);
}

/** The named arguments that an ask needs: `fields:` of `askForm`, and `texts:` and `prefill:` of `askBooleans`. */
export function requiredAskOptionNames(
  kind: InteractionExpression["interactionKind"],
): readonly string[] {
  return kind === "form" ? ["fields"] : kind === "booleans" ? ["texts", "prefill"] : [];
}

/** The named arguments the parser reads for an ask: its own, and for `askPassword` a `prefill:` the type check refuses. */
function readAskOptionNames(kind: InteractionExpression["interactionKind"]): readonly string[] {
  return kind === "password" ? READ_PASSWORD_OPTIONS : askOptionNames(kind);
}
const READ_PASSWORD_OPTIONS: readonly string[] = [...PASSWORD_OPTIONS, "prefill"];
/**
 * The earlier name of an ask's `prefill:`, which is a compile error that names the fix (owner decision on #512,
 * 2026-10-08): `default:`, or `defaults:` for `askBooleans`.
 */
function removedPrefillName(kind: InteractionExpression["interactionKind"]): string | null {
  if (kind === "booleans") return "defaults";
  // askPassword came after the rename and never had one.
  return kind === "choice" || kind === "form" || kind === "password" ? null : "default";
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
      diagnostics: Object.freeze([...header.diagnostics, ...parser.diagnostics]),
      statementRanges: Object.freeze(statements),
      commandRanges: Object.freeze(commands),
    });
  }
}

class Parser {
  readonly #diagnostics: Diagnostic[] = [];
  /**
   * The statement and command ranges. A speculative parser keeps its own, so only those of the parse that counts are
   * listed, also those of a `say` value it reuses.
   */
  readonly #statementRanges: (StatementRange | CommandRange | RangeSegment)[] = [];
  /**
   * The offsets of each `/` where this parse expected a value, which a regex literal starts there; like its diagnostics,
   * a speculative parser keeps its own.
   */
  readonly #regexStarts: number[] = [];
  #current = 0;
  #commaLookahead: {
    readonly at: number;
    readonly insideDelimiters: boolean;
    readonly offset: number | null;
  } | null = null;
  #recoveredAtStatementBoundary = false;
  /**
   * Inside a media cue position, a permanent button's text, or the head of a block statement such as `if` or `switch`,
   * where the following block `{` ends a compact interaction, and a value that is still expected (see `#atHeadBlock`).
   */
  #blockEndsCompactInteraction = false;
  /**
   * The `save` `as` that ends an enclosing storage operand, and a bare `default` after a `load` key, the earlier form
   * that `load` reports with its fix. A compact interaction stops at them, and a bare interaction leaves the `as` to
   * `save`; groupings such as parentheses start without them.
   */
  #storageDelimiters: ReadonlySet<StorageDelimiter> = NO_STORAGE_DELIMITERS;
  /** Inside `()`, `[]`, or an object literal, where a line break does not end an expression (V30 §1). */
  #insideDelimiters = false;
  /** The values before a `calendar` without a unit, so that after a `say` mode or skip word, `calendar` is the text. */
  readonly #unitlessCalendars = new WeakSet<Expression>();
  /** What every parser over these tokens shares: a speculative parser computes none of it again. */
  readonly #shared: SharedParse;

  public constructor(
    private readonly tokens: readonly Token[],
    shared: SharedParse = {
      openers: innermostOpeners(tokens),
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

  public get regexStarts(): readonly number[] {
    return this.#regexStarts;
  }

  /** The statement and command ranges, with those of each reused `say` value, read once without recursion. */
  public ranges(): {
    readonly statements: readonly StatementRange[];
    readonly commands: readonly CommandRange[];
  } {
    const statements: StatementRange[] = [];
    const commands: CommandRange[] = [];
    const pending: RangeSegment[] = [
      { list: this.#statementRanges, from: 0, to: this.#statementRanges.length },
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
  #recordCommand(command: Token, end: number, block: boolean): void {
    this.#statementRanges.push(
      Object.freeze({
        kind: "command",
        start: command.span.start.offset,
        end,
        block: block && this.#check(TokenKind.LeftBrace) ? this.#peek().span.start.offset : null,
      }),
    );
  }

  /** Where the last token read ends, before the line breaks read after it. */
  #lastEnd(): number {
    let index = this.#current - 1;
    while (index > 0 && this.tokens[index]!.kind === TokenKind.Newline) index -= 1;
    return this.tokens[index]!.span.end.offset;
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
    const command = this.#commandAt("statement");
    switch (command) {
      case null:
        break;
      case "showButton":
        return yield* parseChild(this.#parseShowButtonStatement());
      case "timer":
        return yield* parseChild(this.#parseTimerStatement());
      case "showPermanentButton": {
        const parts = yield* parseChild(this.#parseShowPermanentButtonParts());
        return parts === null
          ? null
          : Object.freeze({ kind: "showPermanentButtonStatement", ...parts });
      }
      case "showImage":
        return this.#parseShowImageStatement();
      case "hideImage":
        return this.#parseHideImageStatement();
      case "showCamera": {
        const parts = this.#parseShowCameraParts();
        return parts === null ? null : Object.freeze({ kind: "showCameraStatement", ...parts });
      }
      case "hideCamera":
        return this.#parseHideCameraStatement();
      case "showPopup":
        return yield* parseChild(this.#parseShowPopupStatement());
      case "openUrl":
        return yield* parseChild(this.#parseOpenUrlStatement());
      case "exportText":
        return yield* parseChild(this.#parseExportTextStatement());
      case "stopAudio":
        return this.#parseStopAudioStatement();
      case "save":
        return this.#parseSaveStatement();
      case "delete":
        return this.#parseDeleteStatement();
      case "switch":
        return yield* parseChild(this.#parseSwitchStatement());
      case "label":
        return this.#parseLabelStatement();
      case "goto":
      case "call":
        return yield* parseChild(this.#parseTransferStatement());
      case "end":
        return Object.freeze({ kind: "endStatement", span: copySpan(this.#advance().span) });
      case "global":
        return yield* parseChild(this.#parseGlobalStatement());
      case "playAudio":
      case "playVideo": {
        const parts = yield* parseChild(this.#parseMediaParts());
        return parts === null
          ? null
          : Object.freeze({ kind: "playMediaStatement", ...parts } satisfies PlayMediaStatement);
      }
      default:
        return command satisfies never;
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

  *#parseShowPopupStatement(): ParseTask<ShowPopupStatement | null> {
    const parts = yield* parseChild(this.#parseShowPopupParts());
    if (parts === null) return null;
    if (this.#check(TokenKind.Comma)) {
      this.#reportShowPopupCommandComma(this.#peek());
      return null;
    }
    return Object.freeze({ kind: "showPopupStatement", ...parts });
  }

  /**
   * `showPopup <message>`, or the call `showPopup(...)` when a parenthesis follows (V30 §31). The command form takes only
   * the message, as one positional argument. A comma after it that is not followed by `buttonText:` or `message:` is
   * left to the enclosing statement, list, call, or object.
   */
  *#parseShowPopupParts(): ParseTask<ShowPopupParts | null> {
    const command = this.#advance();
    if (startsCallForm(command, this.#peek())) {
      const call = yield* parseChild(
        this.#withinDelimiters(this.#finishCall(this.#identifier(command), this.#advance())),
      );
      this.#recordCommand(command, call.span.end.offset, false);
      return { arguments: call.arguments, span: copySpan(call.span) };
    }
    const message = yield* parseChild(this.#parseOr());
    if (message === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected the popup's message after 'showPopup', as in 'showPopup \"Task completed\"'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    this.#recordCommand(command, message.span.end.offset, false);
    const offset = this.#offsetAfterComma();
    const name = offset === null ? null : this.#peek(offset);
    if (
      offset !== null &&
      name?.kind === TokenKind.Identifier &&
      (name.lexeme === "message" || SHOW_POPUP_OPTIONS.includes(name.lexeme)) &&
      this.#peek(offset + 1).kind === TokenKind.Colon
    ) {
      let comma = offset - 1;
      while (this.#peek(comma).kind !== TokenKind.Comma) comma -= 1;
      this.#reportShowPopupCommandComma(this.#peek(comma));
      return null;
    }
    return {
      arguments: Object.freeze([
        Object.freeze({
          kind: "positionalArgument",
          value: message,
          span: copySpan(message.span),
        } satisfies PositionalArgument),
      ]),
      span: spanFrom(command.span, message.span),
    };
  }

  #reportShowPopupCommandComma(comma: Token): void {
    this.#reportToken(
      parserDiagnosticCode.unsupportedInteractionForm,
      'The command form of showPopup takes only the message. For other button text, write \'showPopup(message: "Task completed", buttonText: "Continue")\'.',
      comma,
    );
    this.#synchronizeStatement();
  }

  /** `openUrl(<url>)` (V30 §33), which has only the call form. */
  *#parseOpenUrlStatement(): ParseTask<OpenUrlStatement | null> {
    const command = this.#advance();
    if (!startsCallForm(command, this.#peek())) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedDelimiter,
        "openUrl takes its web address in parentheses, as in 'openUrl(\"https://example.com\")'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const call = yield* parseChild(
      this.#withinDelimiters(this.#finishCall(this.#identifier(command), this.#advance())),
    );
    this.#recordCommand(command, call.span.end.offset, false);
    return Object.freeze({
      kind: "openUrlStatement",
      arguments: call.arguments,
      span: copySpan(call.span),
    });
  }

  /** `exportText(<text>, title: ..., fileName: ...)` (V30 §31), which has only the call form. */
  *#parseExportTextStatement(): ParseTask<ExportTextStatement | null> {
    const command = this.#advance();
    if (!startsCallForm(command, this.#peek())) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedDelimiter,
        "exportText takes its text in parentheses, as in 'exportText(report)'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const call = yield* parseChild(
      this.#withinDelimiters(this.#finishCall(this.#identifier(command), this.#advance())),
    );
    this.#recordCommand(command, call.span.end.offset, false);
    return Object.freeze({
      kind: "exportTextStatement",
      arguments: call.arguments,
      span: copySpan(call.span),
    });
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
        this.#reportMissingSpeakerAfterAs();
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
        SHOW_BUTTON_OPTIONS.includes(name.lexeme) &&
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

    // Only a declaration names a speaker of its own; a setter names one declared elsewhere, as in `speaker player`.
    const name =
      this.#peek(1).kind === TokenKind.LeftBrace
        ? this.#declarationName("speaker")
        : this.#identifier(this.#advance());
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
        this.#reportMissingSpeakerAfterAs();
        if (statement) this.#synchronizeStatement();
        return null;
      }
      speaker = this.#identifier(this.#advance());
    }

    const presentation =
      this.#check(TokenKind.Identifier) &&
      ["bubble", "prose"].includes(this.#peek().lexeme) &&
      (this.#atSayModeBeforeBoundedText() ||
        !(yield* parseChild(
          this.#canParseCompleteSayValue(statement, this.#peekAfterSayMode()?.kind),
        )))
        ? yield* parseChild(this.#parseSayPresentation())
        : null;

    let skipPolicy: SayParts["skipPolicy"] = null;
    let skipPolicySpan: SourceSpan | null = null;
    if (
      (this.#checkIdentifier("skippable") || this.#checkIdentifier("unskippable")) &&
      ((!statement && this.#peek(1).kind === TokenKind.LeftParenthesis) ||
        !(yield* parseChild(this.#canParseCompleteSayValue(statement, this.#peek(1).kind))))
    ) {
      skipPolicy = this.#peek().lexeme === "skippable" ? "skippable" : "unskippable";
      skipPolicySpan = copySpan(this.#advance().span);
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
        skipPolicySpan,
        value: bounded.value,
        pacing: bounded.pacing,
        instantSpan: bounded.instantSpan,
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
    let instantSpan: SourceSpan | null = null;
    let endSpan = value.span;
    if (this.#match(TokenKind.Comma)) {
      if (this.#canParseInstantPacingAlias(statement)) {
        endSpan = this.#advance().span;
        pacing = "instant";
        instantSpan = copySpan(endSpan);
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
      skipPolicySpan,
      value,
      pacing,
      instantSpan,
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
      this.#regexStarts.push(...known.regexStarts);
      this.#statementRanges.push(known.ranges);
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
    const regexStartCount = this.#regexStarts.length;
    const rangeCount = this.#statementRanges.length;
    const parts = yield* parseChild(this.#parseSayParts(false));
    parsed.push({
      ...context,
      parts,
      end: this.#current,
      diagnostics: this.#diagnostics.slice(diagnosticCount),
      regexStarts: this.#regexStarts.slice(regexStartCount),
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
    readonly instantSpan: SourceSpan | null;
    readonly end: SourceSpan;
  } | null> {
    this.#advance();
    this.#skipNewlines();
    const value = yield* parseChild(this.#parseRequiredExpressionTask());
    if (value === null) return null;
    this.#skipNewlines();
    let pacing: SayParts["pacing"] = null;
    let instantSpan: SourceSpan | null = null;
    if (this.#match(TokenKind.Comma)) {
      this.#skipNewlines();
      let after = 1;
      while (this.#peek(after).kind === TokenKind.Newline) after += 1;
      if (
        this.#checkIdentifier("instant") &&
        this.#peek(after).kind === TokenKind.RightParenthesis
      ) {
        instantSpan = copySpan(this.#advance().span);
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
    return { value, pacing, instantSpan, end: copySpan(this.#previous().span) };
  }

  /**
   * Whether the `bubble` or `prose` here is a mode with options, none or named ones only, followed by the parentheses of
   * a bounded `say`: `bubble() ("Plain", instant)` is no chained call.
   */
  #atSayModeBeforeBoundedText(): boolean {
    return (
      this.#peek(1).kind === TokenKind.LeftParenthesis &&
      this.#peekAfterSayMode()?.kind === TokenKind.LeftParenthesis
    );
  }

  /**
   * The token after the `bubble` or `prose` here and its options, or `null` when the parentheses after it cannot hold
   * them: they hold none or named ones only.
   */
  #peekAfterSayMode(): Token | null {
    if (this.#peek(1).kind !== TokenKind.LeftParenthesis) return this.#peek(1);
    let first = 2;
    while (this.#peek(first).kind === TokenKind.Newline) first += 1;
    if (
      this.#peek(first).kind !== TokenKind.RightParenthesis &&
      !(isPropertyName(this.#peek(first)) && this.#peek(first + 1).kind === TokenKind.Colon)
    )
      return null;
    this.#shared.closers ??= delimiterClosers(this.tokens);
    const closer = this.#shared.closers.get(this.#current + 1);
    return closer === undefined ? null : this.#peek(closer + 1 - this.#current);
  }

  /**
   * `bubble` or `prose`, with its named options in parentheses or none, as the presentation object of a `say` or of an
   * ask's question. Without `options`, the mode is written alone and parentheses after it are not its own.
   */
  *#parseSayPresentation(options = true): ParseTask<ObjectLiteral> {
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
    if (options && this.#match(TokenKind.LeftParenthesis)) {
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
   * interpolation. When a `/` follows the modifier (`afterModifier`), only a
   * value without errors counts: a regex may start there (V30 §8), and the
   * tokens after the `/` do not show its pattern, as in `say prose /[/*]/`.
   */
  *#canParseCompleteSayValue(
    statement: boolean,
    afterModifier: TokenKind | undefined,
  ): ParseTask<boolean> {
    const speculative = new Parser(this.tokens, this.#shared);
    speculative.#current = this.#current;

    const value = yield* parseChild(speculative.#parseOr());
    if (value === null) return false;
    // A unit after the word itself, as in `say bubble() s` or `say skippable ms`, is the earlier modifier followed by
    // text whose name is a unit word, also `calendar` or an angle unit.
    if (unitAfterWord(value, this.#peek(), speculative.#unitlessCalendars)) return false;

    if (speculative.#match(TokenKind.Comma)) {
      if (speculative.#canParseInstantPacingAlias(statement)) {
        speculative.#advance();
      } else {
        const pacing = yield* parseChild(speculative.#parseOr());
        if (pacing === null) return false;
      }
    }

    return (
      speculative.#isSayBoundary(statement) &&
      (afterModifier !== TokenKind.Slash || speculative.#diagnostics.length === 0)
    );
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
    if (!this.#checkDeclarationName()) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedLabelName,
        "Expected a label name after 'label'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const name = this.#declarationName("label");
    return Object.freeze({ kind: "labelStatement", name, span: spanFrom(keyword.span, name.span) });
  }

  /**
   * `goto` or `call`, followed by a label, or by a quoted file path. A label after the path is read too, so that the
   * name pass can report it (V30 §29).
   */
  *#parseTransferStatement(): ParseTask<GotoStatement | CallFileStatement | null> {
    const keyword = this.#advance();
    const tagged = this.#checkIdentifier("tagged");
    const reported = this.#diagnostics.length;
    const target = yield* parseChild(this.#parseTransferTarget(keyword));
    // `call scene()`: a function runs by its name and `()`, without `call` or `goto` (V30 §10). A malformed call is
    // reported first. The statement ends after the call, where the list it stands in finds its end, also at the `}` of
    // a compact block.
    if (target?.kind === "callExpression") {
      if (this.#diagnostics.length === reported && target.callee.kind === "identifier")
        this.#reportSpan(
          parserDiagnosticCode.expectedLabelName,
          keyword.lexeme === "call"
            ? `A call only starts a file, so it cannot run function '${target.callee.name}'. Leave out 'call' to run it.`
            : `A 'goto' only goes to a label or a file, so it cannot run function '${target.callee.name}'. Leave out 'goto' to run it.`,
          target.span,
        );
      return null;
    }
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
    return keyword.lexeme === "goto"
      ? Object.freeze({ kind: "gotoStatement", target, span })
      : Object.freeze({ kind: "callFileStatement", target, span });
  }

  /** A transfer's target, or the call of a function written as one, which the statement reports. */
  *#parseTransferTarget(keyword: Token): ParseTask<TransferTarget | CallExpression | null> {
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
      if (this.#check(TokenKind.LeftParenthesis))
        return yield* parseChild(this.#withinDelimiters(this.#finishCall(label, this.#advance())));
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
    this.#recordCommand(keyword, duration.span.end.offset, false);
    const { duration: delay, unit } = this.#timerDuration(duration, "wait");
    return Object.freeze({
      kind: "waitStatement",
      duration: delay,
      unit,
      lengthSpan: duration.span,
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
    if (startsCallForm(command, this.#peek())) {
      return yield* parseChild(this.#withinDelimiters(this.#parseNamedTimer(command)));
    }
    const async = this.#checkIdentifier("async");
    if (async) this.#advance();
    let display: TimerDisplay | null = null;
    for (const candidate of TIMER_DISPLAYS) {
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
    this.#recordCommand(command, end.end.offset, true);
    const handler = yield* parseChild(this.#parseTimerHandler());
    if (handler === false) return null;
    return {
      form: "short",
      async,
      display,
      duration,
      unit,
      lengthSpan: written.span,
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
    this.#recordCommand(command, call.span.end.offset, true);
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
      const known = TIMER_ARGUMENTS.find((candidate) => candidate === name);
      switch (known) {
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
            flags[known] = argument.value.value;
          }
          break;
        case undefined:
          this.#reportSpan(
            parserDiagnosticCode.invalidTimerForm,
            `Unknown timer argument '${name}'. Use ${TIMER_ARGUMENTS.slice(0, -1).join(", ")}, or ${TIMER_ARGUMENTS.at(-1)}.`,
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
      lengthSpan: duration.span,
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
    const diagnosticCount = this.#diagnostics.length;
    const text = yield* parseChild(this.#parseOr());
    const textEnd = this.#current;
    const options = text === null ? null : yield* parseChild(this.#parsePermanentButtonOptions());
    this.#blockEndsCompactInteraction = enclosing;
    if (text !== null) this.#recordCommand(command, this.#lastEnd(), true);
    if (text === null) {
      // Text that reported its own error, as `"Stop" + {`, needs no second one.
      if (this.#diagnostics.length === diagnosticCount)
        this.#reportInsertion(
          parserDiagnosticCode.expectedInteractionText,
          "Expected button text after 'showPermanentButton'.",
        );
      // The block belongs to the button.
      if (this.#check(TokenKind.LeftBrace)) this.#skipMalformedBlock();
      else this.#synchronizeStatement();
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
      } else if (!PERMANENT_BUTTON_OPTIONS.includes(name.lexeme)) {
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
      // Text such as a compact `askChoice` would take the option as its own, so it is grouped.
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
    this.#recordCommand(command, image.span.end.offset, false);
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
    if (startsCallForm(command, this.#peek())) {
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
    if (!this.#checkIdentifier("stage")) {
      this.#recordCommand(command, command.span.end.offset, false);
      return { placement: "window", span: copySpan(command.span) };
    }
    const word = this.#advance();
    this.#recordCommand(command, word.span.end.offset, false);
    return { placement: "stage", span: spanFrom(command.span, word.span) };
  }

  #parseHideCameraStatement(): HideCameraStatement | null {
    const command = this.#advance();
    if (
      this.#rejectAdjacentParenthesis(command, "hideCamera takes no arguments. Write 'hideCamera'.")
    )
      return null;
    this.#recordCommand(command, command.span.end.offset, false);
    return Object.freeze({ kind: "hideCameraStatement", span: copySpan(command.span) });
  }

  #parseHideImageStatement(): HideImageStatement | null {
    const command = this.#advance();
    if (
      this.#rejectAdjacentParenthesis(command, "hideImage takes no arguments. Write 'hideImage'.")
    )
      return null;
    this.#recordCommand(command, command.span.end.offset, false);
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
    if (atEnd()) {
      this.#recordCommand(command, command.span.end.offset, false);
      return Object.freeze({ kind: "stopAudioStatement", span: copySpan(command.span) });
    }
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
    if (startsCallForm(command, this.#peek())) {
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
    this.#recordCommand(command, file.span.end.offset, true);
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
    this.#recordCommand(command, right.span.end.offset, true);
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
    let previous = this.#current;
    for (let index = this.#current + 1; index < this.tokens.length; index += 1) {
      const kind = this.tokens[index]!.kind;
      if (kind === TokenKind.EndOfFile) return false;
      if (kind === TokenKind.Newline && this.#continuesAfter(previous)) continue;
      previous = index;
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
      const diagnosticCount = this.#diagnostics.length;
      offset = yield* parseChild(this.#parseOr());
      this.#blockEndsCompactInteraction = enclosing;
      if (offset === null) {
        // A position that reported its own error, as `2 s + {`, needs no second one, and its block still parses.
        if (this.#diagnostics.length === diagnosticCount)
          this.#reportInsertion(
            parserDiagnosticCode.expectedExpression,
            `Expected a cue position such as '30 s' after '${keyword.lexeme}'.`,
          );
        if (this.#check(TokenKind.LeftBrace)) yield* parseChild(this.#parseBlock());
        else this.#synchronizeStatement(true);
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
    const name = this.#declarationName("other");
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
    const name = this.#declarationName("other");
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
    // A condition that failed at the `{` of its block, as `if x == {`, still has the block, which parses as usual, so
    // that its `}` and an `else` after it report nothing more.
    if (condition === null && !this.#check(TokenKind.LeftBrace)) {
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
    if (condition === null) return null;
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
    // The cases after a subject that failed at their `{` still parse (see `#parseIfStatement`).
    if (subject === null && !this.#check(TokenKind.LeftBrace)) {
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
    if (subject === null) return null;
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
    const negated = this.#matchNot();
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
    // The body after a count that failed at its `{` still parses (see `#parseIfStatement`).
    if (count === null && !this.#check(TokenKind.LeftBrace)) {
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const body = yield* parseChild(this.#parseBlock());
    if (body === null || count === null) return null;
    return Object.freeze({
      kind: "repeatStatement",
      count,
      body,
      span: spanFrom(keyword.span, body.span),
    });
  }

  *#parseForStatement(): ParseTask<ForStatement | null> {
    const keyword = this.#advance();
    // An `in` here is the one after the loop variable, which is missing.
    if (!this.#checkDeclarationName() || this.#check(TokenKind.KeywordIn)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedIdentifier,
        "Expected a loop-variable identifier after 'for'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const variable = this.#declarationName("other");
    // `for key, value in dict`: the second name receives each entry's value.
    let valueVariable: Identifier | null = null;
    if (this.#match(TokenKind.Comma)) {
      // A line may break after the comma (V30 §1) before `value in`; another next line stays for recovery.
      let offset = 0;
      while (this.#peek(offset).kind === TokenKind.Newline) offset += 1;
      const next = this.#peek(offset);
      if (
        isWord(next) &&
        next.kind !== TokenKind.KeywordIn &&
        this.#peek(offset + 1).kind === TokenKind.KeywordIn
      )
        this.#skipNewlines();
      if (!this.#checkDeclarationName() || this.#check(TokenKind.KeywordIn)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedIdentifier,
          "Expected a value-variable identifier after ',', as in 'for key, value in dict'.",
        );
        this.#synchronizeStatement();
        return null;
      }
      valueVariable = this.#declarationName("other");
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
    // The body after a value that failed at its `{` still parses (see `#parseIfStatement`).
    if (iterable === null && !this.#check(TokenKind.LeftBrace)) {
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const body = yield* parseChild(this.#parseBlock());
    if (body === null || iterable === null) return null;
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
    // The body after a condition that failed at its `{` still parses (see `#parseIfStatement`).
    if (condition === null && !this.#check(TokenKind.LeftBrace)) {
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const body = yield* parseChild(this.#parseBlock());
    if (body === null || condition === null) return null;
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
    if (!this.#checkDeclarationName()) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedFunctionName,
        "Expected a function identifier after 'function'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const name = this.#declarationName("other");
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
    const name = this.#declarationName("other");
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
          // `fallback` was a statement until an end always returned to a call.
          expression.name === "fallback"
            ? "TeaseScript has no 'fallback': an 'end' returns to the file that called this one. Use 'call' to start a file that should come back here, and 'goto' or 'exit' where no call waits."
            : "Expected a supported TeaseScript statement.",
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
    while (expression !== null) {
      const operator = this.#matchOperator(TokenKind.KeywordOr) ?? this.#matchSymbolicOr();
      if (operator === null) break;
      this.#skipContinuationNewlines();
      const diagnosticCount = this.#diagnostics.length;
      const right = yield* parseChild(this.#parseAnd());
      if (right === null) {
        this.#reportMissingOperand("or", "Expected an expression after 'or'.", diagnosticCount);
        return null;
      }
      expression = this.#binary(expression, right, "or", operator);
    }
    return expression;
  }

  *#parseAnd(): ParseTask<Expression | null> {
    let expression = yield* parseChild(this.#parseNot());
    while (expression !== null) {
      const operator =
        this.#matchOperator(TokenKind.KeywordAnd) ??
        this.#matchSymbol(TokenKind.Ampersand, "oneOrTwo", "and", "if a and b { ... }");
      if (operator === null) break;
      this.#skipContinuationNewlines();
      const diagnosticCount = this.#diagnostics.length;
      const right = yield* parseChild(this.#parseNot());
      if (right === null) {
        this.#reportMissingOperand("and", "Expected an expression after 'and'.", diagnosticCount);
        return null;
      }
      expression = this.#binary(expression, right, "and", operator);
    }
    return expression;
  }

  *#parseNot(): ParseTask<Expression | null> {
    const operators: Token[] = [];
    while (this.#matchNot()) {
      operators.push(this.#previous());
      this.#skipContinuationNewlines();
    }
    const diagnosticCount = this.#diagnostics.length;
    let expression = yield* parseChild(this.#parseComparison());
    if (expression === null) {
      if (operators.length > 0)
        this.#reportMissingOperand("not", "Expected an expression after 'not'.", diagnosticCount);
      return null;
    }
    for (let index = operators.length - 1; index >= 0; index -= 1) {
      expression = this.#unary(operators[index]!, expression, "not");
    }
    return expression;
  }

  *#parseComparison(): ParseTask<Expression | null> {
    const diagnosticCount = this.#diagnostics.length;
    const left = yield* parseChild(this.#parseOtherwise());
    if (left === null) return null;
    let expression: Expression;
    if (this.#check(TokenKind.KeywordIs)) {
      expression = yield* parseChild(this.#parseTypeTestTask(left));
    } else if (isComparisonKind(this.#peek().kind)) {
      const operator = this.#advance();
      this.#skipContinuationNewlines();
      const leftQuotable = this.#diagnostics.length === diagnosticCount;
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
        // The chain has its error already, so a `not` here, as in `a == b == not c`, is read without another one.
        while (this.#matchNot()) this.#skipContinuationNewlines();
        yield* parseChild(this.#parseOtherwise());
      }
    }
    return expression;
  }

  /**
   * The operand after `symbol`, a comparison, `otherwise`, arithmetic, a range, or a sign, which `parse` reads, or
   * `missing` without one. `not` binds more loosely than each of them (V30 §5), so `x == not a` has no operand after the
   * `==`: `report` gives the one error for the `not`, and the rest is read as `x == (not a)`, so that nothing after it
   * reports another error. `report` hears whether the operand is free of errors of its own, which the `??` of
   * `x == not a ?? b` is not.
   */
  *#parseOperand(
    symbol: string,
    parse: () => ParseTask<Expression | null>,
    missing: string,
    report: (operators: readonly Token[], value: Expression, quotable: boolean) => void,
  ): ParseTask<Expression | null> {
    const operators: Token[] = [];
    while (this.#matchNot()) {
      operators.push(this.#previous());
      this.#skipContinuationNewlines();
    }
    const diagnosticCount = this.#diagnostics.length;
    let value = yield* parseChild(parse());
    if (value === null) {
      if (operators.length === 0) this.#reportMissingOperand(symbol, missing, diagnosticCount);
      else
        this.#reportMissingOperand("not", "Expected an expression after 'not'.", diagnosticCount);
      return null;
    }
    if (operators.length === 0) return value;
    report(operators, value, this.#diagnostics.length === diagnosticCount);
    for (let index = operators.length - 1; index >= 0; index -= 1) {
      value = this.#unary(operators[index]!, value, "not");
    }
    return value;
  }

  /**
   * Reports the value missing after `symbol`, unless the operand reported its own error, as the `==` of `a and x ==`
   * does. Before the `{` that ends a block head, as in `if x == {`, the message says that the `{` starts the block.
   */
  #reportMissingOperand(symbol: string, message: string, diagnosticCount: number): void {
    if (this.#diagnostics.length !== diagnosticCount) return;
    this.#reportInsertion(
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
   * as the `??` of `x ?? false == not a`, is not quoted.
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
      quotable,
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
   * operand after the `not`s. Only a short expression is quoted, as for `otherwise` (see `#reportMixedOtherwise`), and
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
      written = readings(this.#textOf(left.span, left.span), this.#textOf(value.span, value.span));
      if (!written.every((reading) => reading.length <= 60 && !reading.includes("\n")))
        written = undefined;
    }
    const quoted = (written ?? readings(...example)).map((reading) => `'${reading}'`).join(", or ");
    this.#reportSpan(
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
    this.#reportSpan(
      parserDiagnosticCode.expectedExpression,
      `'not' cannot follow '${symbol}': it gives true or false, which ${user} cannot use. Remove the 'not'.`,
      operators[0]!.span,
    );
  }

  /** `value is T` or `value is not T`; the right operand is a type, not a value (ADR 0021). */
  *#parseTypeTestTask(value: Expression): ParseTask<Expression> {
    this.#advance();
    this.#skipContinuationNewlines();
    const negated = this.#matchNot();
    this.#skipContinuationNewlines();
    const first = this.#peek();
    if (this.#atComparedValue()) {
      const compared = yield* parseChild(this.#parseOtherwise());
      this.#reportSpan(
        parserDiagnosticCode.invalidType,
        "'is' checks a type. Use '==' to compare values.",
        compared?.span ?? first.span,
      );
      return value;
    }
    const opener = this.#shared.openers[this.#current];
    const type = yield* parseChild(
      this.#parseTypeTask(
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
  #atComparedValue(): boolean {
    let offset = 0;
    while (
      this.#peek(offset).kind === TokenKind.LeftParenthesis ||
      this.#peek(offset).kind === TokenKind.Newline
    ) {
      offset += 1;
    }
    const token = this.#peek(offset);
    // The type is missing before the `{` of the block, as in `if x is {`.
    if (offset === 0 && this.#atHeadBlock()) return false;
    // `set[1]` is a set value; `set` alone, or `set[]` for a list of sets, is a type.
    if (
      token.kind === TokenKind.KeywordSet &&
      this.#peek(offset + 1).kind === TokenKind.LeftBracket &&
      this.#peek(offset + 2).kind !== TokenKind.RightBracket
    )
      return true;
    return typeName(token) === undefined && isExpressionStart(token);
  }

  /**
   * `a otherwise b`, left-associative, between the ranges and the comparisons. An operand that is arithmetic or a range
   * needs parentheses, because the fallback could be meant for its nearest value or for all of it (V30 §5, §18).
   */
  *#parseOtherwise(): ParseTask<Expression | null> {
    const diagnosticCount = this.#diagnostics.length;
    let expression = yield* parseChild(this.#parseRange());
    while (expression !== null) {
      const word = this.#matchOperator(TokenKind.KeywordOtherwise);
      const operator =
        word ??
        this.#matchSymbol(
          TokenKind.Question,
          "two",
          "otherwise",
          'let name = nickname otherwise "pet"',
        );
      if (operator === null) break;
      this.#skipContinuationNewlines();
      const left = expression;
      // Arithmetic before `otherwise` needs parentheses too, which only its own message names (see below).
      const leftQuotable =
        this.#diagnostics.length === diagnosticCount && !isArithmetic(left) && !isSign(left);
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
      // A `??` has its one error already (V30 §39), and so has a `not` that starts the fallback, which only
      // `#parseOperand` reads there: the parentheses follow once both are written as they should be.
      if (word !== null && !(right.kind === "unaryExpression" && right.operator === "not"))
        this.#reportMixedOtherwise(expression, right, operator);
      expression = this.#binary(expression, right, "otherwise", operator);
    }
    return expression;
  }

  /**
   * Reports an operand of `otherwise` that is arithmetic or a range without parentheses (owner decision on #850). The
   * message names both readings: the fallback for the nearest value, and for the whole operand. A sign before the
   * fallback, as in `otherwise -1`, can be read only one way.
   */
  #reportMixedOtherwise(left: Expression, right: Expression, operator: SourceSpan): void {
    const leftMixed = isArithmetic(left) || isSign(left);
    const rightMixed = isArithmetic(right);
    if (!leftMixed && !rightMixed) return;
    // The values next to `otherwise`: the last one of the left operand and the first one of the right operand.
    let last = left;
    while (isArithmetic(last) || isSign(last))
      last = isSign(last) ? last.operand : last.kind === "binaryExpression" ? last.right : last.end;
    let first = right;
    while (isArithmetic(first))
      first = first.kind === "binaryExpression" ? first.left : first.start;
    let readings = ", as in '(count otherwise 0) + 1' or 'count otherwise (0 + 1)'";
    // Only a short expression is quoted, which also keeps a long chain from being written out for each error in it.
    if (right.span.end.offset - left.span.start.offset <= 240) {
      // The source text of an operand ends with that of its last value and starts with that of its first one.
      const text = (expression: Expression) => this.#textOf(expression.span, expression.span);
      const [whole, value, fallback, rest] = [text(left), text(last), text(first), text(right)];
      const nearest = `${whole.slice(0, whole.length - value.length)}(${value} otherwise ${fallback})${rest.slice(fallback.length)}`;
      const all = `${leftMixed ? `(${whole})` : whole} otherwise ${rightMixed ? `(${rest})` : rest}`;
      if ([nearest, all].every((reading) => reading.length <= 60 && !reading.includes("\n")))
        readings = `: '${nearest}' or '${all}'`;
    }
    this.#reportSpan(
      parserDiagnosticCode.mixedOtherwise,
      `Put parentheses around what 'otherwise' belongs to${readings}.`,
      operator,
    );
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
        !this.#check(TokenKind.Star) &&
        !this.#check(TokenKind.Slash) &&
        !this.#check(TokenKind.Percent)
      )
        break;
      const operator = this.#advance();
      this.#skipContinuationNewlines();
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
    const operators: Token[] = [];
    while (this.#check(TokenKind.Plus) || this.#check(TokenKind.Minus)) {
      operators.push(this.#advance());
      this.#skipContinuationNewlines();
    }
    const sign = operators.at(-1);
    if (sign === undefined) return yield* parseChild(this.#parsePostfix());
    let expression = yield* parseChild(
      this.#parseOperand(
        sign.lexeme,
        () => this.#parseUnaryArithmetic(),
        "Expected an expression after the unary operator.",
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
      // A month or a year needs `calendar` here too, also as `mo` or `y`.
      const withoutCalendar = calendarDurationUnit(token.lexeme);
      if (angleUnit(token.lexeme) !== undefined) {
        result = this.#angleExpression(expression, start);
      } else if (exact !== undefined) {
        this.#advance();
        result = withUnit({ calendar: false, unit: exact }, token);
      } else if (token.lexeme === "calendar") {
        const unit = this.#calendarUnit(this.#advance());
        if (unit !== undefined) result = withUnit({ calendar: true, unit }, this.#advance());
        else this.#unitlessCalendars.add(expression);
      } else if (withoutCalendar !== undefined) {
        this.#reportCalendarUnitWithoutCalendar(this.#sourceText(start, this.#current), token);
        result = withUnit({ calendar: true, unit: withoutCalendar }, this.#advance());
      }
    }
    return this.#reportSecondUnit(result);
  }

  /**
   * One duration or angle has one unit: a second unit or a second amount with a unit right after it is an error, as in
   * `5 s ms` or `1 h 30 min`, and parts are added with `+`.
   */
  #reportSecondUnit(result: Expression): Expression {
    const angle = result.kind === "angleExpression";
    if (!angle && result.kind !== "durationLiteral" && result.kind !== "unitExpression")
      return result;
    const next = this.#peek();
    const unitWord = (candidate: Token): boolean =>
      candidate.kind === TokenKind.Identifier &&
      (candidate.lexeme === "calendar" ||
        elapsedDurationUnit(candidate.lexeme) !== undefined ||
        calendarDurationUnit(candidate.lexeme) !== undefined ||
        angleUnit(candidate.lexeme) !== undefined);
    if (unitWord(next)) {
      this.#advance();
      this.#reportToken(
        parserDiagnosticCode.unsupportedDurationUnit,
        `This ${angle ? "angle" : "duration"} already has a unit. Remove the '${next.lexeme}' after it.`,
        next,
      );
    } else if (next.kind === TokenKind.NumberLiteral && unitWord(this.#peek(1))) {
      this.#advance();
      this.#advance();
      this.#reportSpan(
        parserDiagnosticCode.unsupportedDurationUnit,
        angle
          ? "Add the parts of an angle with '+', as in '90 deg + 30 deg'."
          : "Add the parts of a duration with '+', as in '1 h + 30 min'.",
        spanFrom(next.span, this.#previous().span),
      );
    }
    return result;
  }

  /**
   * The angle unit that comes next after `operand`, which begins at `start`: the number before it as an angle, such as
   * `90 deg` or `(a + b) rad` (V30 §13). A space must come before the unit, unlike in `90deg`.
   */
  #angleExpression(operand: Expression, start: number): AngleExpression {
    const token = this.#advance();
    if (token.span.start.offset === operand.span.end.offset)
      this.#reportToken(
        parserDiagnosticCode.unsupportedDurationUnit,
        `A unit needs a space before it. Write '${this.#sourceText(start, this.#current - 1)} ${token.lexeme}'.`,
        token,
      );
    return Object.freeze({
      kind: "angleExpression",
      operand,
      unit: angleUnit(token.lexeme)!,
      unitSpan: copySpan(token.span),
      span: spanFrom(operand.span, token.span),
    });
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
  #parseDurationUnit(amount: NumberLiteral, start: number): Expression {
    if (!this.#check(TokenKind.Identifier)) return amount;
    const token = this.#peek();
    if (angleUnit(token.lexeme) !== undefined) return this.#angleExpression(amount, start);
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
      const unit = this.#calendarUnit(this.#advance());
      return unit === undefined ? amount : literal({ calendar: true, unit }, this.#advance());
    }
    const exact = elapsedDurationUnit(token.lexeme);
    if (exact !== undefined) return literal({ calendar: false, unit: exact }, this.#advance());
    const calendar = calendarDurationUnit(token.lexeme);
    if (calendar === undefined) return amount;
    this.#reportCalendarUnitWithoutCalendar(amount.raw, token);
    return literal({ calendar: true, unit: calendar }, this.#advance());
  }

  /**
   * The calendar unit that comes next, after the word `calendar`, or `undefined` once an error names the units that may
   * follow `calendar`, the same after a number as after a name.
   */
  #calendarUnit(calendar: Token): CalendarDurationUnit | undefined {
    const next = this.#peek();
    const unit = next.kind === TokenKind.Identifier ? calendarDurationUnit(next.lexeme) : undefined;
    if (unit === undefined)
      this.#reportToken(
        parserDiagnosticCode.unsupportedDurationUnit,
        "Expected a calendar unit after 'calendar': day, week, month, or year.",
        calendar,
      );
    return unit;
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
    const command = this.#commandAt("value");
    if (command !== null && isAsk(command)) {
      // An earlier name, such as `choose`, is an error that names the fix, and the ask is read as written (#830).
      const renamed = commandFacts(command)?.renamed;
      if (renamed !== undefined)
        this.#reportToken(
          parserDiagnosticCode.unsupportedInteractionForm,
          `'${command}' is now called '${renamed}', like the other asks that wait for the player's answer. Write '${renamed}' instead.`,
          token,
        );
      return yield* parseChild(this.#parseInteractionExpression(COMMANDS[command].interaction));
    }
    if (
      this.#checkIdentifier("askImage") &&
      this.#peek(1).kind === TokenKind.Identifier &&
      PRESENTATION_MODES.has(this.#peek(1).lexeme)
    )
      return yield* parseChild(this.#parseAskImageWithPresentation());
    switch (command) {
      case null:
        break;
      case "showButton": {
        const parts = yield* parseChild(this.#parseShowButtonParts());
        return parts === null ? null : Object.freeze({ kind: "showButtonExpression", ...parts });
      }
      case "showPopup": {
        const parts = yield* parseChild(this.#parseShowPopupParts());
        return parts === null ? null : Object.freeze({ kind: "showPopupExpression", ...parts });
      }
      case "timer": {
        const parts = yield* parseChild(this.#parseTimerParts());
        return parts === null ? null : Object.freeze({ kind: "timerExpression", ...parts });
      }
      case "showCamera": {
        const parts = this.#parseShowCameraParts();
        return parts === null ? null : Object.freeze({ kind: "showCameraExpression", ...parts });
      }
      case "showPermanentButton": {
        const parts = yield* parseChild(this.#parseShowPermanentButtonParts());
        return parts === null
          ? null
          : Object.freeze({ kind: "showPermanentButtonExpression", ...parts });
      }
      case "playAudio":
      case "playVideo": {
        const parts = yield* parseChild(this.#parseMediaParts());
        return parts === null ? null : Object.freeze({ kind: "playMediaExpression", ...parts });
      }
      case "load":
        return yield* parseChild(this.#parseLoadExpression());
      default:
        return command satisfies never;
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
      return this.#parseDurationUnit(amount, this.#current - 1);
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
    // The protected constant `pi` (V30 §13) is the number it names, and like a number it may take a unit: `pi rad`.
    if (this.#checkIdentifier("pi")) {
      this.#advance();
      return this.#parseDurationUnit(
        Object.freeze({
          kind: "numberLiteral",
          raw: "pi",
          value: 3.141592653589793,
          numericType: "number",
          span: copySpan(token.span),
        }),
        this.#current - 1,
      );
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
    if (this.#match(TokenKind.RegexLiteral)) {
      const source = tokenValue(token);
      // The lexer reported a literal without its closing slash.
      if (token.lexeme.length < source.length + 2) return null;
      return Object.freeze({
        kind: "regexLiteral",
        source,
        flags: token.lexeme.slice(source.length + 2),
        span: copySpan(token.span),
      });
    }
    if (this.#match(TokenKind.LeftParenthesis)) {
      return yield* parseChild(this.#withinDelimiters(this.#parseParenthesized(token)));
    }
    if (this.#match(TokenKind.LeftBracket)) {
      return yield* parseChild(
        this.#withinDelimiters(this.#parseCollectionLiteralElements(token, "listLiteral")),
      );
    }
    // The `{` of a block head's block is no value (see `#atHeadBlock`).
    if (this.#check(TokenKind.LeftBrace) && !this.#atHeadBlock()) {
      this.#advance();
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
    // The lexer took this `/` for division, but a value starts here (see `parse`).
    if (token.kind === TokenKind.Slash) this.#regexStarts.push(token.span.start.offset);
    return null;
  }

  *#parseInteractionExpression(
    interactionKind: InteractionExpression["interactionKind"],
  ): ParseTask<InteractionExpression | null> {
    const command = this.#advance();
    if (this.#check(TokenKind.LeftParenthesis) && interactionKind !== "choice")
      return yield* parseChild(this.#parseBoundedAsk(command, interactionKind, null, null, null));
    if (this.#check(TokenKind.LeftParenthesis)) {
      this.#reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        "Parenthesized askChoice arguments are not supported in the compact interaction syntax.",
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
        this.#reportMissingSpeakerAfterAs();
        return null;
      }
      speaker = this.#identifier(this.#advance());
    }
    if (this.#check(TokenKind.LeftParenthesis) && interactionKind !== "choice")
      return yield* parseChild(
        this.#parseBoundedAsk(command, interactionKind, asSpan, speaker, null),
      );
    // The question's mode, as `say` writes it after its speaker (#832); `askChoice` has no question to show.
    let presentation: ObjectLiteral | null = null;
    if (this.#atQuestionPresentation()) {
      const mode = this.#peek();
      presentation = yield* parseChild(this.#parseSayPresentation());
      if (interactionKind === "choice") {
        this.#reportSpan(
          parserDiagnosticCode.unsupportedInteractionForm,
          `askChoice has no question, so it takes no '${mode.lexeme}'. Say the question before it, as in 'say ${mode.lexeme} "Which one?"'.`,
          presentation.span,
        );
        presentation = null;
      }
    }
    if (this.#check(TokenKind.LeftParenthesis) && interactionKind !== "choice")
      return yield* parseChild(
        this.#parseBoundedAsk(command, interactionKind, asSpan, speaker, presentation),
      );
    if (this.#check(TokenKind.LeftParenthesis)) {
      this.#reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        "Parenthesized askChoice arguments are not supported in the compact interaction syntax.",
        this.#peek().span,
      );
      this.#synchronizeStatement();
      return null;
    }

    if (interactionKind !== "choice") {
      const names = readAskOptionNames(interactionKind);
      // The earlier name of the prefill is read as an option too, so its error names the fix wherever it is written.
      const removed = removedPrefillName(interactionKind);
      const recognized = removed === null ? names : [...names, removed];
      // Before a `/`, a mode word is the question only where the question parses from it without errors, as for `say`
      // (see `#canParseCompleteSayValue`): otherwise a regex may start at the `/`, as in `askText prose /[/*]/`, which
      // the parse looks for again (see `parse`). A word whose question parses divides, as in `askNumber prose / 2`, also
      // where a regex that the question holds is found first and the parse with it decides again, as in
      // `askNumber prose / (say prose /x/).text.length`.
      const slash =
        presentation === null &&
        this.#check(TokenKind.Identifier) &&
        PRESENTATION_MODES.has(this.#peek().lexeme)
          ? this.#peekAfterSayMode()
          : null;
      const diagnosticCount = this.#diagnostics.length;
      const regexStartCount = this.#regexStarts.length;
      const question =
        isExpressionStart(this.#peek()) &&
        !(this.#blockEndsCompactInteraction && this.#check(TokenKind.LeftBrace)) &&
        !this.#atStorageDelimiter() &&
        this.#askOptionAt(0, recognized) === null
          ? yield* parseChild(this.#parseOr())
          : null;
      if (
        slash?.kind === TokenKind.Slash &&
        this.#diagnostics.length > diagnosticCount &&
        this.#regexStarts.length === regexStartCount
      )
        this.#regexStarts.push(slash.span.start.offset);
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
        presentation,
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
      if (this.#askOptionAt(0, askOptionNames("choice")) !== null) {
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
            "askChoice takes one 'prefill:', after its options, as in 'askChoice 5, 10, prefill: 10'.",
            name.span,
          );
          this.#skipInteractionRest();
        } else if (
          !this.#isInteractionChoiceTerminator() &&
          !(this.#blockEndsCompactInteraction && this.#check(TokenKind.LeftBrace))
        ) {
          this.#reportSpan(
            parserDiagnosticCode.unsupportedInteractionForm,
            "askChoice takes one 'prefill:', after its options, as in 'askChoice 5, 10, prefill: 10'.",
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
              "The 'as speaker' clause must appear immediately after 'askChoice'.",
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
      presentation: null,
      question: null,
      hint: null,
      prefill,
      options: Object.freeze(options),
      formArguments: Object.freeze([]),
      span: spanFrom(command.span, end),
    });
  }

  /**
   * `askText [as speaker] [mode] ([question][, hint: text][, prefill: value])` and the other basic asks: the parentheses
   * hold the arguments of the compact form, so `)` ends the ask and both forms give the same interaction.
   */
  *#parseBoundedAsk(
    command: Token,
    interactionKind: Exclude<InteractionExpression["interactionKind"], "choice">,
    asSpan: SourceSpan | null,
    speaker: Identifier | null,
    presentation: ObjectLiteral | null,
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
      readAskOptionNames(interactionKind),
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
      presentation,
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
    presentation: ObjectLiteral | null,
    question: Expression | null,
    named: readonly FormArgument[],
    span: SourceSpan,
  ): InteractionExpression {
    const keepsArguments = NAMED_ASK_OPTIONS.has(interactionKind);
    const has = (name: string) => named.some((argument) => argument.name.name === name);
    if (presentation !== null && question === null && !(keepsArguments && has("message")))
      this.#reportQuestionlessPresentation(command, presentation);
    for (const required of requiredAskOptionNames(interactionKind))
      if (!has(required))
        this.#reportSpan(
          parserDiagnosticCode.unsupportedInteractionForm,
          interactionKind === "form"
            ? "askForm needs its fields, as in 'fields: { enabled: false }'."
            : `askBooleans needs ${required}:, as in 'askBooleans "Choose", texts: ["A", "B"], prefill: [true, false]'.`,
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
      presentation,
      question,
      hint: option("hint"),
      prefill: option("prefill"),
      options: Object.freeze([]),
      formArguments: Object.freeze(keepsArguments ? [...named] : []),
      span,
    });
  }

  /** A mode written for a question that the ask does not have, which would say nothing. */
  #reportQuestionlessPresentation(command: Token, presentation: ObjectLiteral): void {
    const mode = staticModeName(presentation);
    this.#reportSpan(
      parserDiagnosticCode.unsupportedInteractionForm,
      `'${mode}' shows the question, but this ${command.lexeme} has none. Write the question after '${mode}', or leave '${mode}' out.`,
      presentation.span,
    );
  }

  /**
   * Whether `bubble` or `prose` here is the mode of an ask's question rather than the question itself, read as for
   * `say`: the mode is followed by the question, as in `askText prose "Name?"`, or by the ask's parentheses after its
   * options, as in `askText prose() ("Name?")`. Parentheses right after the word that a value follows are its options,
   * as in `prose(align: "center") "Name?"`; otherwise the word starts the question, as `prose` in `askText prose + "?"`
   * or the call in `askText prose("Name?")`. Only tokens are read, so nested asks are not parsed again: before a `/`, the
   * word is the question, and a regex there is found by parsing it (see `#parseInteractionExpression`).
   */
  #atQuestionPresentation(): boolean {
    if (!this.#check(TokenKind.Identifier) || !PRESENTATION_MODES.has(this.#peek().lexeme))
      return false;
    if (this.#atSayModeBeforeBoundedText()) return true;
    const next = this.#peekAfterSayMode();
    return (
      next !== null &&
      isExpressionStart(next) &&
      !EXPRESSION_CONTINUATIONS.has(next.kind) &&
      !(this.#blockEndsCompactInteraction && next.kind === TokenKind.LeftBrace)
    );
  }

  /**
   * `askImage bubble(options) (arguments)` or `askImage prose (arguments)`: the question's mode, as for a basic ask
   * (#832). Parentheses after the mode hold its options only when the arguments follow them.
   */
  *#parseAskImageWithPresentation(): ParseTask<CallExpression | null> {
    const command = this.#advance();
    this.#shared.closers ??= delimiterClosers(this.tokens);
    const closer = this.#shared.closers.get(this.#current + 1);
    const withOptions =
      this.#peek(1).kind === TokenKind.LeftParenthesis &&
      closer !== undefined &&
      this.tokens[closer + 1]?.kind === TokenKind.LeftParenthesis;
    const presentation = yield* parseChild(this.#parseSayPresentation(withOptions));
    if (!this.#check(TokenKind.LeftParenthesis)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedDelimiter,
        `askImage takes its question in parentheses after '${staticModeName(presentation)}', as in 'askImage ${staticModeName(presentation)} ("Show me")'.`,
      );
      this.#synchronizeStatement();
      return null;
    }
    const call = yield* parseChild(
      this.#withinDelimiters(this.#finishCall(this.#identifier(command), this.#advance())),
    );
    if (
      !call.arguments.some(
        (argument) => argument.kind === "positionalArgument" || argument.name.name === "message",
      )
    )
      this.#reportQuestionlessPresentation(command, presentation);
    return Object.freeze({ ...call, presentation });
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
   * break does not end the expression, so the comma may also start the next line there (V30 §1). Nested interactions
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

  /**
   * Whether the `{` next starts the block of a block head, such as the condition of an `if`, where the head expects a
   * value, as in `if x == {`. It starts an object literal instead when a property and its `:` follow, as in
   * `if door == { open: true } {`, or when the head goes on after its `}`, as in `if box == {} {`, where a block would
   * end the statement.
   */
  #atHeadBlock(): boolean {
    if (!this.#blockEndsCompactInteraction || !this.#check(TokenKind.LeftBrace)) return false;
    const afterNewlines = this.#shared.newlineRuns.ends;
    const first = afterNewlines[this.#current + 1]!;
    if (isPropertyName(this.tokens[first]!) && this.tokens[first + 1]?.kind === TokenKind.Colon)
      return false;
    this.#shared.closers ??= delimiterClosers(this.tokens);
    const closer = this.#shared.closers.get(this.#current);
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

  *#parseObjectLiteral(start: Token): ParseTask<ObjectLiteral> {
    const properties: ObjectProperty[] = [];
    this.#skipNewlines();
    while (!this.#check(TokenKind.RightBrace) && !this.#check(TokenKind.EndOfFile)) {
      // A statement on a line of its own ends a literal left open, as after `let o = {`; `let: 1` stays a property.
      if (this.#previous().kind === TokenKind.Newline && this.#isRecoveredTopLevelStatement())
        break;
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
      // As in an object literal, a statement on a line of its own ends a dict left open.
      if (this.#previous().kind === TokenKind.Newline && this.#isRecoveredTopLevelStatement())
        break;
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

  /**
   * Skips a malformed element to the next comma or the closer, or to a statement that starts a line, which no element
   * can be: the closer is then missing, and the statement still parses, as after `let v = [` on a line of its own.
   */
  #synchronizeDelimited(closing: TokenKind): void {
    while (
      !this.#check(TokenKind.Comma) &&
      !this.#check(closing) &&
      !this.#check(TokenKind.EndOfFile) &&
      !(this.#previous().kind === TokenKind.Newline && this.#atStatementStart())
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
      (token.kind === TokenKind.Identifier && LINE_STATEMENTS.has(token.lexeme))
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

  /**
   * Inside `()`, `[]`, and object literals, where a line break does not end an expression, a binary operator may also
   * start the next line (V30 §1): skips the newlines before one, so that it continues the expression. Elsewhere a
   * newline before an operator ends the statement.
   */
  #skipNewlinesBeforeOperator(): void {
    if (!this.#insideDelimiters || !this.#check(TokenKind.Newline)) return;
    // V30 §1 does not list `${...}`, so its own expression ends at the newline, whatever encloses the string.
    if (this.#shared.openers[this.#current] === TokenKind.InterpolationStart) return;
    const after = this.#shared.newlineRuns.ends[this.#current]!;
    if (startsBinaryOperator(this.tokens, after)) this.#current = after;
  }

  #reportPositionalAfterNamed(span: SourceSpan): void {
    this.#reportSpan(
      parserDiagnosticCode.mixedArguments,
      "A positional argument may not follow a named argument. Move it before the named arguments, or name it too.",
      span,
    );
  }

  /** Reports `as` without the speaker after it, in a `say`, a `showButton`, or an ask. */
  #reportMissingSpeakerAfterAs(): void {
    this.#reportInsertion(
      parserDiagnosticCode.expectedSpeakerAfterAs,
      "Expected a speaker identifier after 'as'.",
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

  /** The span of the word operator `kind` when it comes next, which it consumes, or `null`. */
  #matchOperator(kind: TokenKind): SourceSpan | null {
    return this.#match(kind) ? this.#previous().span : null;
  }

  /** `not`, or `!`, which is reported and read as `not` (V30 §39). */
  #matchNot(): boolean {
    return (
      this.#match(TokenKind.KeywordNot) ||
      this.#matchSymbol(TokenKind.Bang, "one", "not", "if not a { ... }") !== null
    );
  }

  /** `|` or `||` between values: report the word operator and continue as `or` (V30 §5, §39). */
  #matchSymbolicOr(): SourceSpan | null {
    if (!this.#check(TokenKind.Pipe)) return null;
    if (this.#peek(1).kind === TokenKind.Pipe)
      return this.#matchSymbol(TokenKind.Pipe, "oneOrTwo", "or", "if a or b { ... }");
    const span = this.#advance().span;
    this.#reportSpan(
      parserDiagnosticCode.symbolicOperator,
      "Use 'or' to combine conditions. '|' only separates the types of a union, as in 'integer | string'.",
      span,
    );
    return span;
  }

  /**
   * A symbol that other languages use for a word operator, such as `&&` for `and`: reports the word once and returns the
   * symbol's span, so that parsing continues as with the word (V30 §5, §39), or returns `null` when it does not come
   * next. The symbol is one token of `kind`, as `!`, one or two, as `&` or `&&`, or two that touch, as `??`, which is
   * not the `?` of a type.
   */
  #matchSymbol(
    kind: TokenKind,
    form: "one" | "oneOrTwo" | "two",
    word: string,
    example: string,
  ): SourceSpan | null {
    const first = this.#peek();
    const second = this.#peek(1);
    if (first.kind !== kind) return null;
    const touching = second.kind === kind && second.span.start.offset === first.span.end.offset;
    if (form === "two" && !touching) return null;
    this.#advance();
    const last = form !== "one" && second.kind === kind ? this.#advance() : first;
    const symbol = last === first ? first.lexeme : first.lexeme + last.lexeme;
    const span = spanFrom(first.span, last.span);
    this.#reportSpan(
      parserDiagnosticCode.symbolicOperator,
      `TeaseScript writes '${word}' instead of '${symbol}': ${example}`,
      span,
    );
    return span;
  }

  /**
   * Whether the expression parser skips a newline after the token at `index`: a binary operator, the comma of a compact
   * choice, or a symbol that it reads as a word operator, such as `&&` or the second `?` of `??`.
   */
  #continuesAfter(index: number): boolean {
    const token = this.tokens[index]!;
    const before = this.tokens[index - 1];
    return (
      continuesExpression(token.kind) ||
      (token.kind === TokenKind.Question &&
        before?.kind === TokenKind.Question &&
        before.span.end.offset === token.span.start.offset)
    );
  }

  #checkIdentifier(name: string): boolean {
    return this.#check(TokenKind.Identifier) && this.#peek().lexeme === name;
  }

  /** The word of `COMMANDS` that the current identifier is, when the parser reads it here as a statement or a value. */
  #commandAt(form: "statement"): StatementCommand | null;
  #commandAt(form: "value"): ValueCommand | null;
  #commandAt(form: "statement" | "value"): StatementCommand | ValueCommand | null {
    const token = this.#peek();
    if (token.kind !== TokenKind.Identifier || !isCommand(token.lexeme)) return null;
    if (commandFacts(token.lexeme)?.[form] === undefined) return null;
    // EVIDENCE: invariant: the word's facts give it the form, which is what each of the two types selects.
    return token.lexeme as StatementCommand | ValueCommand;
  }

  /**
   * Whether a word is where a declaration's name belongs: an identifier, or a keyword, which `#declarationName` reads as
   * the name so that the declaration gets the protected-name diagnostic with its fix.
   */
  #checkDeclarationName(): boolean {
    return isWord(this.#peek());
  }

  /**
   * Reads the name of a declaration. A protected name (V30 §38) is an error that names another, as for `let wait = 5`,
   * which gives the name check's diagnostic (TSV001) also here, where the name is read, so it is reported when a later
   * use of the name, such as `${timer}`, cannot be parsed and the name check does not run.
   */
  #declarationName(declaration: "label" | "speaker" | "other"): Identifier {
    const token = this.#advance();
    if (PROTECTED_NAMES.has(token.lexeme))
      this.#reportToken(
        parserDiagnosticCode.protectedName,
        protectedNameMessage(token.lexeme, declaration),
        token,
      );
    return this.#identifier(token);
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

/**
 * The type names that are identifiers: every kind that an annotation writes (`VALUE_KINDS`), but those that the lexer
 * reads as a token of their own, `speaker`, `set`, and `null` (`typeName`).
 */
const IDENTIFIER_TYPE_NAMES: ReadonlyMap<string, TypeName> = new Map(
  VALUE_KIND_NAMES.filter(
    (kind): kind is TypeName => VALUE_KINDS[kind].written && !KEYWORD_TOKENS.has(kind),
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

/** The mode a presentation object was written with: its first property, `kind`, holds `bubble` or `prose`. */
function staticModeName(presentation: ObjectLiteral): string {
  const kind = presentation.properties[0]!.value;
  return kind.kind === "stringLiteral" && kind.parts[0]?.kind === "stringText"
    ? kind.parts[0].value
    : "prose";
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
  TokenKind.KeywordOtherwise,
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
    token.kind === TokenKind.RegexLiteral ||
    token.kind === TokenKind.KeywordSpeaker ||
    token.kind === TokenKind.KeywordSay ||
    token.kind === TokenKind.KeywordWait ||
    token.kind === TokenKind.KeywordTrue ||
    token.kind === TokenKind.KeywordFalse ||
    token.kind === TokenKind.KeywordNull ||
    token.kind === TokenKind.KeywordSet ||
    token.kind === TokenKind.KeywordNot ||
    // `!`, which the parser reads as `not` once it reported it.
    token.kind === TokenKind.Bang ||
    token.kind === TokenKind.LeftParenthesis ||
    token.kind === TokenKind.LeftBracket ||
    token.kind === TokenKind.LeftBrace ||
    token.kind === TokenKind.Plus ||
    token.kind === TokenKind.Minus
  );
}

/** Whether a token is a word: an identifier, or a keyword that the lexer reads as a token of its own. */
function isWord(token: Token): boolean {
  return token.kind === TokenKind.Identifier || KEYWORD_TOKENS.get(token.lexeme) === token.kind;
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
