import type { SourceSpan } from "./source.js";

export interface Program {
  readonly kind: "program";
  readonly statements: readonly Statement[];
  readonly span: SourceSpan;
}

export type Statement =
  | SpeakerDeclaration
  | SpeakerSetterStatement
  | SayStatement
  | ShowButtonStatement
  | WaitStatement
  | TimerStatement
  | ShowImageStatement
  | HideImageStatement
  | ShowCameraStatement
  | HideCameraStatement
  | ShowPermanentButtonStatement
  | PlayMediaStatement
  | SaveStatement
  | DeleteStatement
  | ExitStatement
  | EndStatement
  | LabelStatement
  | GotoStatement
  | CallFileStatement
  | FallbackStatement
  | LetStatement
  | GlobalStatement
  | AssignmentStatement
  | IfStatement
  | SwitchStatement
  | RepeatStatement
  | ForStatement
  | WhileStatement
  | BreakStatement
  | ContinueStatement
  | FunctionDeclaration
  | ReturnStatement
  | ExpressionStatement;

export interface Block {
  readonly kind: "block";
  readonly statements: readonly Statement[];
  readonly span: SourceSpan;
}

export interface SpeakerDeclaration {
  readonly kind: "speakerDeclaration";
  readonly name: Identifier;
  readonly properties: readonly SpeakerProperty[];
  readonly span: SourceSpan;
}

export interface SpeakerProperty {
  readonly kind: "speakerProperty";
  readonly name: Identifier;
  readonly value: Expression;
  readonly span: SourceSpan;
}

export interface SpeakerSetterStatement {
  readonly kind: "speakerSetterStatement";
  readonly speaker: Identifier;
  readonly span: SourceSpan;
}

export interface SayStatement {
  readonly presentation: ObjectLiteral | null;
  readonly kind: "sayStatement";
  readonly speaker: Identifier | null;
  readonly skipPolicy: "skippable" | "unskippable" | null;
  readonly value: Expression;
  readonly pacing: Expression | "instant" | null;
  readonly span: SourceSpan;
}

/**
 * Shared data of `showButton [as speaker] label [, background: colour] [, timeout: duration]`. The options may appear
 * in either order and evaluate in source order.
 */
export interface ShowButtonParts {
  readonly commandSpan: SourceSpan;
  readonly asSpan: SourceSpan | null;
  readonly speaker: Identifier | null;
  readonly label: Expression;
  readonly background: Expression | null;
  /** A number of seconds or an elapsed duration after which the button disappears. */
  readonly timeout: Expression | null;
  readonly span: SourceSpan;
}

/** A button whose elapsed-time result is ignored. */
export interface ShowButtonStatement extends ShowButtonParts {
  readonly kind: "showButtonStatement";
}

/** A button used as a value; it evaluates to the elapsed waiting time as a `duration`. */
export interface ShowButtonExpression extends ShowButtonParts {
  readonly kind: "showButtonExpression";
}

/** A compiler-owned blocking delay. A missing unit means seconds. */
export interface WaitStatement {
  readonly kind: "waitStatement";
  readonly duration: Expression;
  readonly unit: "ms" | "s" | "min" | "h" | null;
  readonly span: SourceSpan;
}

export type TimerDisplay = "visible" | "mystery" | "hidden";

/**
 * Shared data of the short form `timer [async] [display] <duration> [unit] ["label"] [{ ... }]` and the named form
 * `timer(duration:, async:, display:, label:, repeat:, persist:) [{ ... }]`.
 */
export interface TimerParts {
  readonly form: "short" | "named";
  readonly async: boolean;
  /** A short-form modifier is a static display; the named form may use any expression. */
  readonly display: TimerDisplay | Expression | null;
  readonly duration: Expression;
  readonly unit: DurationUnit | null;
  readonly label: Expression | null;
  readonly repeat: boolean;
  readonly persist: boolean;
  readonly handler: Block | null;
  readonly commandSpan: SourceSpan;
  readonly span: SourceSpan;
}

/** A blocking timer, or an asynchronous timer whose handle is ignored. */
export interface TimerStatement extends TimerParts {
  readonly kind: "timerStatement";
}

/** An asynchronous timer used as a value; it evaluates to its handle. */
export interface TimerExpression extends TimerParts {
  readonly kind: "timerExpression";
}

/** `showImage <file>`: sets the persistent Stage image; a `null` value clears it with a developer warning. */
export interface ShowImageStatement {
  readonly kind: "showImageStatement";
  readonly image: Expression;
  readonly span: SourceSpan;
}

/** `hideImage`: clears the persistent Stage image. */
export interface HideImageStatement {
  readonly kind: "hideImageStatement";
  readonly span: SourceSpan;
}

/** Where a camera view is shown: the Player's floating window, or over the Stage image, which stays underneath. */
export type CameraPlacement = "window" | "stage";

/** `showCamera [stage]` whose camera view handle is ignored. */
export interface ShowCameraStatement {
  readonly kind: "showCameraStatement";
  readonly placement: CameraPlacement;
  readonly span: SourceSpan;
}

/** `showCamera [stage]` used as a value; it evaluates to the camera view's handle. */
export interface ShowCameraExpression {
  readonly kind: "showCameraExpression";
  readonly placement: CameraPlacement;
  readonly span: SourceSpan;
}

/** `hideCamera`: hides every camera view. */
export interface HideCameraStatement {
  readonly kind: "hideCameraStatement";
  readonly span: SourceSpan;
}

/**
 * Shared data of `showPermanentButton <text>[, persist: true] { ... }`. The block is the click action; `persist: true`
 * keeps the button when the file entry that showed it is left.
 */
export interface ShowPermanentButtonParts {
  readonly text: Expression;
  readonly persist: boolean;
  readonly handler: Block;
  readonly commandSpan: SourceSpan;
  readonly span: SourceSpan;
}

/** A permanent button whose identifier is ignored. */
export interface ShowPermanentButtonStatement extends ShowPermanentButtonParts {
  readonly kind: "showPermanentButtonStatement";
}

/** A permanent button used as a value; it evaluates to the button's identifier. */
export interface ShowPermanentButtonExpression extends ShowPermanentButtonParts {
  readonly kind: "showPermanentButtonExpression";
}

export type MediaKind = "audio" | "video";

/**
 * The compact `repeat` modifier (`indefinite`), a named `repeat: <value>` (`true`, `false`, or a duration budget), or a
 * named `repeat: <count> times`.
 */
export type MediaRepeat =
  | { readonly kind: "indefinite"; readonly span: SourceSpan }
  | { readonly kind: "value"; readonly value: Expression; readonly span: SourceSpan }
  | { readonly kind: "times"; readonly count: Expression; readonly span: SourceSpan };

/** One structured timeline cue: `at <position> { ... }`, `beforeEnd <offset> { ... }`, or `finish { ... }`. */
export interface MediaCue {
  readonly kind: "at" | "beforeEnd" | "finish";
  /** The cue point; `null` for `finish`. */
  readonly offset: Expression | null;
  readonly body: Block;
  readonly keywordSpan: SourceSpan;
  readonly span: SourceSpan;
}

/**
 * A block after a play command. Ordinary statements form a compact block that runs at the end of every pass, like
 * `beforeEnd 0 s`; a block of cue declarations lists structured cues.
 */
export type MediaHandlers =
  | { readonly kind: "compact"; readonly body: Block }
  | { readonly kind: "cues"; readonly cues: readonly MediaCue[]; readonly span: SourceSpan };

/**
 * Shared data of the short form `playAudio|playVideo [async] [repeat] <file> [{ ... }]` and the named form
 * `playAudio|playVideo(file:, async:, repeat:, startAt:, endAt:, volume:) [{ ... }]`.
 */
export interface MediaParts {
  readonly media: MediaKind;
  readonly form: "short" | "named";
  readonly async: boolean;
  readonly file: Expression;
  readonly repeat: MediaRepeat | null;
  readonly startAt: Expression | null;
  readonly endAt: Expression | null;
  readonly volume: Expression | null;
  readonly handlers: MediaHandlers | null;
  readonly commandSpan: SourceSpan;
  readonly span: SourceSpan;
}

/** Blocking playback, or asynchronous playback whose handle is ignored. */
export interface PlayMediaStatement extends MediaParts {
  readonly kind: "playMediaStatement";
}

/** Asynchronous playback used as a value; it evaluates to its handle. */
export interface PlayMediaExpression extends MediaParts {
  readonly kind: "playMediaExpression";
}

/** `save <value> as <key>`: stores a copy of the value in script storage; saving `null` removes the key. */
export interface SaveStatement {
  readonly kind: "saveStatement";
  readonly value: Expression;
  readonly key: Expression;
  readonly span: SourceSpan;
}

/** `delete <key>`: removes the key from script storage. */
export interface DeleteStatement {
  readonly kind: "deleteStatement";
  readonly key: Expression;
  readonly span: SourceSpan;
}

/** `load <key>[, default: <value>]`: the stored value, else the default (evaluated only then), else `null`. */
export interface LoadExpression {
  readonly kind: "loadExpression";
  readonly key: Expression;
  readonly defaultValue: Expression | null;
  readonly span: SourceSpan;
}

/**
 * A tag query (ADR 0023): `showImage tagged …` picks one matching image and `findImages(…)` lists the matches;
 * `goto tagged …`, `call tagged …`, and `fallback tagged …` pick one matching file and `findScripts(…)` lists them. The
 * steps are in postfix order; every bound and tag list appears in written order, which is also its evaluation order.
 * A candidate matches when the steps yield true; without steps, every candidate matches.
 */
export interface TagQueryExpression {
  readonly kind: "tagQueryExpression";
  readonly catalog: "images" | "scripts";
  readonly select: "random" | "list";
  readonly steps: readonly TagQueryStep[];
  /** A script query's `from:`, a literal path or glob that limits the candidate files; `null` for all of them. */
  readonly from: { readonly pattern: string; readonly span: SourceSpan } | null;
  readonly span: SourceSpan;
}

export type TagQueryStep =
  /** `"bedroom"`: whether the candidate has the tag. */
  | { readonly kind: "tag"; readonly name: string; readonly span: SourceSpan }
  /** `"punishment" > minimum`: compares the tag's number; false when the candidate has no number for it. */
  | {
      readonly kind: "tagCompare";
      readonly name: string;
      readonly operator: TagComparisonOperator;
      readonly bound: Expression;
      readonly span: SourceSpan;
    }
  /** `all:`, `none:`, or `any:` with a list of tag names. */
  | {
      readonly kind: "tagList";
      readonly option: TagListOption;
      readonly value: Expression;
      readonly span: SourceSpan;
    }
  | { readonly kind: "and" | "or" | "not" };

export type TagComparisonOperator = "==" | "!=" | "<" | "<=" | ">" | ">=";
export type TagListOption = "all" | "none" | "any";

export interface ExitStatement {
  readonly kind: "exitStatement";
  readonly span: SourceSpan;
}

/** `end`: ends the current file and returns to the file that called it (ADR 0022). */
export interface EndStatement {
  readonly kind: "endStatement";
  readonly span: SourceSpan;
}

/** `label name`, a `goto` destination in its file's outer scope. */
export interface LabelStatement {
  readonly kind: "labelStatement";
  readonly name: Identifier;
  readonly span: SourceSpan;
}

/** `goto target`: continues at a label of this file, or enters a file (ADR 0022). */
export interface GotoStatement {
  readonly kind: "gotoStatement";
  readonly target: TransferTarget;
  readonly span: SourceSpan;
}

/** `call target`: enters a file and continues after the call when that file reaches `end`. */
export interface CallFileStatement {
  readonly kind: "callFileStatement";
  readonly target: TransferTarget;
  readonly span: SourceSpan;
}

/** `fallback target` sets where an `end` without a caller continues; `fallback none` clears it. */
export interface FallbackStatement {
  readonly kind: "fallbackStatement";
  readonly target: TransferTarget | null;
  readonly span: SourceSpan;
}

/** Where a `goto`, `call`, or `fallback` continues: a label of this file, or a file from its top or at a label. */
export type TransferTarget = LabelTarget | FileTarget | ScriptTarget;

/** A target computed at runtime: a `script(...)` call or a grouped expression of type `script`, as in `goto (next)`. */
export interface ScriptTarget {
  readonly kind: "scriptTarget";
  readonly expression: Expression;
  readonly span: SourceSpan;
}

export interface LabelTarget {
  readonly kind: "labelTarget";
  readonly label: Identifier;
  readonly span: SourceSpan;
}

export interface FileTarget {
  readonly kind: "fileTarget";
  /** The quoted path, relative to the package root. */
  readonly path: string;
  readonly pathSpan: SourceSpan;
  readonly label: Identifier | null;
  readonly span: SourceSpan;
}

export interface LetStatement {
  readonly kind: "letStatement";
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation | null;
  readonly initializer: Expression;
  readonly span: SourceSpan;
}

/**
 * `global name[: Type] = value[, default: start]`, a variable of the whole project (ADR 0022 §6). It gets its
 * session-start value before the story runs, whether or not the declaration ever runs.
 */
export interface GlobalStatement {
  readonly kind: "globalStatement";
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation | null;
  /** The session-start value: `start` with `default:`, otherwise `value`. */
  readonly initial: Expression;
  /** With `default:`, the assignment `name = value` that the declaration performs each time it runs. */
  readonly assignment: AssignmentStatement | null;
  readonly span: SourceSpan;
}

export type ScalarTypeName =
  | "string"
  | "boolean"
  | "integer"
  | "number"
  | "date"
  | "time"
  | "datetime"
  | "timestamp"
  | "duration"
  | "script";

/**
 * A type name: a scalar type, `null`, any `list`, `set`, `dict`, or `object`, or a program-control type (ADR 0021).
 */
export type TypeName =
  | ScalarTypeName
  | "null"
  | "list"
  | "set"
  | "dict"
  | "object"
  | "range"
  | "speaker"
  | "timer"
  | "media";

/** A written type: a name, `T[]`, `T set`, `T dict`, `T?`, or a union `A | B`. Parentheses only group. */
export type TypeAnnotation = NamedType | CollectionType | OptionalType | UnionType;

export interface NamedType {
  readonly kind: "namedType";
  readonly name: TypeName;
  readonly span: SourceSpan;
}

/** `T[]`, `T set`, or `T dict`, whose values are of type `T`. */
export interface CollectionType {
  readonly kind: "listType" | "setType" | "dictType";
  readonly element: TypeAnnotation;
  readonly span: SourceSpan;
}

/** `T?`, which means `T | null`. */
export interface OptionalType {
  readonly kind: "optionalType";
  readonly value: TypeAnnotation;
  readonly span: SourceSpan;
}

export interface UnionType {
  readonly kind: "unionType";
  readonly members: readonly TypeAnnotation[];
  readonly span: SourceSpan;
}

export type AssignmentTarget = Identifier | PropertyAccessExpression | IndexExpression;

export interface AssignmentStatement {
  readonly kind: "assignmentStatement";
  /** `+=` and `-=` read the target once, then assign `target + value` or `target - value`. */
  readonly operator: "=" | "+=" | "-=";
  readonly target: AssignmentTarget;
  readonly value: Expression;
  readonly span: SourceSpan;
}

export interface IfStatement {
  readonly kind: "ifStatement";
  readonly condition: Expression;
  readonly thenBlock: Block;
  readonly elseBlock: Block | IfStatement | null;
  readonly span: SourceSpan;
}

export interface SwitchStatement {
  readonly kind: "switchStatement";
  readonly subject: Expression;
  readonly cases: readonly SwitchCase[];
  readonly defaultBlock: Block | null;
  readonly span: SourceSpan;
}

/**
 * One `case`: either its literal values and number ranges, any of which selects the block, or one type test, as in
 * `case is integer`, with no values.
 */
export interface SwitchCase {
  readonly kind: "switchCase";
  readonly values: readonly Expression[];
  readonly typeTest: SwitchTypeTest | null;
  readonly body: Block;
  readonly span: SourceSpan;
}

/** `is T` or `is not T` after `case`, testing the switched value like `value is T`. */
export interface SwitchTypeTest {
  readonly kind: "switchTypeTest";
  readonly type: TypeAnnotation;
  readonly negated: boolean;
  readonly span: SourceSpan;
}

export interface RepeatStatement {
  readonly kind: "repeatStatement";
  readonly count: Expression;
  readonly body: Block;
  readonly span: SourceSpan;
}

export interface ForStatement {
  readonly kind: "forStatement";
  readonly variable: Identifier;
  readonly iterable: Expression;
  readonly body: Block;
  readonly span: SourceSpan;
}

export interface WhileStatement {
  readonly kind: "whileStatement";
  readonly condition: Expression;
  readonly body: Block;
  readonly span: SourceSpan;
}

export interface BreakStatement {
  readonly kind: "breakStatement";
  readonly span: SourceSpan;
}

export interface ContinueStatement {
  readonly kind: "continueStatement";
  readonly span: SourceSpan;
}

export interface FunctionDeclaration {
  readonly kind: "functionDeclaration";
  /** A `global function`, callable from every file of the project (ADR 0022 §3). */
  readonly global: boolean;
  readonly name: Identifier;
  readonly parameters: readonly FunctionParameter[];
  readonly returnTypeAnnotation: TypeAnnotation | null;
  readonly body: Block;
  readonly span: SourceSpan;
}

export interface FunctionParameter {
  readonly kind: "functionParameter";
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation | null;
  readonly defaultValue: Expression | null;
  readonly span: SourceSpan;
}

export interface ReturnStatement {
  readonly kind: "returnStatement";
  readonly value: Expression | null;
  readonly span: SourceSpan;
}

export interface ExpressionStatement {
  readonly kind: "expressionStatement";
  /** A call, or `findImages(…)`, which reads like one. */
  readonly expression: CallExpression | TagQueryExpression;
  readonly span: SourceSpan;
}

export type Expression =
  | Identifier
  | BooleanLiteral
  | NullLiteral
  | NumberLiteral
  | DurationLiteral
  | StringLiteral
  | ListLiteral
  | ObjectLiteral
  | SetLiteral
  | DictLiteral
  | ParenthesizedExpression
  | PropertyAccessExpression
  | IndexExpression
  | CallExpression
  | UnaryExpression
  | BinaryExpression
  | RangeExpression
  | InteractionExpression
  | ShowButtonExpression
  | TimerExpression
  | PlayMediaExpression
  | ShowCameraExpression
  | ShowPermanentButtonExpression
  | LoadExpression
  | TagQueryExpression
  | TypeTestExpression;

/** `value is T` or `value is not T`: whether the value may be stored in a place of type `T` (ADR 0021). */
export interface TypeTestExpression {
  readonly kind: "typeTestExpression";
  readonly value: Expression;
  readonly type: TypeAnnotation;
  readonly negated: boolean;
  readonly span: SourceSpan;
}

export interface InteractionExpression {
  readonly kind: "interactionExpression";
  readonly interactionKind: "text" | "number" | "integer" | "date" | "time" | "datetime" | "choice";
  readonly commandSpan: SourceSpan;
  readonly asSpan: SourceSpan | null;
  readonly speaker: Identifier | null;
  readonly hint: Expression | null;
  /** The `default:` answer that prefills an `askText` or `askNumber` field. */
  readonly defaultValue: Expression | null;
  readonly options: readonly InteractionChoiceOption[];
  readonly span: SourceSpan;
}

/** One compact `choose` option: an optional authored value before `:`, then its expression. */
export interface InteractionChoiceOption {
  readonly kind: "interactionChoiceOption";
  readonly value: Identifier | NumberLiteral | null;
  readonly colonSpan: SourceSpan | null;
  readonly expression: Expression;
  readonly separatorSpan: SourceSpan | null;
  readonly span: SourceSpan;
}

/** Kept as a compatibility alias for the initial parser POC public API. */
export type StringExpression = StringLiteral;

/** Kept as a compatibility alias; interpolation now accepts all expressions. */
export type InterpolationExpression = Expression;

export interface Identifier {
  readonly kind: "identifier";
  readonly name: string;
  readonly span: SourceSpan;
}

export interface BooleanLiteral {
  readonly kind: "booleanLiteral";
  readonly value: boolean;
  readonly span: SourceSpan;
}

export interface NullLiteral {
  readonly kind: "nullLiteral";
  readonly value: null;
  readonly span: SourceSpan;
}

export interface NumberLiteral {
  readonly kind: "numberLiteral";
  readonly raw: string;
  readonly value: number;
  readonly numericType: "integer" | "number";
  readonly span: SourceSpan;
}

export type DurationUnit = "ms" | "s" | "min" | "h";

/** Calendar units: days, weeks, months, and years (V30 §35). They only appear in duration literals. */
export type CalendarDurationUnit = "d" | "w" | "mo" | "y";

/** A V30 exact elapsed-duration literal such as `30 s` or `2 minutes`. */
export interface DurationLiteral {
  readonly kind: "durationLiteral";
  readonly amount: NumberLiteral;
  readonly unit: DurationUnit | CalendarDurationUnit;
  readonly unitSpan: SourceSpan;
  readonly span: SourceSpan;
}

export interface StringLiteral {
  readonly kind: "stringLiteral";
  readonly form: "singleLine" | "block";
  readonly parts: readonly StringPart[];
  readonly span: SourceSpan;
}

export type StringPart = StringText | StringInterpolation;

export interface StringText {
  readonly kind: "stringText";
  readonly raw: string;
  readonly value: string;
  readonly span: SourceSpan;
}

export interface StringInterpolation {
  readonly kind: "stringInterpolation";
  readonly expression: Expression;
  readonly span: SourceSpan;
}

export interface ListLiteral {
  readonly kind: "listLiteral";
  readonly elements: readonly Expression[];
  readonly span: SourceSpan;
}

export interface ObjectLiteral {
  readonly kind: "objectLiteral";
  readonly properties: readonly ObjectProperty[];
  readonly span: SourceSpan;
}

export interface ObjectProperty {
  readonly kind: "objectProperty";
  readonly name: Identifier;
  readonly value: Expression;
  readonly span: SourceSpan;
}

export interface SetLiteral {
  readonly kind: "setLiteral";
  readonly elements: readonly Expression[];
  readonly span: SourceSpan;
}

/** `dict{ name: value, "any text": value, [key]: value }`; every key is an expression that gives text. */
export interface DictLiteral {
  readonly kind: "dictLiteral";
  readonly entries: readonly DictEntry[];
  readonly span: SourceSpan;
}

/** One entry of a dict literal. A written name such as `collar:` is its text, as if quoted. */
export interface DictEntry {
  readonly kind: "dictEntry";
  readonly key: Expression;
  readonly value: Expression;
  readonly span: SourceSpan;
}

export interface ParenthesizedExpression {
  readonly kind: "parenthesizedExpression";
  readonly expression: Expression;
  readonly span: SourceSpan;
}

export interface PropertyAccessExpression {
  readonly kind: "propertyAccessExpression";
  readonly object: Expression;
  readonly property: Identifier;
  readonly span: SourceSpan;
}

export interface IndexExpression {
  readonly kind: "indexExpression";
  readonly object: Expression;
  readonly index: Expression;
  readonly span: SourceSpan;
}

export interface CallExpression {
  readonly kind: "callExpression";
  readonly callee: Expression;
  readonly arguments: readonly CallArgument[];
  /** `mixed`: positional arguments followed by named ones. */
  readonly argumentStyle: "none" | "positional" | "named" | "mixed";
  readonly span: SourceSpan;
}

export type CallArgument = PositionalArgument | NamedArgument;

export interface PositionalArgument {
  readonly kind: "positionalArgument";
  readonly value: Expression;
  readonly span: SourceSpan;
}

export interface NamedArgument {
  readonly kind: "namedArgument";
  readonly name: Identifier;
  readonly value: Expression;
  readonly span: SourceSpan;
}

export interface UnaryExpression {
  readonly kind: "unaryExpression";
  readonly operator: "+" | "-" | "not";
  readonly operand: Expression;
  readonly span: SourceSpan;
}

export interface BinaryExpression {
  readonly kind: "binaryExpression";
  readonly operator:
    "*" | "/" | "%" | "+" | "-" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";
  readonly left: Expression;
  readonly right: Expression;
  readonly span: SourceSpan;
}

export interface RangeExpression {
  readonly kind: "rangeExpression";
  readonly start: Expression;
  readonly end: Expression;
  readonly inclusive: boolean;
  readonly span: SourceSpan;
}
