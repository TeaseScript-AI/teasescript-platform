import { sessionDeclarations } from "./project-globals.js";
import type {
  Expression,
  InteractionExpression,
  MediaParts,
  Program,
  SayParts,
  ShowButtonParts,
  Statement,
  TimerParts,
  ShowPermanentButtonParts,
  TypeAnnotation,
} from "./ast.js";
import { compileProject, compileSource, isNativeStackExhaustion } from "./compiler.js";
import { conversionSyntax, CONVERSIONS, isConversion, type Conversion } from "./conversions.js";
import {
  isNumericFunction,
  NUMERIC_CONTRACTS,
  numericSyntax,
  type NumericFunction,
} from "./numeric-functions.js";
import {
  isRandomFunction,
  RANDOM_CONTRACTS,
  randomSyntax,
  type RandomFunction,
} from "./random-functions.js";
import {
  CLOCK_CONTRACTS,
  isClockFunction,
  isTemporalMethod,
  TEMPORAL_METHODS,
  temporalSyntax,
  type TemporalMethodName,
} from "./temporal-builtins.js";
import {
  isTextMethod,
  isTextOnlyMethod,
  TEXT_METHODS,
  textMethodSyntax,
  type TextMethodName,
} from "./text-operations.js";
import {
  isListFunction,
  LIST_FUNCTION_CONTRACTS,
  listFunctionSyntax,
  takesValues,
  type ListFunction,
} from "./list-function-rules.js";
import {
  isListMethod,
  LIST_METHODS,
  listMethodSyntax,
  type ListMethod,
  type ListMethodName,
} from "./list-methods.js";
import { isDictMethod } from "./dict-operations.js";
import {
  handleMethodSyntax,
  isAnyHandleMethod,
  sharedHandleMethodSummary,
  type AnyHandleMethodName,
} from "./handle-members.js";
import {
  askParts,
  sayOperands,
  mediaHandlerBlocks,
  mediaOperands,
  showButtonOptions,
  tagQueryOperands,
  timerOperands,
} from "./expression-children.js";
import type { Diagnostic } from "./diagnostics.js";
import type { ProjectImageFile } from "./image-catalog.js";
import { lex } from "./lexer.js";
import { MESSAGE_PRESENTATION_OPTIONS } from "./message-presentation.js";
import { parse, type ParseResult, type StatementRange } from "./parser.js";
import { askOptionNames, requiredAskOptionNames } from "./parser/asks.js";
import {
  EXPORT_TEXT_OPTIONS,
  OPEN_URL_OPTIONS,
  PERMANENT_BUTTON_OPTIONS,
  SHOW_BUTTON_OPTIONS,
  SHOW_POPUP_OPTIONS,
} from "./parser/buttons-and-popups.js";
import { MEDIA_ARGUMENTS } from "./parser/media.js";
import { TIMER_ARGUMENTS, TIMER_DISPLAYS } from "./parser/timers.js";
import { compareProjectPaths } from "./project-paths.js";
import {
  COMMANDS,
  commandFacts,
  isAsk,
  isCommand,
  startsCallForm,
  TEASESCRIPT_GRAMMAR_KEYWORDS,
  TEASESCRIPT_PROTECTED_NAMES,
  TEASESCRIPT_PROTECTED_TYPE_NAMES,
  type AskCommand,
  type CommandName,
  type ClockFunctionName,
  type ConversionName,
  type ListFunctionName,
  type NumericFunctionName,
  type RandomFunctionName,
  type RenamedCommand,
  type StatementCommand,
  type ValueCommand,
} from "./language-facts.js";
import {
  createSourcePosition,
  createSourceSpan,
  type SourcePosition,
  type SourceSpan,
} from "./source.js";
import type { ScriptHeader } from "./script-header.js";
import { TokenKind, type Token } from "./token.js";

export interface LanguageDocument {
  readonly uri: string;
  readonly text: string;
}

export type LanguagePosition = SourcePosition;
export type LanguageRange = SourceSpan;
export type LanguageDiagnostic = Diagnostic;

/** One file of a project, by its path relative to the package root. */
export interface LanguageProjectFile {
  readonly path: string;
  readonly text: string;
}

/** What an editor's overview of many files shows about one of them. */
export interface LanguageFileOverview {
  readonly path: string;
  /** The file's `---` header, with its title, author, description, and tags; `null` when it has none. */
  readonly header: ScriptHeader | null;
  readonly diagnostics: readonly LanguageDiagnostic[];
}

export type LanguageCompletionKind = "keyword" | "command" | "speaker" | "modifier" | "value";

export interface LanguageCompletionItem {
  readonly label: string;
  readonly kind: LanguageCompletionKind;
  readonly detail: string;
  readonly insertText: string;
}

export interface LanguageContextHelp {
  /**
   * A command, or a built-in function or a method of text or of date and time values called at the position (see
   * `ContractCall`).
   */
  readonly command: CompactCommand | OtherCommand | ContractName;
  readonly summary: string;
  readonly syntax: string;
}

export interface LanguageHover {
  readonly range: LanguageRange;
  readonly contents: readonly string[];
}

export interface LanguageSignatureHelp {
  readonly label: string;
  readonly documentation: string;
  readonly activeParameter: number;
  readonly parameters: readonly string[];
}

export interface LanguageTextEdit {
  readonly range: LanguageRange;
  readonly newText: string;
}

export interface LanguageFormatResult {
  readonly edits: readonly LanguageTextEdit[];
  readonly text: string;
}

/** What a token or comment is, for its colour (see `classifyTokens`). */
export const LANGUAGE_TOKEN_CLASSES = Object.freeze([
  "keyword",
  "type",
  "command",
  "name",
  "number",
  "string",
  "interpolation",
  "regex",
  "comment",
  "operator",
  "punctuation",
] as const);

export type LanguageTokenClass = (typeof LANGUAGE_TOKEN_CLASSES)[number];

export interface LanguageToken {
  readonly kind: LanguageTokenClass;
  readonly span: LanguageRange;
}

/** The asks under their current names (see `COMMANDS`). */
type Ask = Exclude<AskCommand, RenamedCommand>;
/** The compact interactions, and `say`, which take a speaker and have help of their own. */
type CompactCommand = "showButton" | Ask | "say";
type GrammarKeyword = (typeof TEASESCRIPT_GRAMMAR_KEYWORDS)[number];
/** The other commands of the engine (see `COMMANDS`), and `wait`, which the lexer reads as a token of its own. */
type OtherCommand = Exclude<CommandName, GrammarKeyword | RenamedCommand | CompactCommand> | "wait";

/** What a named option takes, for a syntax line; a prefill is written per ask, as the answer it gives. */
const OPTION_VALUES: Readonly<Record<string, string>> = {
  hint: "text",
  background: "colour",
  timeout: "duration",
  message: "question",
  yesText: "text",
  noText: "text",
  outro: "text",
  texts: "list",
  fields: "object",
  buttonText: "text",
  alwaysButton: "boolean",
  title: "text",
  fileName: "text",
  duration: "duration",
  async: "boolean",
  display: TIMER_DISPLAYS.map((display) => `"${display}"`).join("|"),
  label: "text",
  persist: "boolean",
  file: "file",
  startAt: "duration",
  endAt: "duration",
  volume: "number",
};

/** The completion of each command that starts a statement (see `COMMANDS`), by what it does. */
const STATEMENT_COMPLETIONS: Readonly<Record<Exclude<StatementCommand, GrammarKeyword>, string>> = {
  showButton: "Compact foreground button interaction",
  showPopup: "Show a popup message and wait until it is closed",
  showImage: "Show an image on the Stage",
  hideImage: "Hide the Stage image",
  hideCamera: "Hide every camera view",
  openUrl: "Offer a link to a web page",
  exportText: "Offer text to copy or download",
  stopAudio: "Stop every sound",
  timer: "Start a timer",
  showCamera: "Show the camera view in a window, or over the Stage with 'stage'",
  showPermanentButton: "Show a button that stays until it is removed",
  playAudio: "Play an audio file",
  playVideo: "Play a video file",
};

/** The completion of each command that gives a value (see `COMMANDS`), by what it gives. */
const VALUE_COMPLETIONS: Readonly<
  Record<Exclude<ValueCommand, GrammarKeyword | RenamedCommand>, string>
> = {
  showButton: "Compact foreground button interaction",
  showPopup: "Show a popup and give how long it was open",
  timer: "Start a timer and give its handle",
  showCamera: "Show the camera view and give its handle",
  showPermanentButton: "Show a permanent button and give its handle",
  playAudio: "Play an audio file; with 'async', give its handle",
  playVideo: "Play a video file; with 'async', give its handle",
  askText: "Compact text-input expression",
  askNumber: "Compact numeric-input expression",
  askInteger: "Compact whole-number input expression",
  askDate: "Compact date input expression",
  askTime: "Compact time input expression",
  askDateTime: "Compact date and time input expression",
  askPassword: "Compact password input expression",
  askBoolean: "Compact yes-or-no expression",
  askForm: "Compact form expression",
  askBooleans: "Compact expression of several yes-or-no choices",
  askChoice: "Compact choice expression",
};

const ASK_HEAD = "[as speaker] [bubble(options)|prose(options)] [question]";

const BUBBLE_OPTIONS: readonly string[] = MESSAGE_PRESENTATION_OPTIONS.bubble;
/** The options of the modes of a message, for the help of `say`. */
const MODE_OPTIONS = `The mode bubble(...) takes the options ${listed(BUBBLE_OPTIONS)}, and prose(...) also ${listed(MESSAGE_PRESENTATION_OPTIONS.prose.filter((option) => !BUBBLE_OPTIONS.includes(option)))}.`;

const HELP: Readonly<Record<CompactCommand, LanguageContextHelp>> = Object.freeze({
  showButton: help(
    "showButton",
    "Shows one foreground button and waits for activation. An optional timeout, such as 5 s or 500 ms, removes the button without a chat message when it runs out. As a value, it returns the elapsed waiting time as a duration, which equals the timeout when the timeout is reached.",
    "[as speaker] label",
  ),
  askText: help(
    "askText",
    "Waits for submitted text. Line endings are normalized while other whitespace is preserved; whitespace-only input is rejected and retried. The asking speaker says the optional question in the chat before the field opens. An optional hint is shown in the field, not in the chat. An optional prefill answer fills the field at first; submitting it unchanged returns it.",
    ASK_HEAD,
    "answer",
  ),
  askNumber: help(
    "askNumber",
    "Waits for numeric text, trims surrounding whitespace, accepts the TeaseScript numeric grammar, requires a finite value, and returns negative zero as canonical numeric 0 while preserving the trimmed submitted text in the transcript. An optional prefill number fills the field at first.",
    ASK_HEAD,
    "number",
  ),
  askInteger: help(
    "askInteger",
    "Waits for a whole number: an optional sign and digits, with surrounding whitespace trimmed. Decimals, exponents, and values outside the safe integer range are rejected and asked again. Returns an integer. An optional prefill whole number fills the field at first.",
    ASK_HEAD,
    "integer",
  ),
  askDate: help(
    "askDate",
    "Waits for a date from the Player's date control, which submits ISO text such as 2026-10-04. Returns a date. An optional prefill date fills the control at first.",
    ASK_HEAD,
    "date",
  ),
  askTime: help(
    "askTime",
    "Waits for a time of day from the Player's time control, which submits ISO text such as 14:30. Returns a time. An optional prefill time fills the control at first.",
    ASK_HEAD,
    "time",
  ),
  askDateTime: help(
    "askDateTime",
    "Waits for a local date and time from the Player's control, which submits ISO text such as 2026-10-04T18:00. Returns a datetime; a time that the player's zone skips is still a valid local value. An optional prefill fills the control at first.",
    ASK_HEAD,
    "datetime",
  ),
  askPassword: help(
    "askPassword",
    "Waits for a password in a masked field and returns the SHA-256 of what was typed, as hashText gives it, never the text itself. Written directly as 'password:' of an encrypt or decrypt call, the typed text locks or opens instead and never becomes a value.",
    ASK_HEAD,
  ),
  askBoolean: help(
    "askBoolean",
    "Waits for one of two buttons and returns true for the yesText button, by default Yes, or false for the noText button, by default No. The question may also be written as message. An optional prefill of true or false preselects that button, which the player still has to choose.",
    ASK_HEAD,
    "boolean",
  ),
  askForm: help(
    "askForm",
    "Asks for several values at once and returns them when the player submits. The fields option is an object or a dict of fields, each a starting value or a descriptor. The submit and cancel options give the texts of their buttons, and with cancel the form returns null when cancelled. An optional outro is said after the descriptions of the fields, and timeout with onTimeout gives the form a time limit.",
    ASK_HEAD,
  ),
  askBooleans: help(
    "askBooleans",
    "Shows one toggle per text and returns their states in the same order. The texts and prefill lists have the same length, and with cancel it returns null when cancelled. The question may also be written as message.",
    ASK_HEAD,
    "booleans",
  ),
  askChoice: help(
    "askChoice",
    "Waits for one choice and returns the selected button's value: the value written before ':', or else the option itself with its own type. A list option gives one button per element, and a set one per member; an element may be a { value?, text, background? } object. An optional prefill after the options preselects the button that returns its value.",
    "[as speaker] [value:] option, [value:] option, ...",
    "value",
  ),
  say: Object.freeze({
    command: "say" as const,
    summary:
      "Emits visible chat text; a list, set, dict, or object shows in literal notation without markup. Pacing is smart by default. It can also be an exact duration of 0 seconds or more, such as 2 s, or instant. Skip policy may be skippable or unskippable. Used as a value, it gives the message's messageHandle, whose text property changes the message in place; inside a list or call, write say(text, pacing). " +
      MODE_OPTIONS,
    syntax:
      "say [as speaker] [bubble(options)|prose(options)] [skippable|unskippable] text [, pacing|instant]  or  say [as speaker] [bubble(options)|prose(options)] [skippable|unskippable] (text [, pacing|instant])",
  }),
});

/** The help of a command that is no compact interaction, and the parameters of its signature, as its line has them. */
interface CommandHelp {
  readonly help: LanguageContextHelp;
  readonly parameters: readonly string[];
}

const COMMAND_HELP: Readonly<Record<OtherCommand, CommandHelp>> = Object.freeze({
  showPopup: commandHelp(
    "showPopup",
    "Shows a dialog outside the chat with the message and one button, OK by default, and waits until the player closes it. Only the call form takes buttonText, which renames the button. As a value, it returns how long the popup was open as a duration.",
    `showPopup message  or  showPopup(message${optionalOptions(SHOW_POPUP_OPTIONS)})`,
    ["message", ...SHOW_POPUP_OPTIONS],
  ),
  showImage: commandHelp(
    "showImage",
    "Shows an image on the Stage until the next showImage or hideImage. The image is a file reference, or tagged with tags for a random package image that has them; null clears the Stage.",
    "showImage file  or  showImage tagged tag, ...",
    ["file"],
  ),
  hideImage: commandHelp(
    "hideImage",
    "Clears the Stage image. It takes no arguments.",
    "hideImage",
    [],
  ),
  hideCamera: commandHelp(
    "hideCamera",
    "Hides every camera view. It takes no arguments.",
    "hideCamera",
    [],
  ),
  openUrl: commandHelp(
    "openUrl",
    "Opens an http or https web address in a new tab and waits until it is open. When the browser needs a click first, the Player shows a button, whose text is buttonText, Open link by default; with alwaysButton: true it always shows the button and waits for the click.",
    `openUrl(url${optionalOptions(OPEN_URL_OPTIONS)})`,
    ["url", ...OPEN_URL_OPTIONS],
  ),
  exportText: commandHelp(
    "exportText",
    "Shows the text in a dialog with the buttons Copy, Download, and Close, and waits until the player closes it. The title is Copy or download by default, and a download is saved as fileName, text.txt by default. It gives no value.",
    `exportText(text${optionalOptions(EXPORT_TEXT_OPTIONS)})`,
    ["text", ...EXPORT_TEXT_OPTIONS],
  ),
  stopAudio: commandHelp(
    "stopAudio",
    "Stops every running or paused sound of the session. It takes no arguments; to stop one sound, call stop() on its handle.",
    "stopAudio",
    [],
  ),
  timer: commandHelp(
    "timer",
    "Counts down a duration, such as 30 s or (5..10) s, and waits until the time is up. It is visible by default, or mystery or hidden, and an optional label names it. With async the script continues: as a value it returns the timer's handle, a block runs when it expires, and the named form's repeat starts another round after each one and persist keeps the timer when its file is left.",
    `timer [async] [${TIMER_DISPLAYS.join("|")}] duration [label] [{ ... }]  or  ${namedForm("timer", TIMER_ARGUMENTS, { repeat: "boolean" })} [{ ... }]`,
    TIMER_ARGUMENTS,
  ),
  showCamera: commandHelp(
    "showCamera",
    "Shows the camera's live view in the Player's floating window, or with stage over the Stage image. As a value, it returns the camera view's handle.",
    "showCamera [stage]",
    ["stage"],
  ),
  showPermanentButton: commandHelp(
    "showPermanentButton",
    "Shows a button that stays while the script continues, and returns its handle. The block runs when the button is clicked. With persist: true the button stays when its file is left by goto or end, and every permanent button disappears on exit.",
    `showPermanentButton text${optionalOptions(PERMANENT_BUTTON_OPTIONS)} { ... }`,
    ["text", ...PERMANENT_BUTTON_OPTIONS],
  ),
  playAudio: mediaHelp("playAudio", "Plays an audio file"),
  playVideo: mediaHelp("playVideo", "Plays a video file on the Stage"),
  wait: commandHelp(
    "wait",
    "Waits for an exact duration, such as 2 s, or a range with a unit, such as (1..3) s. After a paced message it starts when the message's reading time ends.",
    "wait duration",
    ["duration"],
  ),
});

export function createLanguageDocument(uri: string, text: string): LanguageDocument {
  return Object.freeze({ uri, text });
}

export function languagePositionAt(document: LanguageDocument, offset: number): LanguagePosition {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > document.text.length) {
    throw new RangeError("Language document offset is outside the document.");
  }
  return positionAtOffset(offset, lineStarts(document.text), document.text);
}

export function languageDiagnostics(document: LanguageDocument): readonly LanguageDiagnostic[] {
  return compileSource(document.text).diagnostics;
}

/**
 * Compiles the files as one project, with the package images when given, and describes each file: `main.tease`
 * first, then the others by path.
 */
export function languageProjectOverview(
  files: readonly LanguageProjectFile[],
  options: { readonly images?: readonly ProjectImageFile[] } = {},
): readonly LanguageFileOverview[] {
  const result = compileProject(
    files.map(({ path, text }) => ({ path, source: text })),
    options.images === undefined ? {} : { images: options.images },
  );
  const headers = new Map(result.files.map((file) => [file.path, file.header]));
  const diagnostics = new Map<string, LanguageDiagnostic[]>();
  for (const { path, ...diagnostic } of result.diagnostics) {
    const list = diagnostics.get(path) ?? [];
    list.push(Object.freeze(diagnostic));
    diagnostics.set(path, list);
  }
  // A project diagnostic may name a path without a file, such as a missing main.tease.
  const paths = [...new Set([...files.map((file) => file.path), ...diagnostics.keys()])].sort(
    compareProjectPaths,
  );
  return Object.freeze(
    paths.map((path) =>
      Object.freeze({
        path,
        header: headers.get(path) ?? null,
        diagnostics: Object.freeze(diagnostics.get(path) ?? []),
      }),
    ),
  );
}

export function languageCompletions(
  document: LanguageDocument,
  position: LanguagePosition,
): readonly LanguageCompletionItem[] {
  const offset = position.offset;
  if (offset < 0 || offset > document.text.length) return Object.freeze([]);
  const prefix = document.text.slice(0, offset);
  const regexStarts = regexStartsWithin(parseDocument(document.text).regexStarts, 0, offset);
  const tokens = lex(prefix, regexStarts).tokens.filter(
    (token) => token.kind !== TokenKind.EndOfFile,
  );
  const significant = tokens.filter((token) => token.kind !== TokenKind.Newline);
  const last = significant.at(-1);
  const lineTokens = tokensAfterLastNewline(tokens);
  const items: LanguageCompletionItem[] = [];

  const statementStart = lineTokens.length === 0 || isStatementBoundary(last);
  if (statementStart) {
    items.push(command("say", "Emit chat text with optional speaker, skip policy, and pacing"));
    for (const [name, detail] of Object.entries(STATEMENT_COMPLETIONS))
      items.push(command(name, detail));
  }

  if (isExpressionCompletionContext(last, lineTokens)) {
    for (const [name, detail] of Object.entries(VALUE_COMPLETIONS))
      items.push(command(name, detail));
    items.push(
      Object.freeze({
        label: "takePhoto",
        kind: "command",
        detail: "Capture a photo from the session camera; null when no camera is available",
        insertText: "takePhoto()",
      }),
    );
  }

  const compact = compactCommandContext(lineTokens);
  if (compact !== null) {
    if (compact.stage === "afterCommand") {
      items.push(keyword("as", "Optional speaker clause"));
      if (compact.command === "say") {
        items.push(modifier("skippable", "Allow the current pacing gate to be skipped"));
        items.push(modifier("unskippable", "Do not allow the current pacing gate to be skipped"));
      }
    }
    if (compact.stage === "afterAs") {
      for (const speaker of declaredSpeakers(document.text)) {
        items.push(
          Object.freeze({
            label: speaker,
            kind: "speaker",
            detail: "Declared speaker",
            insertText: speaker,
          }),
        );
      }
    }
    if (compact.command === "say" && compact.stage === "afterComma") {
      items.push(value("instant", "Disable pacing delay"));
      items.push(value("0 s", "Exact zero-second pacing"));
    }
  }

  return dedupe(items);
}

export function languageContextHelp(
  document: LanguageDocument,
  position: LanguagePosition,
): LanguageContextHelp | null {
  return locateHelp(document, position.offset)?.help ?? null;
}

export function languageHover(
  document: LanguageDocument,
  position: LanguagePosition,
): LanguageHover | null {
  const located = locateHelp(document, position.offset);
  if (located === null) return null;
  const { help } = located;
  return Object.freeze({
    range: located.range,
    contents: Object.freeze([`**${help.command}**`, help.summary, `Syntax: \`${help.syntax}\``]),
  });
}

export function languageSignatureHelp(
  document: LanguageDocument,
  position: LanguagePosition,
): LanguageSignatureHelp | null {
  const found = locateHelp(document, position.offset);
  if (found !== null && found.call !== null) {
    const { parameters, activeParameter } = callParameters(document, found.call, position.offset);
    return Object.freeze({
      label: found.help.syntax,
      documentation: found.help.summary,
      activeParameter,
      parameters,
    });
  }
  const command = found?.command;
  if (command !== undefined && command !== null) {
    const { help, parameters } = COMMAND_HELP[command.name];
    return Object.freeze({
      label: help.syntax,
      documentation: help.summary,
      activeParameter: command.option === null ? 0 : parameters.indexOf(command.option),
      parameters,
    });
  }
  const located = locateCompactCommand(document, position.offset);
  if (located === null) return null;
  const help = HELP[located.command];
  const parameters = signatureParameters(located.command);
  return Object.freeze({
    label: help.syntax,
    documentation: help.summary,
    activeParameter: activeParameterFor(
      document.text,
      located.command,
      located.range.start.offset,
      position.offset,
      parseDocument(document.text).regexStarts,
    ),
    parameters,
  });
}

export function formatLanguageDocument(document: LanguageDocument): LanguageFormatResult {
  const compilation = compileSource(document.text);
  if (
    compilation.plan === null ||
    compilation.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    return Object.freeze({ edits: Object.freeze([]), text: document.text });
  }

  // Where the parse found regex literals that lexing a `say` alone could take for division.
  const regexStarts = parseDocument(document.text).regexStarts;
  const rawEdits: OffsetEdit[] = [];
  visitProgram(compilation.program, {
    showButton(node) {
      formatShowButton(document.text, node, rawEdits);
    },
    interaction(node) {
      formatInteraction(document.text, node, rawEdits);
    },
    say(node) {
      formatSay(document.text, node, regexStarts, rawEdits);
    },
  });
  const normalized = normalizeOffsetEdits(rawEdits);
  const starts = lineStarts(document.text);
  const edits = Object.freeze(
    normalized.map((edit) =>
      Object.freeze({
        range: createSourceSpan(
          positionAtOffset(edit.start, starts, document.text),
          positionAtOffset(edit.end, starts, document.text),
        ),
        newText: edit.newText,
      }),
    ),
  );
  return Object.freeze({ edits, text: applyLanguageTextEdits(document, edits) });
}

export function applyLanguageTextEdits(
  document: LanguageDocument,
  edits: readonly LanguageTextEdit[],
): string {
  const ordered = [...edits].sort(
    (left, right) => right.range.start.offset - left.range.start.offset,
  );
  let text = document.text;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of ordered) {
    if (edit.range.end.offset > previousStart) throw new RangeError("Language text edits overlap.");
    text =
      text.slice(0, edit.range.start.offset) + edit.newText + text.slice(edit.range.end.offset);
    previousStart = edit.range.start.offset;
  }
  return text;
}

/**
 * The class of every token of `text` and every comment, in source order, for an editor or a code view to colour. `text`
 * is lexed as `parsed`, its parse, read it, by default the parse editor help and formatting share, so a `/` the parser
 * read as a regex starts one (V30 §8). A word's class comes from the language facts: a grammar keyword (V30 §38) is a
 * `keyword`, a protected type name a `type`, and a command or an ask that the parser reads by name (`COMMANDS`) a
 * `command`; a built-in function or engine reference, such as `round`, `pi`, or `player`, is a `name`, as the themes
 * have no colour of their own for it. A word in a written type is a `type`, a message mode, skip word, or `instant`
 * where the parse read it so a `keyword`, and a unit, a word after `.`, and a word before `:`, a key, a named
 * argument's label, or a declared name, are `name`s. A source with errors still has a class for every token the lexer
 * reads. Whitespace and line breaks have none.
 */
export function classifyTokens(
  text: string,
  parsed: ParseResult = parseDocument(text),
): readonly LanguageToken[] {
  const { tokens, comments } = lex(text, parsed.regexStarts);
  const { types, modifiers } = syntaxReadings(parsed.program);
  const classified: LanguageToken[] = [];
  let comment = 0;
  // The written types that start at or before the token, and the furthest end among them.
  let type = 0;
  let typeEnd = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const start = token.span.start.offset;
    // Comments lie between tokens; only a block comment's line breaks are tokens, inside it.
    while (comment < comments.length && comments[comment]!.start.offset < start)
      classified.push(Object.freeze({ kind: "comment", span: comments[comment++]! }));
    while (type < types.length && types[type]!.start.offset <= start)
      typeEnd = Math.max(typeEnd, types[type++]!.end.offset);
    const kind = modifiers.has(start)
      ? "keyword"
      : tokenClass(token, tokens[index - 1], tokens[index + 1], start < typeEnd);
    if (kind !== null) classified.push(Object.freeze({ kind, span: token.span }));
  }
  return Object.freeze(classified);
}

const GRAMMAR_KEYWORDS: ReadonlySet<string> = new Set(TEASESCRIPT_GRAMMAR_KEYWORDS);
const TYPE_NAMES: ReadonlySet<string> = new Set(TEASESCRIPT_PROTECTED_TYPE_NAMES);

/** The symbols that group and separate; the other symbols are operators. */
const PUNCTUATION: ReadonlySet<TokenKind> = new Set([
  TokenKind.LeftBrace,
  TokenKind.RightBrace,
  TokenKind.LeftBracket,
  TokenKind.RightBracket,
  TokenKind.LeftParenthesis,
  TokenKind.RightParenthesis,
  TokenKind.Colon,
  TokenKind.Comma,
  TokenKind.Dot,
  TokenKind.Question,
  TokenKind.Pipe,
]);

function tokenClass(
  token: Token,
  previous: Token | undefined,
  next: Token | undefined,
  inType: boolean,
): LanguageTokenClass | null {
  // A property, a method, a key, or a label in `name:` is no protected name.
  const named = previous?.kind === TokenKind.Dot || next?.kind === TokenKind.Colon;
  switch (token.kind) {
    case TokenKind.Newline:
    case TokenKind.EndOfFile:
      return null;
    case TokenKind.Identifier: {
      if (named) return "name";
      if (inType || TYPE_NAMES.has(token.lexeme)) return "type";
      if (GRAMMAR_KEYWORDS.has(token.lexeme)) return "keyword";
      return isCommand(token.lexeme) ? "command" : "name";
    }
    case TokenKind.NumberLiteral:
      return "number";
    case TokenKind.StringStart:
    case TokenKind.StringText:
    case TokenKind.StringEnd:
      return "string";
    case TokenKind.InterpolationStart:
    case TokenKind.InterpolationEnd:
      return "interpolation";
    case TokenKind.RegexLiteral:
      return "regex";
  }
  if (!token.kind.startsWith("keyword"))
    return PUNCTUATION.has(token.kind) ? "punctuation" : "operator";
  if (named) return "name";
  // In a written type `set`, `speaker`, and `null` name types.
  return inType ? "type" : "keyword";
}

/** The kinds of written type, whose every word names a type. */
const TYPE_ANNOTATION_KINDS = {
  namedType: true,
  listType: true,
  setType: true,
  dictType: true,
  optionalType: true,
  unionType: true,
} satisfies Record<TypeAnnotation["kind"], true>;

/**
 * Where the parse read words for what they are there: the written types, by start, and the start of every message mode,
 * skip word, and `instant` it read as one.
 */
function syntaxReadings(program: Program): {
  readonly types: readonly SourceSpan[];
  readonly modifiers: ReadonlySet<number>;
} {
  const types: SourceSpan[] = [];
  const modifiers = new Set<number>();
  // The tree is walked with a list rather than by recursion, as valid source may nest deeper than the call stack
  // reaches.
  const pending: unknown[] = [program.statements];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null) continue;
    if (Array.isArray(node)) {
      for (const item of node) pending.push(item);
      continue;
    }
    // EVIDENCE: the parser's syntax tree holds plain nodes, arrays, and values, and a node's spans are SourceSpans.
    const record = node as {
      readonly [key: string]: unknown;
      readonly kind?: unknown;
      readonly span?: SourceSpan;
      readonly presentation?: { readonly span: SourceSpan } | null;
      readonly skipPolicySpan?: SourceSpan | null;
      readonly instantSpan?: SourceSpan | null;
    };
    if (
      typeof record.kind === "string" &&
      Object.hasOwn(TYPE_ANNOTATION_KINDS, record.kind) &&
      record.span !== undefined
    ) {
      types.push(record.span);
      continue;
    }
    // A presentation, of a `say` or an ask's question, starts with its mode word.
    for (const span of [record.presentation?.span, record.skipPolicySpan, record.instantSpan])
      if (span !== undefined && span !== null) modifiers.add(span.start.offset);
    for (const key in record)
      if (key !== "span" && !key.endsWith("Span")) pending.push(record[key]);
  }
  types.sort((left, right) => left.start.offset - right.start.offset);
  return { types, modifiers };
}

function command(label: string, detail: string): LanguageCompletionItem {
  return Object.freeze({ label, kind: "command", detail, insertText: label });
}
function keyword(label: string, detail: string): LanguageCompletionItem {
  return Object.freeze({ label, kind: "keyword", detail, insertText: label });
}
function modifier(label: string, detail: string): LanguageCompletionItem {
  return Object.freeze({ label, kind: "modifier", detail, insertText: label });
}
function value(label: string, detail: string): LanguageCompletionItem {
  return Object.freeze({ label, kind: "value", detail, insertText: label });
}

function dedupe(items: readonly LanguageCompletionItem[]): readonly LanguageCompletionItem[] {
  const seen = new Set<string>();
  return Object.freeze(
    items.filter((item) => {
      if (seen.has(item.label)) return false;
      seen.add(item.label);
      return true;
    }),
  );
}

function tokensAfterLastNewline(tokens: readonly Token[]): readonly Token[] {
  let index = tokens.length;
  while (index > 0 && tokens[index - 1]?.kind !== TokenKind.Newline) index -= 1;
  return tokens.slice(index);
}

function isStatementBoundary(token: Token | undefined): boolean {
  return token?.kind === TokenKind.RightBrace;
}

function isExpressionCompletionContext(
  last: Token | undefined,
  lineTokens: readonly Token[],
): boolean {
  if (lineTokens.length === 0) return false;
  if (last === undefined) return false;
  return (
    last.kind === TokenKind.Equal ||
    last.kind === TokenKind.KeywordReturn ||
    // A fallback may ask, as in `nickname otherwise askText "Name?"` (V30 §18).
    last.kind === TokenKind.KeywordOtherwise ||
    last.kind === TokenKind.LeftParenthesis ||
    last.kind === TokenKind.LeftBracket ||
    last.kind === TokenKind.Colon ||
    last.kind === TokenKind.Comma
  );
}

type CompactStage = "afterCommand" | "afterAs" | "afterComma" | "other";

function compactCommandContext(
  tokens: readonly Token[],
): { command: CompactCommand; stage: CompactStage } | null {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    const command = tokenToCompactCommand(token);
    if (command === null) continue;
    const tail = tokens.slice(index + 1);
    if (tail.length === 0) return { command, stage: "afterCommand" };
    if (tail.at(-1)?.kind === TokenKind.KeywordAs) return { command, stage: "afterAs" };
    if (command === "say" && tail.at(-1)?.kind === TokenKind.Comma)
      return { command, stage: "afterComma" };
    return { command, stage: "other" };
  }
  return null;
}

function tokenToCompactCommand(token: Token): CompactCommand | null {
  if (token.kind === TokenKind.KeywordSay) return "say";
  if (token.kind !== TokenKind.Identifier) return null;
  if (token.lexeme === "showButton" || isCurrentAsk(token.lexeme)) return token.lexeme;
  return null;
}

/** Whether `name` is an ask under its current name. */
function isCurrentAsk(name: string): name is Ask {
  return isAsk(name) && commandFacts(name)?.renamed === undefined;
}

/** The ask of an interaction kind. */
function askCommand(kind: InteractionExpression["interactionKind"]): Ask {
  // EVIDENCE: invariant: `COMMANDS` holds an ask under its current name for every interaction kind, which a test checks.
  return Object.keys(COMMANDS).find(
    (name) => isCurrentAsk(name) && COMMANDS[name].interaction === kind,
  ) as Ask;
}

const protectedNames: ReadonlySet<string> = new Set(TEASESCRIPT_PROTECTED_NAMES);

/** Declared speaker names; a protected name such as `set` is an invalid declaration, not a suggestion. */
function declaredSpeakers(source: string): readonly string[] {
  // A speaker belongs to the whole script wherever it is declared.
  const speakers = sessionDeclarations([compileSource(source).program]).flatMap(
    ({ declaration }) =>
      declaration.kind === "speakerDeclaration" && !protectedNames.has(declaration.name.name)
        ? [declaration.name.name]
        : [],
  );
  return Object.freeze([...new Set(speakers)]);
}

/**
 * A built-in whose help comes from its contract: a conversion, a numeric or angle function, a random function, a clock
 * read, a list function, a method that only text has, a method of date and time values, one that only lists and sets
 * have, or one that only handles have, with the same help on each (`CONVERSIONS`, `NUMERIC_CONTRACTS`,
 * `RANDOM_CONTRACTS`, `CLOCK_CONTRACTS`, `LIST_FUNCTION_CONTRACTS`, `TEXT_METHODS`, `TEMPORAL_METHODS`, `LIST_METHODS`,
 * `HANDLE_MEMBERS`). A method that other values have too, such as `contains`, may be called on a value the editor does
 * not know, so it has none.
 */
type ContractName =
  | ConversionName
  | NumericFunctionName
  | RandomFunctionName
  | ClockFunctionName
  | ListFunctionName
  | TextMethodName
  | TemporalMethodName
  | ListMethodName
  | AnyHandleMethodName;

/**
 * Whether only lists and sets have a method `name`: no text, dict, handle (see `TEXT_METHODS`, `DICT_METHODS`, and
 * `HANDLE_MEMBERS`), or range (see `ListMethod.shared`) has one.
 */
function isListOnlyMethod(name: string): name is ListMethodName {
  if (!isListMethod(name) || isTextMethod(name) || isDictMethod(name) || isAnyHandleMethod(name))
    return false;
  const method: ListMethod = LIST_METHODS[name];
  return method.shared !== true;
}

/**
 * Whether only handles have a method `name`, all with the same help (`sharedHandleMethodSummary`), such as `pause`: no
 * text, list, set, dict, or date and time value has one. `remove` is not one: lists, sets, and dicts have one too, and a
 * message's and a permanent button's differ.
 */
function isHandleOnlyMethod(name: string): name is AnyHandleMethodName {
  return (
    isAnyHandleMethod(name) &&
    sharedHandleMethodSummary(name) !== undefined &&
    !isTextMethod(name) &&
    !isTemporalMethod(name) &&
    !isListMethod(name) &&
    !isDictMethod(name)
  );
}

/**
 * A call of a built-in with a contract in the source: its name, whether it is a method, where the name is, and where its
 * `(` is. A date and time value's `toDateTime()` is a method of the same name as a conversion.
 */
type ContractCall = { readonly range: LanguageRange; readonly opener: number } & (
  | {
      readonly method: false;
      readonly name:
        | ConversionName
        | NumericFunctionName
        | RandomFunctionName
        | ClockFunctionName
        | ListFunctionName;
    }
  | {
      readonly method: true;
      readonly name: TextMethodName | TemporalMethodName | ListMethodName | AnyHandleMethodName;
    }
);

/**
 * The help at `offset`: of the innermost compact command, other command, or call of a built-in with a contract there,
 * with the range of its name, and the call when it is such a built-in's or another command's.
 */
function locateHelp(
  document: LanguageDocument,
  offset: number,
): {
  readonly help: LanguageContextHelp;
  readonly range: LanguageRange;
  readonly call: ContractCall | null;
  readonly command: CommandCall | null;
} | null {
  const compact = locateCompactCommand(document, offset);
  const tokens = statementTokens(document, offset);
  const call = tokens === null ? null : locateContractCall(tokens, offset);
  const command =
    tokens === null
      ? null
      : locateCommandCall(tokens, offset, parsedCommands(parseDocument(document.text)));
  // A call inside a command, or a command inside a call or another command, starts after it.
  const start = (located: { readonly range: LanguageRange } | null) =>
    located === null ? -1 : located.range.start.offset;
  const innermost = Math.max(start(compact), start(call), start(command));
  if (call !== null && start(call) === innermost)
    return { help: Object.freeze(contractHelp(call)), range: call.range, call, command: null };
  if (command !== null && start(command) === innermost)
    return { help: COMMAND_HELP[command.name].help, range: command.range, call: null, command };
  return compact === null
    ? null
    : { help: HELP[compact.command], range: compact.range, call: null, command: null };
}

/**
 * A command with help of its own besides the compact interactions (see `COMMAND_HELP`): its name, where the name is,
 * and the last named option of its signature written before the offset, or `null`.
 */
interface CommandCall {
  readonly name: OtherCommand;
  readonly range: LanguageRange;
  readonly option: string | null;
}

/** The commands that take a block after their arguments, which holds statements of their own. */
const BLOCK_COMMANDS: ReadonlySet<OtherCommand> = new Set([
  "timer",
  "showPermanentButton",
  "playAudio",
  "playVideo",
]);

/** The tokens of the statement at `offset`, without line breaks, or `null` between statements (see `statementRangeAt`). */
function statementTokens(document: LanguageDocument, offset: number): readonly Token[] | null {
  const parsed = parseDocument(document.text);
  const statement = statementRangeAt(parsed.statementRanges, offset);
  if (statement === null) return null;
  return lex(document.text, parsed.regexStarts).tokens.filter(
    (token) =>
      token.span.start.offset >= statement.start &&
      token.span.start.offset < statement.end &&
      token.kind !== TokenKind.Newline &&
      token.kind !== TokenKind.EndOfFile,
  );
}

/** Where the parser read the arguments of each command, by where its name starts, and the starts of their blocks. */
interface ParsedCommands {
  readonly ends: ReadonlyMap<number, number>;
  readonly blocks: ReadonlySet<number>;
}

const parsedCommandsOf = new WeakMap<ParseResult, ParsedCommands>();

/** The command ranges of a parse (see `ParseResult.commandRanges`), looked up by offset. */
function parsedCommands(parsed: ParseResult): ParsedCommands {
  const known = parsedCommandsOf.get(parsed);
  if (known !== undefined) return known;
  const ends = new Map<number, number>();
  const blocks = new Set<number>();
  for (const range of parsed.commandRanges) {
    ends.set(range.start, range.end);
    if (range.block !== null) blocks.add(range.block);
  }
  const commands = { ends, blocks };
  parsedCommandsOf.set(parsed, commands);
  return commands;
}

/** The words a command's short form may write between its name and its value (see `CommandFacts.fileModifiers`). */
const MODIFIERS: Partial<Readonly<Record<OtherCommand, readonly string[]>>> = {
  timer: ["async", ...TIMER_DISPLAYS],
  playAudio: COMMANDS.playAudio.fileModifiers,
  playVideo: COMMANDS.playVideo.fileModifiers,
};

/** A command still open where the tokens are read. */
interface OpenCommand {
  readonly name: OtherCommand;
  readonly range: LanguageRange;
  /** Whether its call form holds its arguments (see `startsCallForm`). */
  readonly parenthesized: boolean;
  /** The depth of the delimiters its arguments are written at: inside its parentheses, or where its name is. */
  readonly level: number;
  /** Where the parser read its arguments to (see `ParseResult.commandRanges`), or `null` for its call form or if it did not. */
  end: number | null;
  option: string | null;
  argumentStart: boolean;
  /** Whether a value follows its name and modifiers, after which a `{` starts its block. */
  operand: boolean;
}

/**
 * The innermost command of `COMMAND_HELP` whose name or arguments hold `offset`, read from the tokens of its statement in
 * one pass. A command whose arguments the parser read, also in a statement it could not read further, ends at the first
 * token after them, and its call form at the `)` of its parentheses. A command whose arguments are still being written
 * holds every offset after its name up to its block, a delimiter that closes one opened before it, or, for a command
 * that gives a value, a comma of the enclosing list or call.
 */
function locateCommandCall(
  tokens: readonly Token[],
  offset: number,
  parsed: ParsedCommands,
): CommandCall | null {
  // The commands still open, innermost last, and for each open delimiter whether it opens a command's block.
  const open: OpenCommand[] = [];
  const delimiters: boolean[] = [];
  let blocks = 0;
  // Where the block of a command being written that ended at the `)` of its parentheses may start.
  let blockAt = -1;
  for (const [index, token] of tokens.entries()) {
    const start = token.span.start.offset;
    // A token that starts at the cursor is after it, but a command whose name starts there holds it. A command whose
    // arguments the parser read holds the cursor in the space after them only where nothing follows.
    if (start >= offset) {
      const name =
        start === offset && blocks === 0
          ? helpedCommand(token, tokens[index - 1], tokens[index + 1])
          : null;
      if (name !== null) return { name, range: token.span, option: null };
      while (open.length > 0 && open.at(-1)!.end !== null && offset > open.at(-1)!.end!) open.pop();
      break;
    }
    // A command whose arguments the parser read ends at the token after them, except at a comma before its option that
    // the cursor is writing, after which it holds the cursor as a command being written does.
    while (open.length > 0 && open.at(-1)!.end !== null && start >= open.at(-1)!.end!) {
      const command = open.at(-1)!;
      if (
        token.kind === TokenKind.Comma &&
        delimiters.length === command.level &&
        optionAfterComma(command.name, tokens, index, offset)
      ) {
        command.end = null;
        break;
      }
      open.pop();
    }
    const top = open.at(-1);
    const depth = delimiters.length;
    const atLevel = top !== undefined && depth === top.level;
    // The block of a command being written starts at a `{` after its value.
    const ownBlock =
      token.kind === TokenKind.LeftBrace &&
      atLevel &&
      top.end === null &&
      !top.parenthesized &&
      top.operand &&
      BLOCK_COMMANDS.has(top.name);
    if (CLOSING_DELIMITERS.has(token.kind)) {
      if (delimiters.pop() === true) blocks -= 1;
      // The `)` of a command's parentheses ends it, and so does a delimiter that closes one opened before it.
      while (open.length > 0 && delimiters.length < open.at(-1)!.level) {
        const ended = open.pop()!;
        if (ended.parenthesized && ended.end === null && BLOCK_COMMANDS.has(ended.name))
          blockAt = index + 1;
      }
      if (open.at(-1)?.level === delimiters.length) open.at(-1)!.argumentStart = false;
    } else if (
      token.kind === TokenKind.LeftBrace &&
      (parsed.blocks.has(start) || index === blockAt || ownBlock)
    ) {
      // A command's block holds statements of their own, and ends the command.
      if (ownBlock) open.pop();
      delimiters.push(true);
      blocks += 1;
    } else if (OPENING_DELIMITERS.has(token.kind)) {
      delimiters.push(false);
      if (atLevel) top.operand = true;
      // The command's own `(` starts its first argument.
      if (top !== undefined)
        top.argumentStart = top.parenthesized && delimiters.length === top.level;
    } else if (token.kind === TokenKind.Comma) {
      // A comma of the enclosing list or call ends a value that a command being written gives.
      while (open.length > 0 && endsAtComma(open.at(-1)!, depth, tokens, index, offset)) open.pop();
      const current = open.at(-1);
      if (current !== undefined && depth === current.level) current.argumentStart = true;
    } else {
      if (
        atLevel &&
        top.argumentStart &&
        token.kind === TokenKind.Identifier &&
        tokens[index + 1]?.kind === TokenKind.Colon &&
        COMMAND_HELP[top.name].parameters.includes(token.lexeme)
      )
        top.option = token.lexeme;
      if (atLevel) {
        top.argumentStart = false;
        if (!top.operand && !(MODIFIERS[top.name] ?? []).includes(token.lexeme)) top.operand = true;
      }
      const name = blocks > 0 ? null : helpedCommand(token, tokens[index - 1], tokens[index + 1]);
      if (name !== null) {
        const parenthesized = startsCallForm(token, tokens[index + 1]);
        open.push({
          name,
          range: token.span,
          parenthesized,
          level: depth + (parenthesized ? 1 : 0),
          end: parenthesized ? null : (parsed.ends.get(start) ?? null),
          option: null,
          argumentStart: false,
          operand: false,
        });
      }
    }
  }
  const innermost = open.at(-1);
  return innermost === undefined
    ? null
    : { name: innermost.name, range: innermost.range, option: innermost.option };
}

/** The options a command takes after a comma in its short form, as in `showPermanentButton "Stop", persist: true`. */
const COMMA_OPTIONS: Partial<Readonly<Record<OtherCommand, readonly string[]>>> = {
  showPermanentButton: PERMANENT_BUTTON_OPTIONS,
};

/** Whether the comma at `index` starts an option of `command`, one written there or one the cursor after it writes. */
function optionAfterComma(
  command: OtherCommand,
  tokens: readonly Token[],
  index: number,
  offset: number,
): boolean {
  const options = COMMA_OPTIONS[command];
  if (options === undefined) return false;
  const next = tokens[index + 1];
  return (
    next === undefined ||
    next.span.start.offset >= offset ||
    (next.kind === TokenKind.Identifier &&
      tokens[index + 2]?.kind === TokenKind.Colon &&
      options.includes(next.lexeme))
  );
}

/**
 * Whether the comma at `index`, at `depth`, ends `command`, a command being written in its short form that the parser
 * could not read yet: a command that gives a value ends at a comma of the enclosing list or call, but not at one that
 * starts its option (see `optionAfterComma`).
 */
function endsAtComma(
  command: OpenCommand,
  depth: number,
  tokens: readonly Token[],
  index: number,
  offset: number,
): boolean {
  if (command.end !== null || command.parenthesized || depth !== command.level) return false;
  return (
    commandFacts(command.name)?.value === true &&
    !optionAfterComma(command.name, tokens, index, offset)
  );
}

/** The command of `COMMAND_HELP` that `token` names, unless it is a property or a name before `:`. */
function helpedCommand(
  token: Token,
  previous: Token | undefined,
  next: Token | undefined,
): OtherCommand | null {
  if (previous?.kind === TokenKind.Dot || next?.kind === TokenKind.Colon) return null;
  if (token.kind === TokenKind.KeywordWait) return "wait";
  if (token.kind !== TokenKind.Identifier || !Object.hasOwn(COMMAND_HELP, token.lexeme))
    return null;
  // EVIDENCE: invariant: the word is a key of COMMAND_HELP, checked above.
  return token.lexeme as OtherCommand;
}

/** The help of a call of a built-in with a contract, from its contract. */
function contractHelp(call: ContractCall): LanguageContextHelp {
  if (call.method)
    return isTemporalMethod(call.name)
      ? {
          command: call.name,
          summary: TEMPORAL_METHODS[call.name].summary,
          syntax: temporalSyntax(call.name),
        }
      : isHandleOnlyMethod(call.name)
        ? {
            command: call.name,
            summary: sharedHandleMethodSummary(call.name)!,
            syntax: handleMethodSyntax(call.name),
          }
        : isTextMethod(call.name)
          ? {
              command: call.name,
              summary: TEXT_METHODS[call.name].summary,
              syntax: textMethodSyntax(call.name),
            }
          : {
              command: call.name,
              summary: LIST_METHODS[call.name].summary,
              syntax: listMethodSyntax(call.name),
            };
  if (isConversion(call.name))
    return {
      command: call.name,
      summary: CONVERSIONS[call.name].summary,
      syntax: conversionSyntax(call.name),
    };
  if (isNumericFunction(call.name))
    return {
      command: call.name,
      summary: NUMERIC_CONTRACTS[call.name].summary,
      syntax: numericSyntax(call.name),
    };
  if (isRandomFunction(call.name))
    return {
      command: call.name,
      summary: RANDOM_CONTRACTS[call.name].summary,
      syntax: randomSyntax(call.name),
    };
  if (isListFunction(call.name))
    return {
      command: call.name,
      summary: LIST_FUNCTION_CONTRACTS[call.name].summary,
      syntax: listFunctionSyntax(call.name),
    };
  return {
    command: call.name,
    summary: CLOCK_CONTRACTS[call.name].summary,
    syntax: temporalSyntax(call.name),
  };
}

/**
 * The innermost call of a built-in with a contract whose name, or whose arguments up to the `)` that closes it, hold
 * `offset`. It is read from the tokens of the statement there, so that a call being written, without its `)`, holds
 * every offset after its name.
 */
function locateContractCall(tokens: readonly Token[], offset: number): ContractCall | null {
  let innermost: ContractCall | null = null;
  const holds = (call: ContractCall | null, end: number) => {
    if (call === null || offset < call.range.start.offset || offset > end) return;
    if (innermost === null || call.range.start.offset > innermost.range.start.offset)
      innermost = call;
  };
  // The delimiters still open, innermost last, with the call of a built-in with a contract that each `(` opens.
  const open: (ContractCall | null)[] = [];
  for (const [index, token] of tokens.entries()) {
    if (OPENING_DELIMITERS.has(token.kind)) {
      const name = tokens[index - 1];
      // After a dot, a method that only text has, also `repeat`, which the lexer reads as a keyword, a method of date
      // and time values, also one of the same name as a function, such as a datetime's `toAbsoluteDateTime()`, or a
      // method that only lists and sets, or only handles, have. A declared function is not a call of the built-in.
      const before = tokens[index - 2]?.kind;
      let call: ContractCall | null = null;
      if (token.kind === TokenKind.LeftParenthesis && name !== undefined) {
        const word = name.lexeme;
        const at = { range: name.span, opener: token.span.start.offset };
        if (before === TokenKind.Dot) {
          if (
            isTextOnlyMethod(word) ||
            isTemporalMethod(word) ||
            isListOnlyMethod(word) ||
            isHandleOnlyMethod(word)
          )
            call = { ...at, method: true, name: word };
        } else if (
          name.kind === TokenKind.Identifier &&
          before !== TokenKind.KeywordFunction &&
          (isConversion(word) ||
            isNumericFunction(word) ||
            isRandomFunction(word) ||
            isClockFunction(word) ||
            isListFunction(word))
        )
          call = { ...at, method: false, name: word };
      }
      open.push(call);
    } else if (CLOSING_DELIMITERS.has(token.kind))
      holds(open.pop() ?? null, token.span.start.offset);
  }
  for (const call of open) holds(call, Infinity);
  return innermost;
}

/**
 * The signature parameters of a call of a built-in with a contract, its positional ones and then its named ones, and
 * the one at `offset`: the named argument written there, or the next positional one, or after them the first named
 * one. The second form of a pair, `toDateTime(date, time)`, is the call's once it has a second positional argument;
 * `randomWeighted` names its dict, or list with `weight:`, as `dict`.
 */
function callParameters(
  document: LanguageDocument,
  call: ContractCall,
  offset: number,
): { readonly parameters: readonly string[]; readonly activeParameter: number } {
  const start = call.opener + 1;
  const end = Math.max(start, offset);
  const tokens = lex(
    document.text.slice(start, end),
    regexStartsWithin(parseDocument(document.text).regexStarts, start, end),
  ).tokens.filter(
    (token) => token.kind !== TokenKind.EndOfFile && token.kind !== TokenKind.Newline,
  );
  let depth = 0;
  let positional = 0;
  let named: string | null = null;
  let argumentStart = true;
  for (const [index, token] of tokens.entries()) {
    if (OPENING_DELIMITERS.has(token.kind)) depth += 1;
    else if (CLOSING_DELIMITERS.has(token.kind)) depth -= 1;
    else if (depth === 0 && token.kind === TokenKind.Comma) {
      if (named === null) positional += 1;
      named = null;
      argumentStart = true;
      continue;
    } else if (
      depth === 0 &&
      argumentStart &&
      token.kind === TokenKind.Identifier &&
      tokens[index + 1]?.kind === TokenKind.Colon
    )
      named = token.lexeme;
    argumentStart = false;
  }
  let form: readonly string[];
  let parameters: readonly string[];
  if (!call.method && isConversion(call.name)) {
    const conversion: Conversion = CONVERSIONS[call.name];
    form =
      conversion.pair !== undefined && positional >= (named === null ? 1 : 2)
        ? conversion.pair
        : [conversion.parameter];
    parameters = Object.freeze([
      ...form,
      ...(conversion.fallback === null ? [] : ["default"]),
      ...(conversion.files ? ["files"] : []),
    ]);
  } else if (!call.method && isNumericFunction(call.name)) {
    const numeric: NumericFunction = NUMERIC_CONTRACTS[call.name];
    form = numeric.parameters;
    parameters = Object.freeze([...form, ...(numeric.named ?? [])]);
  } else if (!call.method && isRandomFunction(call.name)) {
    const random: RandomFunction = RANDOM_CONTRACTS[call.name];
    form = random.takes === "choices" ? ["dict"] : random.parameters;
    parameters = Object.freeze([...form, ...(random.takes === "choices" ? ["weight"] : [])]);
  } else if (!call.method && isListFunction(call.name)) {
    // `min` and `max` of values, once a second one is being written, take any number of them.
    if (takesValues(call.name) && positional > 0 && named === null)
      return { parameters: Object.freeze(["value"]), activeParameter: 0 };
    const list: ListFunction = LIST_FUNCTION_CONTRACTS[call.name];
    form = list.parameters;
    parameters = Object.freeze([...form, ...list.named]);
  } else if (call.method && isTextMethod(call.name)) {
    form = TEXT_METHODS[call.name].parameters.map((parameter) => parameter.name);
    parameters = Object.freeze(form);
  } else if (call.method && isListMethod(call.name)) {
    const method: ListMethod = LIST_METHODS[call.name];
    form = method.parameters.map((parameter) => parameter.name);
    parameters = Object.freeze([...form, ...(method.named ?? [])]);
  } else {
    // A clock read, a method of date and time values, and a handle method take no arguments.
    form = [];
    parameters = Object.freeze(form);
  }
  return {
    parameters,
    activeParameter: named !== null ? parameters.indexOf(named) : Math.min(positional, form.length),
  };
}

function locateCompactCommand(
  document: LanguageDocument,
  offset: number,
): { command: CompactCommand; range: LanguageRange } | null {
  const parsed = parseDocument(document.text);
  let best: { command: CompactCommand; range: LanguageRange } | null = null;
  visitProgram(parsed.program, {
    showButton(node) {
      if (containsOffset(node.span, offset))
        best = { command: "showButton", range: node.commandSpan };
    },
    interaction(node) {
      if (!containsOffset(node.span, offset)) return;
      best = { command: askCommand(node.interactionKind), range: node.commandSpan };
    },
    say(node) {
      if (!containsOffset(node.span, offset)) return;
      const start = node.span.start;
      best = {
        command: "say",
        range: createSourceSpan(
          start,
          createSourcePosition(start.offset + 3, start.line, start.column + 3),
        ),
      };
    },
  });
  if (best !== null) return best;

  const tokens = lex(document.text, parsed.regexStarts).tokens;
  for (const token of tokens) {
    const command = tokenToCompactCommand(token);
    if (command !== null && offset >= token.span.start.offset && offset <= token.span.end.offset) {
      return { command, range: token.span };
    }
  }
  // Only the statement at the cursor is read: a command of an earlier statement does not apply.
  const start = statementStartAt(parsed.statementRanges, offset);
  if (start === null) return null;
  // A token that starts at the cursor, such as the `)` an editor adds when it closes a bracket, is after it.
  const before = tokens.filter(
    (token) =>
      token.span.start.offset >= start &&
      token.span.start.offset < offset &&
      token.kind !== TokenKind.Newline &&
      token.kind !== TokenKind.EndOfFile,
  );
  return nearestOpenCompactCommand(before);
}

/** The last document parsed, which help, signature help, and formatting of the same text read again. */
let lastParse: { readonly text: string; readonly result: ParseResult } | null = null;

/**
 * The syntax of a document, or none when parsing it exhausted the call stack, which the compiler reports. Only a parse
 * that succeeded is kept, so that the same text is parsed again after a failure.
 */
function parseDocument(text: string): ParseResult {
  if (lastParse?.text === text) return lastParse.result;
  let result: ParseResult;
  try {
    result = parse(text);
  } catch (error) {
    if (!isNativeStackExhaustion(error)) throw error;
    return parse("");
  }
  lastParse = { text, result };
  return result;
}

/**
 * Where the statement at `offset` starts: the innermost statement range around it. `null` when that is a statement
 * block, or there is none, so the offset lies between statements.
 */
function statementStartAt(ranges: readonly StatementRange[], offset: number): number | null {
  return statementRangeAt(ranges, offset)?.start ?? null;
}

/** The innermost statement range around `offset`, or `null` when that is a statement block or there is none. */
function statementRangeAt(
  ranges: readonly StatementRange[],
  offset: number,
): StatementRange | null {
  let innermost: StatementRange | null = null;
  for (const range of ranges) {
    if (range.start > offset || offset > range.end) continue;
    // A statement at the very start of a block is inside it.
    if (
      innermost === null ||
      range.start > innermost.start ||
      (range.start === innermost.start && range.kind === "statement")
    )
      innermost = range;
  }
  return innermost?.kind === "statement" ? innermost : null;
}

/**
 * The nearest command that no later closing delimiter has ended, found in one backward pass: a closing delimiter whose
 * opener lies before a command ends that command, and so does the `)` of an ask's own parentheses.
 */
function nearestOpenCompactCommand(
  tokens: readonly Token[],
): { command: CompactCommand; range: LanguageRange } | null {
  let unmatchedClosers = 0;
  // The positions of the opening delimiters that a later closing delimiter matches.
  const closed = new Set<number>();
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    if (CLOSING_DELIMITERS.has(token.kind)) unmatchedClosers += 1;
    else if (OPENING_DELIMITERS.has(token.kind)) {
      if (unmatchedClosers > 0) closed.add(index);
      unmatchedClosers = Math.max(0, unmatchedClosers - 1);
    } else if (unmatchedClosers === 0) {
      const command = tokenToCompactCommand(token);
      if (command !== null && !closed.has(askArgumentsOpener(command, tokens, index + 1)))
        return { command, range: token.span };
    }
  }
  return null;
}

/**
 * The position of the `(` that opens an ask's own arguments, as the parser reads it: at `after`, the token right after
 * the ask, or after its `as speaker` and the question's mode with its parentheses, as in `askText prose() (`. It is -1
 * for another command or an ask without parentheses.
 */
function askArgumentsOpener(
  command: CompactCommand,
  tokens: readonly Token[],
  after: number,
): number {
  if (command === "say" || command === "showButton" || command === "askChoice") return -1;
  let opener =
    tokens[after]?.kind === TokenKind.KeywordAs && tokens[after + 1]?.kind === TokenKind.Identifier
      ? after + 2
      : after;
  const mode = tokens[opener];
  if (
    mode?.kind === TokenKind.Identifier &&
    (mode.lexeme === "bubble" || mode.lexeme === "prose") &&
    tokens[opener + 1]?.kind === TokenKind.LeftParenthesis
  ) {
    let depth = 0;
    for (let index = opener + 1; index < tokens.length; index += 1) {
      if (OPENING_DELIMITERS.has(tokens[index]!.kind)) depth += 1;
      else if (CLOSING_DELIMITERS.has(tokens[index]!.kind)) depth -= 1;
      if (depth === 0) {
        opener = index + 1;
        break;
      }
    }
  }
  return tokens[opener]?.kind === TokenKind.LeftParenthesis ? opener : -1;
}

function containsOffset(span: SourceSpan, offset: number): boolean {
  return offset >= span.start.offset && offset <= span.end.offset;
}

/** The named options of a command after its label, question, or options, as the parser accepts them. */
function namedOptions(command: CompactCommand): readonly string[] {
  if (command === "say") return [];
  return command === "showButton"
    ? SHOW_BUTTON_OPTIONS
    : askOptionNames(COMMANDS[command].interaction);
}

function commandHelp(
  command: OtherCommand,
  summary: string,
  syntax: string,
  parameters: readonly string[],
): CommandHelp {
  return Object.freeze({
    help: Object.freeze({ command, summary, syntax }),
    parameters: Object.freeze([...parameters]),
  });
}

/** The help of `playAudio` or `playVideo`, whose summary starts with what it `plays`. */
function mediaHelp(command: "playAudio" | "playVideo", plays: string): CommandHelp {
  const modifiers = COMMANDS[command].fileModifiers.map((word) => `[${word}]`).join(" ");
  return commandHelp(
    command,
    `${plays} and waits until it ends, or with async lets the script continue and, as a value, returns the media's handle. With async, repeat plays it until it is stopped, and the named form's repeat also takes a count, such as 3 times, or a duration. A block runs at the end of every pass, or holds the cues at, beforeEnd, and finish. The named form also takes startAt, endAt, and volume.`,
    `${command} ${modifiers} file [{ ... }]  or  ${namedForm(command, MEDIA_ARGUMENTS, { repeat: "true|count times|duration" })} [{ ... }]`,
    MEDIA_ARGUMENTS,
  );
}

/**
 * ` [, name: value]` for each of `names`, as a syntax line writes the named options a command may leave out; `values`
 * names what one of them takes where `OPTION_VALUES` does not.
 */
function optionalOptions(
  names: readonly string[],
  values: Readonly<Record<string, string>> = {},
): string {
  return names
    .map((name) => ` [, ${name}: ${values[name] ?? OPTION_VALUES[name] ?? "value"}]`)
    .join("");
}

/** The named form of a command, which needs the first of its `names` and may leave out the others. */
function namedForm(
  command: OtherCommand,
  names: readonly string[],
  values: Readonly<Record<string, string>> = {},
): string {
  const [first, ...others] = names;
  return `${command}(${first}: ${OPTION_VALUES[first!] ?? "value"}${optionalOptions(others, values)})`;
}

/** `names` as a sentence lists them: `a`, `a and b`, or `a, b, and c`. */
function listed(names: readonly string[]): string {
  return names.length < 3
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * The help of a command whose syntax line ends with its named options, in brackets where the command may leave one out;
 * `prefill` names what an ask's prefill is.
 */
function help(
  command: Exclude<CompactCommand, "say">,
  summary: string,
  head: string,
  prefill = "value",
): LanguageContextHelp {
  const required =
    command === "showButton" ? [] : requiredAskOptionNames(COMMANDS[command].interaction);
  const options = namedOptions(command).map((name) => {
    const option = `, ${name}: ${name === "prefill" ? prefill : (OPTION_VALUES[name] ?? "value")}`;
    return required.includes(name) ? option : ` [${option}]`;
  });
  return Object.freeze({ command, summary, syntax: `${command} ${head}${options.join("")}` });
}

function signatureParameters(command: CompactCommand): readonly string[] {
  if (command === "say") return Object.freeze(["speaker", "skip policy", "text", "pacing"]);
  const first =
    command === "showButton" ? "label" : command === "askChoice" ? "options" : "question";
  return Object.freeze(["speaker", first, ...namedOptions(command)]);
}

const OPENING_DELIMITERS: ReadonlySet<TokenKind> = new Set([
  TokenKind.LeftParenthesis,
  TokenKind.LeftBracket,
  TokenKind.LeftBrace,
  TokenKind.InterpolationStart,
]);
const CLOSING_DELIMITERS: ReadonlySet<TokenKind> = new Set([
  TokenKind.RightParenthesis,
  TokenKind.RightBracket,
  TokenKind.RightBrace,
  TokenKind.InterpolationEnd,
]);

function activeParameterFor(
  source: string,
  command: CompactCommand,
  start: number,
  offset: number,
  regexStarts: ReadonlySet<number>,
): number {
  const end = Math.max(start, offset);
  const tokens = lex(
    source.slice(start, end),
    regexStartsWithin(regexStarts, start, end),
  ).tokens.filter(
    (token) => token.kind !== TokenKind.EndOfFile && token.kind !== TokenKind.Newline,
  );
  const tail = tokens.slice(1);
  const last = tail.at(-1);
  const cursorAfterLastToken =
    last !== undefined && Math.max(start, offset) - start > last.span.end.offset;
  const asIndex = tail.findIndex((token) => token.kind === TokenKind.KeywordAs);
  if (
    asIndex >= 0 &&
    (tail.length === asIndex + 1 || (tail.length === asIndex + 2 && !cursorAfterLastToken))
  )
    return 0;
  if (command !== "say") {
    // The last named option before the cursor is the active parameter. A delimiter that closes one opened before the
    // command ends the command, so later options belong to the enclosing construct. The `)` of an ask's own
    // parentheses ends the ask.
    const argumentsStart = askArgumentsOpener(command, tail, 0) + 1;
    let active = 1;
    let depth = 0;
    for (const [index, token] of tail.entries()) {
      if (index < argumentsStart) continue;
      if (OPENING_DELIMITERS.has(token.kind)) depth += 1;
      else if (CLOSING_DELIMITERS.has(token.kind)) {
        if (depth === 0) break;
        depth -= 1;
      } else if (
        depth === 0 &&
        token.kind === TokenKind.Identifier &&
        tail[index + 1]?.kind === TokenKind.Colon
      )
        active = namedOptionParameter(command, token.lexeme) ?? active;
    }
    return active;
  }

  let depth = 0;
  for (const token of tail) {
    if (OPENING_DELIMITERS.has(token.kind)) {
      depth += 1;
    } else if (CLOSING_DELIMITERS.has(token.kind)) {
      depth = Math.max(0, depth - 1);
    } else if (token.kind === TokenKind.Comma && depth === 0) {
      return 3;
    }
  }
  return last !== undefined && tokenIsSayModifier(last) && !cursorAfterLastToken ? 1 : 2;
}

/** The signature parameter of a named compact option, such as `timeout:` of `showButton`. */
function namedOptionParameter(command: CompactCommand, name: string): number | null {
  const index = namedOptions(command).indexOf(name);
  return index < 0 ? null : 2 + index;
}

function lineStarts(source: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 13) {
      if (source.charCodeAt(index + 1) === 10) index += 1;
      starts.push(index + 1);
    } else if (code === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function positionAtOffset(
  offset: number,
  starts: readonly number[],
  source: string,
): SourcePosition {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle;
  }
  if (offset > 0 && source.charCodeAt(offset - 1) === 13 && source.charCodeAt(offset) === 10) {
    return createSourcePosition(offset, low + 1, 0);
  }
  return createSourcePosition(offset, low, offset - starts[low]!);
}

interface Visitor {
  readonly showButton: (node: ShowButtonParts) => void;
  readonly interaction: (node: InteractionExpression) => void;
  readonly say: (node: SayParts) => void;
}

type VisitItem =
  | { readonly kind: "statement"; readonly node: Statement }
  | { readonly kind: "expression"; readonly node: Expression };

/**
 * Visits the program in source order with an explicit work stack, so deeply nested source that compiles does not
 * depend on the host call stack.
 */
function visitProgram(program: Program, visitor: Visitor): void {
  const stack: VisitItem[] = [];
  const pushInOrder = (items: readonly VisitItem[]): void => {
    for (let index = items.length - 1; index >= 0; index -= 1) stack.push(items[index]!);
  };
  pushInOrder(program.statements.map((node) => ({ kind: "statement", node })));
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const children: VisitItem[] = [];
    if (item.kind === "statement") visitStatement(item.node, visitor, children);
    else visitExpression(item.node, visitor, children);
    pushInOrder(children);
  }
}

function visitStatement(statement: Statement, visitor: Visitor, children: VisitItem[]): void {
  switch (statement.kind) {
    case "showButtonStatement":
      visitShowButton(statement, visitor, children);
      return;
    case "sayStatement":
      visitSay(statement, visitor, children);
      return;
    case "letStatement":
      children.push({ kind: "expression", node: statement.initializer });
      return;
    case "globalStatement":
      if (statement.assignment !== null)
        children.push({ kind: "expression", node: statement.assignment.value });
      children.push({ kind: "expression", node: statement.initial });
      return;
    case "assignmentStatement":
      children.push({ kind: "expression", node: statement.target });
      children.push({ kind: "expression", node: statement.value });
      return;
    case "expressionStatement":
      children.push({ kind: "expression", node: statement.expression });
      return;
    case "speakerDeclaration":
      for (const property of statement.properties)
        children.push({ kind: "expression", node: property.value });
      return;
    case "ifStatement":
      children.push({ kind: "expression", node: statement.condition });
      for (const child of statement.thenBlock.statements)
        children.push({ kind: "statement", node: child });
      if (statement.elseBlock?.kind === "block")
        for (const child of statement.elseBlock.statements)
          children.push({ kind: "statement", node: child });
      else if (statement.elseBlock !== null)
        children.push({ kind: "statement", node: statement.elseBlock });
      return;
    case "switchStatement":
      children.push({ kind: "expression", node: statement.subject });
      for (const switchCase of statement.cases)
        for (const child of switchCase.body.statements)
          children.push({ kind: "statement", node: child });
      if (statement.defaultBlock !== null)
        for (const child of statement.defaultBlock.statements)
          children.push({ kind: "statement", node: child });
      return;
    case "repeatStatement":
      children.push({ kind: "expression", node: statement.count });
      for (const child of statement.body.statements)
        children.push({ kind: "statement", node: child });
      return;
    case "forStatement":
      children.push({ kind: "expression", node: statement.iterable });
      for (const child of statement.body.statements)
        children.push({ kind: "statement", node: child });
      return;
    case "whileStatement":
      children.push({ kind: "expression", node: statement.condition });
      for (const child of statement.body.statements)
        children.push({ kind: "statement", node: child });
      return;
    case "functionDeclaration":
      for (const parameter of statement.parameters)
        if (parameter.defaultValue !== null)
          children.push({ kind: "expression", node: parameter.defaultValue });
      for (const child of statement.body.statements)
        children.push({ kind: "statement", node: child });
      return;
    case "returnStatement":
      if (statement.value !== null) children.push({ kind: "expression", node: statement.value });
      return;
    case "timerStatement":
      visitTimer(statement, children);
      return;
    case "showPermanentButtonStatement":
      visitPermanentButton(statement, children);
      return;
    case "playMediaStatement":
      visitMedia(statement, children);
      return;
    case "showImageStatement":
      children.push({ kind: "expression", node: statement.image });
      return;
    case "showPopupStatement":
    case "openUrlStatement":
    case "exportTextStatement":
      for (const argument of statement.arguments)
        children.push({ kind: "expression", node: argument.value });
      return;
    case "saveStatement":
      children.push({ kind: "expression", node: statement.value });
      children.push({ kind: "expression", node: statement.key });
      return;
    case "deleteStatement":
      children.push({ kind: "expression", node: statement.key });
      return;
    case "gotoStatement":
    case "callFileStatement":
      if (statement.target.kind === "scriptTarget")
        children.push({ kind: "expression", node: statement.target.expression });
      return;
    case "hideImageStatement":
    case "showCameraStatement":
    case "hideCameraStatement":
    case "stopAudioStatement":
    case "speakerSetterStatement":
    case "waitStatement":
    case "exitStatement":
    case "endStatement":
    case "labelStatement":
    case "breakStatement":
    case "continueStatement":
      return;
  }
}

function visitTimer(timer: TimerParts, children: VisitItem[]): void {
  for (const operand of timerOperands(timer)) children.push({ kind: "expression", node: operand });
  for (const child of timer.handler?.statements ?? [])
    children.push({ kind: "statement", node: child });
}

function visitPermanentButton(button: ShowPermanentButtonParts, children: VisitItem[]): void {
  children.push({ kind: "expression", node: button.text });
  for (const child of button.handler.statements) children.push({ kind: "statement", node: child });
}

function visitMedia(parts: MediaParts, children: VisitItem[]): void {
  for (const operand of mediaOperands(parts)) children.push({ kind: "expression", node: operand });
  for (const block of mediaHandlerBlocks(parts))
    for (const child of block.statements) children.push({ kind: "statement", node: child });
}

function visitSay(parts: SayParts, visitor: Visitor, children: VisitItem[]): void {
  visitor.say(parts);
  for (const operand of sayOperands(parts)) children.push({ kind: "expression", node: operand });
}

function visitShowButton(parts: ShowButtonParts, visitor: Visitor, children: VisitItem[]): void {
  visitor.showButton(parts);
  children.push({ kind: "expression", node: parts.label });
  for (const option of showButtonOptions(parts))
    children.push({ kind: "expression", node: option.value });
}

function visitExpression(expression: Expression, visitor: Visitor, children: VisitItem[]): void {
  switch (expression.kind) {
    case "showButtonExpression":
      visitShowButton(expression, visitor, children);
      return;
    case "sayExpression":
      visitSay(expression, visitor, children);
      return;
    case "interactionExpression":
      visitor.interaction(expression);
      for (const operand of askParts(expression))
        children.push({ kind: "expression", node: operand });
      return;
    case "parenthesizedExpression":
      children.push({ kind: "expression", node: expression.expression });
      return;
    case "listLiteral":
      for (const item of expression.elements) children.push({ kind: "expression", node: item });
      return;
    case "setLiteral":
      for (const item of expression.elements) children.push({ kind: "expression", node: item });
      return;
    case "objectLiteral":
      for (const property of expression.properties)
        children.push({ kind: "expression", node: property.value });
      return;
    case "dictLiteral":
      for (const entry of expression.entries) {
        children.push({ kind: "expression", node: entry.key });
        children.push({ kind: "expression", node: entry.value });
      }
      return;
    case "propertyAccessExpression":
      children.push({ kind: "expression", node: expression.object });
      return;
    case "indexExpression":
      children.push({ kind: "expression", node: expression.object });
      children.push({ kind: "expression", node: expression.index });
      return;
    case "callExpression":
      children.push({ kind: "expression", node: expression.callee });
      if (expression.presentation !== undefined)
        children.push({ kind: "expression", node: expression.presentation });
      for (const argument of expression.arguments)
        children.push({ kind: "expression", node: argument.value });
      return;
    case "showPopupExpression":
      for (const argument of expression.arguments)
        children.push({ kind: "expression", node: argument.value });
      return;
    case "unaryExpression":
    case "unitExpression":
    case "angleExpression":
      children.push({ kind: "expression", node: expression.operand });
      return;
    case "binaryExpression":
      children.push({ kind: "expression", node: expression.left });
      children.push({ kind: "expression", node: expression.right });
      return;
    case "rangeExpression":
      children.push({ kind: "expression", node: expression.start });
      children.push({ kind: "expression", node: expression.end });
      return;
    case "stringLiteral":
      for (const part of expression.parts)
        if (part.kind === "stringInterpolation")
          children.push({ kind: "expression", node: part.expression });
      return;
    case "timerExpression":
      visitTimer(expression, children);
      return;
    case "showPermanentButtonExpression":
      visitPermanentButton(expression, children);
      return;
    case "playMediaExpression":
      visitMedia(expression, children);
      return;
    case "typeTestExpression":
      children.push({ kind: "expression", node: expression.value });
      return;
    case "loadExpression":
      children.push({ kind: "expression", node: expression.key });
      if (expression.defaultValue !== null)
        children.push({ kind: "expression", node: expression.defaultValue });
      return;
    case "tagQueryExpression":
      for (const operand of tagQueryOperands(expression))
        children.push({ kind: "expression", node: operand });
      return;
    case "identifier":
    case "booleanLiteral":
    case "nullLiteral":
    case "numberLiteral":
    case "durationLiteral":
    case "regexLiteral":
    case "showCameraExpression":
      return;
  }
  expression satisfies never;
}

interface OffsetEdit {
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

function whitespaceEdit(
  source: string,
  start: number,
  end: number,
  desired: string,
  edits: OffsetEdit[],
): void {
  if (end < start) return;
  const current = source.slice(start, end);
  if (!/^\s*$/u.test(current) || current === desired) return;
  edits.push({ start, end, newText: desired });
}

function formatShowButton(source: string, node: ShowButtonParts, edits: OffsetEdit[]): void {
  let cursor = node.commandSpan.end.offset;
  if (node.asSpan !== null && node.speaker !== null) {
    whitespaceEdit(source, cursor, node.asSpan.start.offset, " ", edits);
    whitespaceEdit(source, node.asSpan.end.offset, node.speaker.span.start.offset, " ", edits);
    cursor = node.speaker.span.end.offset;
  }
  whitespaceEdit(source, cursor, node.label.span.start.offset, " ", edits);
}

function formatInteraction(source: string, node: InteractionExpression, edits: OffsetEdit[]): void {
  let cursor = node.commandSpan.end.offset;
  if (node.asSpan !== null && node.speaker !== null) {
    whitespaceEdit(source, cursor, node.asSpan.start.offset, " ", edits);
    whitespaceEdit(source, node.asSpan.end.offset, node.speaker.span.start.offset, " ", edits);
    cursor = node.speaker.span.end.offset;
  }
  if (node.interactionKind !== "choice") {
    if (node.presentation !== null) {
      whitespaceEdit(source, cursor, node.presentation.span.start.offset, " ", edits);
      cursor = node.presentation.span.end.offset;
    }
    if (node.question !== null)
      whitespaceEdit(source, cursor, node.question.span.start.offset, " ", edits);
    return;
  }
  const first = node.options[0];
  if (first !== undefined) whitespaceEdit(source, cursor, first.span.start.offset, " ", edits);
  for (let index = 0; index < node.options.length; index += 1) {
    const option = node.options[index]!;
    if (option.value !== null && option.colonSpan !== null) {
      whitespaceEdit(
        source,
        option.value.span.end.offset,
        option.colonSpan.start.offset,
        "",
        edits,
      );
      whitespaceEdit(
        source,
        option.colonSpan.end.offset,
        option.expression.span.start.offset,
        " ",
        edits,
      );
    }
    if (option.separatorSpan !== null) {
      whitespaceEdit(
        source,
        option.expression.span.end.offset,
        option.separatorSpan.start.offset,
        "",
        edits,
      );
      const next = node.options[index + 1];
      if (next !== undefined)
        whitespaceEdit(source, option.separatorSpan.end.offset, next.span.start.offset, " ", edits);
    }
  }
}

function formatSay(
  source: string,
  node: SayParts,
  regexStarts: ReadonlySet<number>,
  edits: OffsetEdit[],
): void {
  const tokens = lex(
    source.slice(node.span.start.offset, node.span.end.offset),
    regexStartsWithin(regexStarts, node.span.start.offset, node.span.end.offset),
  ).tokens.filter(
    (token) => token.kind !== TokenKind.EndOfFile && token.kind !== TokenKind.Newline,
  );
  const absolute = (token: Token) => ({
    start: token.span.start.offset + node.span.start.offset,
    end: token.span.end.offset + node.span.start.offset,
  });
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const left = tokens[index]!;
    const right = tokens[index + 1]!;
    const l = absolute(left);
    const r = absolute(right);
    if (left.kind === TokenKind.Comma) whitespaceEdit(source, l.end, r.start, " ", edits);
    else if (right.kind === TokenKind.Comma) whitespaceEdit(source, l.end, r.start, "", edits);
    // `say(` keeps its spelling: the bounded form reads the same with or without a space.
    else if (left.kind === TokenKind.KeywordSay && right.kind === TokenKind.LeftParenthesis) {
      if (l.end !== r.start) whitespaceEdit(source, l.end, r.start, " ", edits);
    } else if (
      left.kind === TokenKind.KeywordSay ||
      left.kind === TokenKind.KeywordAs ||
      tokenIsSayModifier(left)
    )
      whitespaceEdit(source, l.end, r.start, " ", edits);
  }
}

/**
 * The offsets of `starts` from `start` up to `end`, counted from `start`: where a regex literal starts in that part of the
 * source although the token before does not show it, for lexing the part alone as the parse read it (V30 §8).
 */
function regexStartsWithin(starts: ReadonlySet<number>, start: number, end: number): Set<number> {
  const within = new Set<number>();
  for (const offset of starts) if (offset >= start && offset < end) within.add(offset - start);
  return within;
}

function tokenIsSayModifier(token: Token): boolean {
  return (
    token.kind === TokenKind.Identifier &&
    (token.lexeme === "skippable" || token.lexeme === "unskippable")
  );
}

function normalizeOffsetEdits(edits: readonly OffsetEdit[]): readonly OffsetEdit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const result: OffsetEdit[] = [];
  for (const edit of sorted) {
    const previous = result.at(-1);
    if (previous !== undefined && edit.start < previous.end) continue;
    if (previous !== undefined && edit.start === previous.start && edit.end === previous.end)
      continue;
    result.push(edit);
  }
  return Object.freeze(result);
}
