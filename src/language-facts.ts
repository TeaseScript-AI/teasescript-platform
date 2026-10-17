/**
 * The finite facts of the language that the lexer, the parser, the checks, the plan validation, and the editor tooling
 * read: the keywords, the protected names (V30 §38), the words the parser reads by name, and the units.
 */
import type { InteractionExpression } from "./ast.js";
import { TokenKind } from "./token.js";

/** Names reserved by the accepted V30 TeaseScript specification. */
export const TEASESCRIPT_GRAMMAR_KEYWORDS = Object.freeze([
  "let",
  "function",
  "return",
  "if",
  "else",
  "switch",
  "case",
  "default",
  "repeat",
  "for",
  "in",
  "while",
  "break",
  "continue",
  "and",
  "or",
  "not",
  "set",
  "true",
  "false",
  "null",
  "speaker",
  "say",
  "as",
  "label",
  "goto",
  "call",
  "end",
  "exit",
  "fallback",
  "global",
  "tagged",
  "save",
  "load",
  "delete",
  "is",
  "otherwise",
] as const);

/**
 * The words that the lexer reads as a token of their own, by kind: grammar keywords, and the engine name `wait`. Every
 * other word is an identifier, which the parser reads by its name where the grammar gives it a meaning (`COMMANDS`).
 */
export const KEYWORD_TOKENS: ReadonlyMap<string, TokenKind> = new Map([
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
  ["is", TokenKind.KeywordIs],
  ["otherwise", TokenKind.KeywordOtherwise],
]);

export const TEASESCRIPT_PROTECTED_TYPE_NAMES = Object.freeze([
  "string",
  "boolean",
  "integer",
  "number",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
  "calendarDuration",
  // The earlier name stays reserved, so its use is a compile error that names the fix (ADR 0026).
  "timestamp",
  "duration",
  "angle",
  "list",
  "dict",
  "object",
  "range",
  "media",
  "messageHandle",
  "script",
  "regex",
] as const);

const TEASESCRIPT_PROTECTED_ENGINE_NAMES = Object.freeze([
  "player",
  "random",
  "randomInteger",
  "chance",
  "round",
  "floor",
  "ceil",
  "min",
  "max",
  "abs",
  "sqrt",
  "pow",
  "sign",
  "mod",
  "clamp",
  "pi",
  "debugMode",
  "sum",
  "average",
  "median",
  "percentile",
  "stddev",
  "linearRegression",
  "predict",
  "randomWeighted",
  "exp",
  "ln",
  "log10",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  "toDeg",
  "toRad",
  "randomNormal",
  "randomBeta",
  "randomPert",
  "toString",
  "toNumber",
  "toInteger",
  "toBoolean",
  "toDate",
  "toTime",
  "toDateTime",
  "toAbsoluteDateTime",
  "toJson",
  "fromJson",
  "toBase64",
  "fromBase64",
  "fileFromBase64",
  "fileToBase64",
  "hashText",
  "hashFile",
  "encryptText",
  "encryptFile",
  "decryptText",
  "decryptFile",
  "toRegex",
  "getDate",
  "getTime",
  "getDateTime",
  "getAbsoluteDateTime",
  // The earlier names stay reserved, so their calls are compile errors that name the fix (ADR 0026).
  "toTimestamp",
  "getTimestamp",
  "schedule",
  "cancelSchedule",
  "askText",
  "askNumber",
  "askChoice",
  // The earlier name of `askChoice` stays reserved, so its use is a compile error that names the fix (#830).
  "choose",
  "showButton",
  "takePhoto",
  "askImage",
  "showPopup",
  "openUrl",
  "exportText",
  "askInteger",
  "askBoolean",
  "askBooleans",
  "askForm",
  "askDate",
  "askTime",
  "askDateTime",
  "askPassword",
  "wait",
  "timer",
  "showPermanentButton",
  // The earlier way to remove a permanent button stays reserved, so its call is a compile error that names
  // `button.remove()` (#836).
  "removePermanentButton",
  "playAudio",
  "playVideo",
  "stopAudio",
  "showBackgroundColor",
  "showBackgroundImage",
  "showOverlayImage",
  "showOverlayVideo",
  "showImage",
  "moveOverlay",
  "animateOverlay",
  "hideOverlay",
  "hideImage",
  "showCamera",
  "hideCamera",
  "showBlur",
  "hideBlur",
  "drawRectangle",
  "drawEllipse",
  "drawLine",
  "drawText",
  "removeDrawing",
  "account",
  "askAccountChange",
  "publishGlobal",
  "getGlobal",
  "loadFromScript",
  "getScriptMetadata",
  "getPlayerHistory",
  "findImages",
  "findScripts",
] as const);

export const CORE_RUNTIME_BUILTINS = Object.freeze([
  "random",
  "chance",
  "randomInteger",
  "toString",
  "toNumber",
  "toInteger",
  "toBoolean",
  "round",
  "floor",
  "ceil",
  "min",
  "max",
  "abs",
  "sqrt",
  "pow",
  "sign",
  "mod",
  "clamp",
  "sum",
  "average",
  "median",
  "percentile",
  "stddev",
  "linearRegression",
  "predict",
  "randomWeighted",
  "exp",
  "ln",
  "log10",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  "toDeg",
  "toRad",
  "randomNormal",
  "randomBeta",
  "randomPert",
  "toDate",
  "toTime",
  "toDateTime",
  "toAbsoluteDateTime",
  "toJson",
  "fromJson",
  "toBase64",
  "fromBase64",
  "fileFromBase64",
  "fileToBase64",
  "hashText",
  "hashFile",
  "encryptText",
  "encryptFile",
  "decryptText",
  "decryptFile",
  "toRegex",
  "getDate",
  "getTime",
  "getDateTime",
  "getAbsoluteDateTime",
  "script",
] as const);

/** The earlier names of core built-ins, whose calls are compile errors that name the fix (ADR 0026). */
export const RENAMED_BUILTINS: ReadonlyMap<string, string> = new Map([
  ["getTimestamp", "getAbsoluteDateTime"],
  ["toTimestamp", "toAbsoluteDateTime"],
]);

/** The earlier names of methods, whose calls are compile errors that name the fix on any value (ADR 0026). */
export const RENAMED_METHODS: ReadonlyMap<string, string> = new Map([
  ["toTimestamp", "toAbsoluteDateTime"],
]);

/** Temporary direct-call bridge for implemented Platform Standard Library helpers. */
export const PLATFORM_STANDARD_LIBRARY_PRELUDE = Object.freeze(["escapeMarkup"] as const);

export const TEASESCRIPT_PROTECTED_NAMES = Object.freeze([
  ...TEASESCRIPT_GRAMMAR_KEYWORDS,
  ...TEASESCRIPT_PROTECTED_TYPE_NAMES,
  ...TEASESCRIPT_PROTECTED_ENGINE_NAMES,
  ...PLATFORM_STANDARD_LIBRARY_PRELUDE,
] as const);

/** The code of a declaration that takes a protected name. */
export const PROTECTED_NAME_CODE = "TSV001";

/**
 * Why a declaration may not take a protected name, with the fix (TSV001): another name, such as `waitLabel` for a label
 * and `waitValue` for any other declaration; a speaker `player` needs none.
 */
export function protectedNameMessage(
  name: string,
  declaration: "label" | "speaker" | "other",
): string {
  if (declaration === "speaker" && name === "player")
    return "'player' is the built-in speaker for the person playing, so it needs no declaration. Assign its fields instead, as in 'player.color = ...'.";
  return declaration === "label"
    ? `Label '${name}' conflicts with a protected TeaseScript name. Choose another name, such as '${name}Label'.`
    : `Declaration '${name}' conflicts with a protected TeaseScript name. Choose another name, such as '${name}Value'.`;
}

/** How the parser reads a word of `COMMANDS`. */
export interface CommandFacts {
  /**
   * Whether a statement starts with the word. A `line` statement starts wherever a line starts with it, so a value
   * broken over lines never goes on with it (see the parser's `#atStatementStart`); a line may go on with the value form
   * of a `start` word, as after `key:`.
   */
  readonly statement?: "line" | "start";
  /** Whether the word gives a value where an expression starts. */
  readonly value?: true;
  /**
   * The compact interactions, written `command [as speaker] [mode] question or label, name: option`: `button` for
   * `showButton`, and for an ask the kind of answer it waits for.
   */
  readonly interaction?: InteractionExpression["interactionKind"] | "button";
  /** The current name of an earlier one, which the parser reads as that one and reports with the fix. */
  readonly renamed?: string;
}

/**
 * Every word that the parser reads by its name as a statement or a value: the grammar keywords that the lexer reads as
 * identifiers, the commands of the engine (V30 §9), and the asks. The lexer's `KEYWORD_TOKENS`, such as `say` and
 * `wait`, are read by their kind; a call, such as `takePhoto()`, `askImage(...)`, or `round(x)`, the constant `pi`, and
 * a `dict { ... }` literal are read as values of their own form.
 */
export const COMMANDS = Object.freeze({
  save: { statement: "line" },
  delete: { statement: "line" },
  switch: { statement: "line" },
  label: { statement: "line" },
  goto: { statement: "line" },
  call: { statement: "line" },
  fallback: { statement: "line" },
  end: { statement: "line" },
  global: { statement: "start" },
  load: { value: true },
  showButton: { statement: "line", value: true, interaction: "button" },
  showPopup: { statement: "line", value: true },
  showImage: { statement: "line" },
  hideImage: { statement: "line" },
  hideCamera: { statement: "line" },
  openUrl: { statement: "line" },
  exportText: { statement: "line" },
  stopAudio: { statement: "line" },
  timer: { statement: "start", value: true },
  showCamera: { statement: "start", value: true },
  showPermanentButton: { statement: "start", value: true },
  playAudio: { statement: "start", value: true },
  playVideo: { statement: "start", value: true },
  askText: { value: true, interaction: "text" },
  askNumber: { value: true, interaction: "number" },
  askInteger: { value: true, interaction: "integer" },
  askDate: { value: true, interaction: "date" },
  askTime: { value: true, interaction: "time" },
  askDateTime: { value: true, interaction: "datetime" },
  askPassword: { value: true, interaction: "password" },
  askBoolean: { value: true, interaction: "boolean" },
  askForm: { value: true, interaction: "form" },
  askBooleans: { value: true, interaction: "booleans" },
  askChoice: { value: true, interaction: "choice" },
  // #830
  choose: { value: true, interaction: "choice", renamed: "askChoice" },
} as const satisfies Readonly<Record<string, CommandFacts>>);

export type CommandName = keyof typeof COMMANDS;
type CommandsWith<Facts> = {
  [Name in CommandName]: (typeof COMMANDS)[Name] extends Facts ? Name : never;
}[CommandName];
/** The words that start a statement. */
export type StatementCommand = CommandsWith<{ readonly statement: string }>;
/** The words that give a value. */
export type ValueCommand = CommandsWith<{ readonly value: true }>;
/** The asks, also an earlier name of one. */
export type AskCommand = CommandsWith<{
  readonly interaction: InteractionExpression["interactionKind"];
}>;

/** The earlier names, which the parser reads as their current ones. */
export type RenamedCommand = CommandsWith<{ readonly renamed: string }>;

/** Whether the parser reads `word` by its name (see `COMMANDS`). */
export function isCommand(word: string): word is CommandName {
  return Object.hasOwn(COMMANDS, word);
}

/** Whether `word` is an ask (see `COMMANDS`). */
export function isAsk(word: string): word is AskCommand {
  const interaction = commandFacts(word)?.interaction;
  return interaction !== undefined && interaction !== "button";
}

/** How the parser reads `word`, or `undefined` for a word it does not read by name (see `COMMANDS`). */
export function commandFacts(word: string): CommandFacts | undefined {
  return isCommand(word) ? COMMANDS[word] : undefined;
}

/** The exact units of a duration, from milliseconds to weeks (ADR 0026). */
export const DURATION_UNITS = Object.freeze(["ms", "s", "min", "h", "d", "w"] as const);
/** The units after `calendar`: calendar days and weeks, months, and years (ADR 0026). */
export const CALENDAR_DURATION_UNITS = Object.freeze(["d", "w", "mo", "y"] as const);
/** The units of an angle: degrees and radians. */
export const ANGLE_UNITS = Object.freeze(["deg", "rad"] as const);

/** Each name of an exact unit, short or long, and the unit it names. */
export const DURATION_UNIT_NAMES: ReadonlyMap<string, (typeof DURATION_UNITS)[number]> = new Map([
  ["ms", "ms"],
  ["millisecond", "ms"],
  ["milliseconds", "ms"],
  ["s", "s"],
  ["second", "s"],
  ["seconds", "s"],
  ["min", "min"],
  ["minute", "min"],
  ["minutes", "min"],
  ["h", "h"],
  ["hour", "h"],
  ["hours", "h"],
  ["d", "d"],
  ["day", "d"],
  ["days", "d"],
  ["w", "w"],
  ["week", "w"],
  ["weeks", "w"],
]);

/** Each name of a unit after `calendar`, short or long, and the unit it names. */
export const CALENDAR_DURATION_UNIT_NAMES: ReadonlyMap<
  string,
  (typeof CALENDAR_DURATION_UNITS)[number]
> = new Map([
  ["d", "d"],
  ["day", "d"],
  ["days", "d"],
  ["w", "w"],
  ["week", "w"],
  ["weeks", "w"],
  ["mo", "mo"],
  ["month", "mo"],
  ["months", "mo"],
  ["y", "y"],
  ["year", "y"],
  ["years", "y"],
]);

/** Each name of an angle unit, short or long, and the unit it names. */
export const ANGLE_UNIT_NAMES: ReadonlyMap<string, (typeof ANGLE_UNITS)[number]> = new Map([
  ["deg", "deg"],
  ["degree", "deg"],
  ["degrees", "deg"],
  ["rad", "rad"],
  ["radian", "rad"],
  ["radians", "rad"],
]);
