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
  | PlayMediaStatement
  | SaveStatement
  | DeleteStatement
  | ExitStatement
  | LetStatement
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

export interface ExitStatement {
  readonly kind: "exitStatement";
  readonly span: SourceSpan;
}

export interface LetStatement {
  readonly kind: "letStatement";
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation | null;
  readonly initializer: Expression;
  readonly span: SourceSpan;
}

export type ScalarTypeName =
  "string" | "boolean" | "integer" | "number" | "date" | "time" | "datetime" | "duration";

/** A type name: a scalar type, `null`, any `list`, `set`, or `object`, or a program-control type (ADR 0021). */
export type TypeName =
  ScalarTypeName | "null" | "list" | "set" | "object" | "range" | "speaker" | "timer" | "media";

/** A written type: a name, `T[]`, `T set`, `T?`, or a union `A | B`. Parentheses only group. */
export type TypeAnnotation = NamedType | CollectionType | OptionalType | UnionType;

export interface NamedType {
  readonly kind: "namedType";
  readonly name: TypeName;
  readonly span: SourceSpan;
}

/** `T[]` or `T set`. */
export interface CollectionType {
  readonly kind: "listType" | "setType";
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

/** One `case`: its literal values and number ranges, any of which selects the block. */
export interface SwitchCase {
  readonly kind: "switchCase";
  readonly values: readonly Expression[];
  readonly body: Block;
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
  readonly expression: CallExpression;
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
  | LoadExpression
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
  readonly interactionKind: "text" | "number" | "integer" | "choice";
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

/** A V30 exact elapsed-duration literal such as `30 s` or `2 minutes`. */
export interface DurationLiteral {
  readonly kind: "durationLiteral";
  readonly amount: NumberLiteral;
  readonly unit: DurationUnit;
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
