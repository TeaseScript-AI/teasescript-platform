import type { StoredDuration } from "../duration.js";
import type { DateFields, DateTimeFields, TimeFields } from "../temporal.js";

export const INSTRUCTION_PLAN_FORMAT = "teasescript-instruction-plan";
export const INSTRUCTION_PLAN_VERSION = 50;

/** Compact serialized instruction-plan representation of a source range. */
export interface PlanSourceLocation {
  /** Inclusive start offset in UTF-16 code units. */
  readonly so: number;
  /** Zero-based line containing the inclusive start position. */
  readonly sl: number;
  /** Zero-based column of the inclusive start position. */
  readonly sc: number;
  /** Exclusive end offset in UTF-16 code units. */
  readonly eo: number;
  /** Zero-based line containing the exclusive end position. */
  readonly el: number;
  /** Zero-based column of the exclusive end position. */
  readonly ec: number;
}

export interface InstructionPlan {
  readonly format: typeof INSTRUCTION_PLAN_FORMAT;
  readonly version: typeof INSTRUCTION_PLAN_VERSION;
  /** `main.tease` first, then the other files in path order; their blocks follow each other in the same order. */
  readonly files: readonly PlanFile[];
  /** The package images that tag queries search, by path (ADR 0023). */
  readonly images: readonly PlanImage[];
  readonly temporaryCount: number;
  readonly functions: readonly CompiledFunctionDefinition[];
  readonly instructions: readonly Instruction[];
}

/**
 * One `.tease` file of the project: a contiguous block of instructions holding its root region, then its functions
 * and handlers. Locations inside the block are offsets in this file's source.
 */
export interface PlanFile {
  /** Path relative to the package root, with `/` between folders. */
  readonly path: string;
  readonly sourceSpan: PlanSourceLocation;
  readonly startInstruction: number;
  /** Where a `goto` or `call` that names the file without a label starts it. */
  readonly entryInstruction: number;
  /**
   * End of the root region, whose last instruction is the `end` that the compiler adds after the file's statements;
   * the file's functions and handlers follow up to {@link endInstruction}.
   */
  readonly rootEndInstruction: number;
  readonly endInstruction: number;
  /** The labels of the file's outer scope, in source order, each at the root instruction where it stands. */
  readonly labels: readonly PlanLabel[];
}

export interface PlanLabel {
  readonly name: string;
  readonly instruction: number;
}

/** A package image and its tags, generated from the image's XMP keywords. */
export interface PlanImage {
  /** Path relative to the package root, with `/` between folders. */
  readonly path: string;
  /** Each tag name once, in name order. */
  readonly tags: readonly PlanTag[];
}

export interface PlanTag {
  readonly name: string;
  readonly value: number | null;
}

export interface CompiledFunctionParameter {
  readonly name: string;
  readonly index: number;
  readonly hasDefault: boolean;
  readonly declarationSpan: PlanSourceLocation;
  readonly defaultSpan: PlanSourceLocation | null;
}

export interface CompiledFunctionDefinition {
  readonly id: number;
  /**
   * A parameterless timer expiry block or media cue block; it is entered only by the runtime as an interrupt, never by
   * `callFunction`. `null` for a user function.
   */
  readonly handler: "timer" | "media" | null;
  /**
   * A `global function`, which every file may call, or a block inside one. It sees the project's globals but not its
   * file's top-level variables (ADR 0022 §3).
   */
  readonly global: boolean;
  /** For a media block of `let NAME = play... async`, the local name bound to its own handle on entry. */
  readonly selfHandle: string | null;
  readonly name: string;
  readonly declarationSpan: PlanSourceLocation;
  readonly parameters: readonly CompiledFunctionParameter[];
  readonly entryInstruction: number;
  readonly bodyEntryInstruction: number;
  readonly implicitReturnInstruction: number;
  readonly endInstruction: number;
  readonly bodySpan: PlanSourceLocation;
}

export type Instruction =
  | DeclareGlobalInstruction
  | DeclareSpeakerInstruction
  | SetDefaultSpeakerInstruction
  | EnterScopeInstruction
  | LeaveScopeInstruction
  | DeclareBindingInstruction
  | PrepareReferenceInstruction
  | ValidateAssignmentTargetInstruction
  | AssignInstruction
  | ValidateCallReceiverInstruction
  | EvaluateInstruction
  | JumpIfFalseInstruction
  | JumpInstruction
  | LoopStartInstruction
  | LoopControlInstruction
  | StoreTemporaryInstruction
  | PrepareSaySpeakerInstruction
  | PrepareSayContextualSpeakerInstruction
  | PrepareSayTextInstruction
  | PrepareInteractionSpeakerInstruction
  | ClearTemporaryInstruction
  | ClearTemporariesInstruction
  | CallFunctionInstruction
  | BindSuppliedParameterInstruction
  | BeginFunctionDefaultsInstruction
  | PrepareParameterDefaultInstruction
  | BindDefaultParameterInstruction
  | EnterFunctionBodyInstruction
  | ReturnValueInstruction
  | ReturnVoidInstruction
  | SayInstruction
  | WaitInstruction
  | StartTimerInstruction
  | PacingBarrierInstruction
  | ShowImageInstruction
  | StorageWriteInstruction
  | PlayMediaInstruction
  | InteractionInstruction
  | CaptureInstruction
  | GotoInstruction
  | TransferInstruction
  | SetFallbackInstruction
  | EndInstruction
  | ExitInstruction;

interface InstructionBase {
  readonly span: PlanSourceLocation;
}

/**
 * Sets up a global with its start value before the story runs (ADR 0022 §6). The start values of all files lead the
 * root region of `main.tease`; `file` is the index of the file whose source the locations refer to.
 */
export interface DeclareGlobalInstruction extends InstructionBase {
  readonly kind: "declareGlobal";
  readonly name: string;
  readonly value: ExpressionPlan;
  readonly typeCheck?: TypeCheckPlan;
  readonly file: number;
}

/** Sets up a speaker before the story runs, like {@link DeclareGlobalInstruction}. */
export interface DeclareSpeakerInstruction extends InstructionBase {
  readonly kind: "declareSpeaker";
  readonly name: string;
  readonly properties: readonly PlannedProperty[];
  readonly file: number;
}

export interface SetDefaultSpeakerInstruction extends InstructionBase {
  readonly kind: "setDefaultSpeaker";
  readonly name: string;
}

export interface EnterScopeInstruction extends InstructionBase {
  readonly kind: "enterScope";
}

export interface LeaveScopeInstruction extends InstructionBase {
  readonly kind: "leaveScope";
}

export interface DeclareBindingInstruction extends InstructionBase {
  readonly kind: "declareBinding";
  readonly name: string;
  readonly value: ExpressionPlan;
  readonly typeCheck?: TypeCheckPlan;
}

export interface AssignInstruction extends InstructionBase {
  readonly kind: "assign";
  readonly target: AssignmentTargetPlan;
  /** For `+=` and `-=`, the computed result, which is also what {@link typeCheck} checks. */
  readonly value: ExpressionPlan;
  readonly typeCheck?: TypeCheckPlan;
}

export interface ValidateAssignmentTargetInstruction extends InstructionBase {
  readonly kind: "validateAssignmentTarget";
  readonly target: AssignmentTargetPlan;
}

export interface PrepareReferenceInstruction extends InstructionBase {
  readonly kind: "prepareReference";
  readonly expression: ExpressionPlan;
  readonly destinationTemporary: number;
}

export interface ValidateCallReceiverInstruction extends InstructionBase {
  readonly kind: "validateCallReceiver";
  readonly receiver: ExpressionPlan;
  readonly method: string;
}

export interface EvaluateInstruction extends InstructionBase {
  readonly kind: "evaluate";
  readonly expression: ExpressionPlan;
}

export interface JumpIfFalseInstruction extends InstructionBase {
  readonly kind: "jumpIfFalse";
  readonly condition: ExpressionPlan;
  readonly target: number;
}

export interface JumpInstruction extends InstructionBase {
  readonly kind: "jump";
  readonly target: number;
}

export type LoopStartInstruction =
  | (InstructionBase & {
      readonly kind: "loopStart";
      readonly loopKind: "repeat";
      readonly loopId: number;
      readonly expression: ExpressionPlan;
      readonly continueTarget: number;
      readonly target: number;
    })
  | (InstructionBase & {
      readonly kind: "loopStart";
      readonly loopKind: "for";
      readonly loopId: number;
      readonly variable: string;
      readonly expression: ExpressionPlan;
      readonly continueTarget: number;
      readonly target: number;
    })
  | (InstructionBase & {
      readonly kind: "loopStart";
      readonly loopKind: "while";
      readonly loopId: number;
      readonly expression: ExpressionPlan;
      readonly continueTarget: number;
      readonly target: number;
    });

export interface LoopControlInstruction extends InstructionBase {
  readonly kind: "loopControl";
  readonly action: "break" | "continue";
  readonly loopId: number;
  readonly target: number;
}

export interface StoreTemporaryInstruction extends InstructionBase {
  readonly kind: "storeTemporary";
  readonly temporaryId: number;
  readonly value: ExpressionPlan;
  readonly expectBoolean: boolean;
}

/** Captures the resolved output speaker before later say operands run. */
export interface PrepareSaySpeakerInstruction extends InstructionBase {
  readonly kind: "prepareSaySpeaker";
  readonly speaker: string | null;
  readonly destinationTemporary: number;
}

/** Derives a contextual speaker reference from the captured say output speaker. */
export interface PrepareSayContextualSpeakerInstruction extends InstructionBase {
  readonly kind: "prepareSayContextualSpeaker";
  readonly speakerTemporary: number;
  readonly destinationTemporary: number;
}

/** Captures final visible text, including deterministic list selection. */
export interface PrepareSayTextInstruction extends InstructionBase {
  readonly kind: "prepareSayText";
  readonly value: ExpressionPlan;
  readonly destinationTemporary: number;
}

export interface PrepareInteractionSpeakerInstruction extends InstructionBase {
  readonly kind: "prepareInteractionSpeaker";
  readonly speaker: string | null;
  readonly destinationTemporary: number;
}

export interface ClearTemporaryInstruction extends InstructionBase {
  readonly kind: "clearTemporary";
  readonly temporaryId: number;
}

export interface ClearTemporariesInstruction extends InstructionBase {
  readonly kind: "clearTemporaries";
  readonly temporaryIds: readonly number[];
}

export interface CallArgumentPlan {
  readonly parameterName: string;
  readonly value: ExpressionPlan;
  readonly span: PlanSourceLocation;
  /** Checked after every argument of the call is evaluated, before the function is entered. */
  readonly typeCheck?: TypeCheckPlan;
}

export interface CallFunctionInstruction extends InstructionBase {
  readonly kind: "callFunction";
  readonly functionId: number;
  readonly arguments: readonly CallArgumentPlan[];
  readonly destinationTemporary: number;
  readonly returnInstruction: number;
}

interface FunctionParameterInstructionBase extends InstructionBase {
  readonly functionId: number;
  readonly parameterIndex: number;
}

export interface BindSuppliedParameterInstruction extends FunctionParameterInstructionBase {
  readonly kind: "bindSuppliedParameter";
}

export interface BeginFunctionDefaultsInstruction extends InstructionBase {
  readonly kind: "beginFunctionDefaults";
  readonly functionId: number;
}

export interface PrepareParameterDefaultInstruction extends FunctionParameterInstructionBase {
  readonly kind: "prepareParameterDefault";
  readonly target: number;
}

export interface BindDefaultParameterInstruction extends FunctionParameterInstructionBase {
  readonly kind: "bindDefaultParameter";
  readonly value: ExpressionPlan;
  readonly typeCheck?: TypeCheckPlan;
}

export interface EnterFunctionBodyInstruction extends InstructionBase {
  readonly kind: "enterFunctionBody";
  readonly functionId: number;
}

export interface ReturnValueInstruction extends InstructionBase {
  readonly kind: "returnValue";
  readonly value: ExpressionPlan;
  readonly typeCheck?: TypeCheckPlan;
}

export interface ReturnVoidInstruction extends InstructionBase {
  readonly kind: "returnVoid";
}

export interface SayInstruction extends InstructionBase {
  readonly presentation: ExpressionPlan | null;
  readonly kind: "say";
  readonly speaker: string | null;
  readonly value: ExpressionPlan;
  readonly speakerTemporary?: number;
  readonly contextualSpeakerTemporary?: number;
  readonly textTemporary?: number;
  readonly skipPolicy: "skippable" | "unskippable" | null;
  readonly pacing: ExpressionPlan | "smart" | "instant";
}

export type DurationUnitPlan = "ms" | "s" | "min" | "h";

/** One foreground delay: `wait` or a blocking `timer`. */
export interface WaitInstruction extends InstructionBase {
  readonly kind: "wait";
  /** A `timer` also accepts an integer-second range drawn once, after its operands are evaluated. */
  readonly command: "wait" | "timer";
  readonly duration: ExpressionPlan;
  readonly unit: DurationUnitPlan | null;
  /** Evaluated after the duration when it is an expression; always `"hidden"` for `wait`. */
  readonly display: DelayDisplay | ExpressionPlan;
  /** Evaluated after the duration and display; always `null` for `wait`. */
  readonly label: ExpressionPlan | null;
}

export type DelayDisplay = "hidden" | "visible" | "mystery";

/**
 * Starts one asynchronous timer. Operands are evaluated as duration, display, then label; the compiler
 * materializes them first when source order differs. A range is drawn after every operand is evaluated.
 */
export interface StartTimerInstruction extends InstructionBase {
  readonly kind: "startTimer";
  readonly duration: ExpressionPlan;
  readonly unit: DurationUnitPlan | null;
  readonly display: DelayDisplay | ExpressionPlan;
  readonly label: ExpressionPlan | null;
  readonly repeat: boolean;
  readonly persist: boolean;
  /** A compiled timer-handler region, or `null` when the timer has no expiry block. */
  readonly handlerFunctionId: number | null;
  /** Receives the handle when the timer is used as a value. */
  readonly destinationTemporary: number | null;
}

/**
 * Waits for the previous message's pacing before main-story media presentation. With a `receiver`, it waits only
 * when that side-effect-free expression evaluates to a media handle.
 */
export interface PacingBarrierInstruction extends InstructionBase {
  readonly kind: "pacingBarrier";
  readonly receiver: ExpressionPlan | null;
}

/** `showImage <image>`, or `hideImage` when `image` is `null`. */
export interface ShowImageInstruction extends InstructionBase {
  readonly kind: "showImage";
  readonly image: ExpressionPlan | null;
}

/** `save <value> as <key>`, or `delete <key>` when `value` is `null`; evaluates the value, then the key. */
export interface StorageWriteInstruction extends InstructionBase {
  readonly kind: "storageWrite";
  readonly value: ExpressionPlan | null;
  readonly key: ExpressionPlan;
}

export type MediaRepeatPlan =
  | { readonly kind: "once" }
  | { readonly kind: "indefinite" }
  /** `repeat: <value>`: `true`, `false`, or a duration budget. */
  | { readonly kind: "value"; readonly value: ExpressionPlan }
  | { readonly kind: "times"; readonly count: ExpressionPlan };

/** A timeline cue; a compact block is a `beforeEnd` cue at offset zero. */
export interface MediaCuePlan {
  readonly kind: "at" | "beforeEnd";
  readonly offset: ExpressionPlan;
  readonly functionId: number;
}

/**
 * Starts audio or video playback. Operands are evaluated as file, repeat, startAt, endAt, volume, then cue offsets;
 * the compiler materializes them first when source order differs.
 */
export interface PlayMediaInstruction extends InstructionBase {
  readonly kind: "playMedia";
  readonly media: "audio" | "video";
  readonly async: boolean;
  readonly file: ExpressionPlan;
  readonly repeat: MediaRepeatPlan;
  readonly startAt: ExpressionPlan | null;
  readonly endAt: ExpressionPlan | null;
  readonly volume: ExpressionPlan | null;
  readonly cues: readonly MediaCuePlan[];
  readonly finishFunctionId: number | null;
  /** Receives the handle when async playback is used as a value. */
  readonly destinationTemporary: number | null;
}

export type InteractionKind = "button" | "text" | "number" | "choice" | "temporal";
/**
 * `choice` is the value of the selected choice option; a button used as a value yields a `duration`; `temporal` is the
 * date, time, or date and time the UI asks for.
 */
export type InteractionResultDomain =
  "none" | "string" | "number" | "choice" | "duration" | "temporal";
/** What `askDate`, `askTime`, and `askDateTime` ask for (V30 §20). */
export type InteractionTemporalKind = "date" | "time" | "datetime";
export type InteractionAccessibleName =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "localizedDefault";
      readonly key: "answer" | "number" | "chooseOption" | "continue";
    };
/** A value a choice option can show and return: a scalar, a duration, or a date or time value. */
export type InteractionChoiceValue =
  | string
  | number
  | boolean
  | null
  | StoredDuration
  | ({ readonly kind: "date" } & DateFields)
  | ({ readonly kind: "time" } & TimeFields)
  | ({ readonly kind: "datetime" } & DateTimeFields)
  | { readonly kind: "timestamp"; readonly epochMilliseconds: number };
/** One button. `value` is what `choose` returns for it; `text` is what the button shows. */
export interface InteractionChoiceOption {
  readonly text: string;
  readonly value: InteractionChoiceValue;
  readonly background?: string;
}
export type InteractionUiPayload =
  | {
      readonly kind: "button";
      readonly buttonLabel: string;
      readonly background?: string;
      readonly accessibleName: InteractionAccessibleName;
    }
  | {
      readonly kind: "text";
      readonly hint: string | null;
      /** Answer text that prefills the field; submitting it unchanged answers with the default. */
      readonly prefill?: string;
      readonly accessibleName: InteractionAccessibleName;
    }
  | {
      readonly kind: "number";
      readonly hint: string | null;
      /** Answer text that prefills the field; submitting it unchanged answers with the default. */
      readonly prefill?: string;
      /** `askInteger`: only a whole number is an answer. */
      readonly integer?: true;
      readonly accessibleName: InteractionAccessibleName;
    }
  | {
      readonly kind: "temporal";
      readonly temporalKind: InteractionTemporalKind;
      readonly hint: string | null;
      /** The default answer as ISO text; submitting it unchanged answers with the default. */
      readonly prefill?: string;
      readonly accessibleName: InteractionAccessibleName;
    }
  | {
      readonly kind: "choice";
      readonly options: readonly InteractionChoiceOption[];
      readonly accessibleName: InteractionAccessibleName;
    };

/** An authored choice value before `:`: an identifier is a string, a numeric literal a number. */
export type PreparedInteractionChoiceValue = string | number;
export type PreparedInteractionUiPayload =
  | {
      readonly kind: "button";
      readonly buttonLabelTemporary: number;
      readonly backgroundTemporary?: number;
      /** Holds the evaluated timeout until the button appears; the action keeps it as `timeoutMs`. */
      readonly timeoutTemporary?: number;
      readonly accessibleName: InteractionAccessibleName;
    }
  | {
      readonly kind: "text";
      readonly hintTemporary: number | null;
      /** Holds the evaluated default answer until the field opens, then its prefill text. */
      readonly prefillTemporary?: number;
      readonly accessibleName: InteractionAccessibleName;
    }
  | {
      readonly kind: "number";
      readonly hintTemporary: number | null;
      /** Holds the evaluated default answer until the field opens, then its prefill text. */
      readonly prefillTemporary?: number;
      /** `askInteger`: only a whole number is an answer. */
      readonly integer?: true;
      readonly accessibleName: InteractionAccessibleName;
    }
  | {
      readonly kind: "temporal";
      readonly temporalKind: InteractionTemporalKind;
      readonly hintTemporary: number | null;
      /** Holds the evaluated default answer until the field opens, then its ISO prefill text. */
      readonly prefillTemporary?: number;
      readonly accessibleName: InteractionAccessibleName;
    }
  | {
      readonly kind: "choice";
      /** A list holding the value of each authored option, in source order. */
      readonly optionsTemporary: number;
      /** The authored value of each option, or `null`. Its length is the authored option count. */
      readonly values: readonly (PreparedInteractionChoiceValue | null)[];
      readonly accessibleName: InteractionAccessibleName;
    };

/** Static compiler/Standard-Library foreground interaction. */
export interface StaticInteractionInstruction extends InstructionBase {
  readonly kind: "interaction";
  readonly interactionKind: InteractionKind;
  readonly target: "standardChat";
  readonly speaker: string | null;
  readonly destinationTemporary: number | null;
  readonly expectedResult: InteractionResultDomain;
  readonly ui: InteractionUiPayload;
}

/** Compact-source interaction whose speaker/UI values were prepared before suspension. */
export interface PreparedInteractionInstruction extends InstructionBase {
  readonly kind: "interaction";
  readonly interactionKind: InteractionKind;
  readonly target: "standardChat";
  readonly speakerTemporary: number;
  readonly destinationTemporary: number | null;
  readonly expectedResult: InteractionResultDomain;
  readonly preparedUi: PreparedInteractionUiPayload;
}

export type InteractionInstruction = StaticInteractionInstruction | PreparedInteractionInstruction;

/**
 * `takePhoto()`: waits until the Player answers with a still from the session camera or reports it unavailable. The
 * result is the captured image reference, or `null`; it is always handed off through `destinationTemporary`.
 */
export interface CaptureInstruction extends InstructionBase {
  readonly kind: "capture";
  readonly capture: "photo";
  readonly destinationTemporary: number;
}

export interface ExitInstruction extends InstructionBase {
  readonly kind: "exit";
}

/**
 * `goto label`: leaves the current function, handler, loop, and block, abandons an interrupted action, and continues at
 * `target`, a label of the same file's root region.
 */
export interface GotoInstruction extends InstructionBase {
  readonly kind: "goto";
  readonly target: number;
}

/** A file and where it starts: its entry or one of its labels. */
export interface PlanDestination {
  readonly file: number;
  readonly target: number;
}

/** A glob target: each time it runs, one draw from the session random generator picks one of `pick`. */
export interface PlanPick {
  readonly pick: readonly PlanDestination[];
}

export type PlanTransferDestination = PlanDestination | PlanPick;

/**
 * A computed target, such as `goto (next)`: each time it runs, `value` evaluates to a script reference, which names the
 * destination by path and label.
 */
export interface PlanComputedDestination {
  readonly value: ExpressionPlan;
}

/**
 * `goto` or `call` naming a file, or `call label`: enters `destination` with fresh top-level variables. A `goto`
 * leaves the current file like a `goto label`; a `call` continues after it once that file reaches `end`.
 */
export interface TransferInstruction extends InstructionBase {
  readonly kind: "transfer";
  readonly mode: "goto" | "call";
  readonly destination: PlanTransferDestination | PlanComputedDestination;
}

/**
 * `fallback target` sets where an `end` without a caller continues; `fallback none` clears it with `null`. A computed
 * target is resolved when the statement runs, so the fallback it sets is a file and its entry or label.
 */
export interface SetFallbackInstruction extends InstructionBase {
  readonly kind: "setFallback";
  readonly destination: PlanTransferDestination | PlanComputedDestination | null;
}

/** `end`, and the end the compiler adds after the last statement of a file's root region. */
export interface EndInstruction extends InstructionBase {
  readonly kind: "end";
}

export interface PlannedProperty {
  readonly name: string;
  readonly value: ExpressionPlan;
  readonly span: PlanSourceLocation;
}

export type AssignmentTargetPlan =
  IdentifierExpressionPlan | PropertyExpressionPlan | IndexExpressionPlan;

export type ExpressionPlan =
  | LiteralExpressionPlan
  | DurationExpressionPlan
  | IdentifierExpressionPlan
  | ListExpressionPlan
  | ObjectExpressionPlan
  | SetExpressionPlan
  | DictExpressionPlan
  | GroupExpressionPlan
  | TemplateExpressionPlan
  | PropertyExpressionPlan
  | IndexExpressionPlan
  | CallExpressionPlan
  | UnaryExpressionPlan
  | BinaryExpressionPlan
  | RangeExpressionPlan
  | TemporaryExpressionPlan
  | PreparedReferenceExpressionPlan
  | StorageLoadExpressionPlan
  | TagQueryExpressionPlan
  | TypeTestExpressionPlan;

interface ExpressionPlanBase {
  readonly span: PlanSourceLocation;
}

export interface LiteralExpressionPlan extends ExpressionPlanBase {
  readonly kind: "literal";
  readonly value: string | number | boolean | null;
}

/**
 * A duration literal, already normalized: exact milliseconds, and whole calendar `months` and `days`, present only when
 * they are not zero.
 */
export interface DurationExpressionPlan extends ExpressionPlanBase {
  readonly kind: "duration";
  readonly milliseconds: number;
  readonly months?: number;
  readonly days?: number;
}

export interface IdentifierExpressionPlan extends ExpressionPlanBase {
  readonly kind: "identifier";
  readonly name: string;
}

export interface TemporaryExpressionPlan extends ExpressionPlanBase {
  readonly kind: "temporary";
  readonly temporaryId: number;
}

/** `load <key>[, default: <value>]`: the default is evaluated only when the key is absent. */
export interface StorageLoadExpressionPlan extends ExpressionPlanBase {
  readonly kind: "storageLoad";
  readonly key: ExpressionPlan;
  readonly default: ExpressionPlan | null;
}

/**
 * `showImage tagged …` (one random match) or `findImages(…)` (every match, in catalog order) over the plan's images.
 * The operands are evaluated once, in order, before any image is matched; each `tagCompare` and `tagList` step reads
 * the next one. A random pick draws once from the session random generator.
 */
export interface TagQueryExpressionPlan extends ExpressionPlanBase {
  readonly kind: "tagQuery";
  readonly catalog: "images";
  readonly select: "random" | "list";
  readonly operands: readonly ExpressionPlan[];
  /** The query in postfix order; without steps every image matches. */
  readonly steps: readonly TagQueryStepPlan[];
}

export type TagQueryStepPlan =
  | { readonly kind: "tag"; readonly name: string }
  | {
      readonly kind: "tagCompare";
      readonly name: string;
      readonly operator: "==" | "!=" | "<" | "<=" | ">" | ">=";
    }
  | { readonly kind: "tagList"; readonly option: "all" | "none" | "any" }
  | { readonly kind: "and" | "or" | "not" };

/**
 * A check that a value the compiler cannot know fits the type of the place that receives it (ADR 0021 rule 1.7). It
 * runs after the value is evaluated and before it is stored, and fails with `TSR058`.
 */
export interface TypeCheckPlan {
  readonly type: TypePlan;
  /** The receiving place as the message names it, such as `'count'` or `an element of 'items'`. */
  readonly place: string;
}

/**
 * The checked part of a type. A list, set, or dict with a `null` element accepts any elements or values, and an object
 * checks only the listed properties that the value has; the parts the compiler does not know are left out.
 */
export type TypePlan =
  | { readonly kind: TypePlanName }
  | { readonly kind: "list" | "set" | "dict"; readonly element: TypePlan | null }
  | { readonly kind: "object"; readonly properties: readonly TypePropertyPlan[] }
  | { readonly kind: "union"; readonly members: readonly TypePlan[] };

export type TypePlanName =
  | "string"
  | "boolean"
  | "integer"
  | "number"
  | "duration"
  | "date"
  | "time"
  | "datetime"
  | "timestamp"
  | "never"
  | "null"
  | "range"
  | "speaker"
  | "timer"
  | "media"
  | "script";

export interface TypePropertyPlan {
  readonly name: string;
  readonly type: TypePlan;
}

export interface PreparedReferenceExpressionPlan extends ExpressionPlanBase {
  readonly kind: "preparedReference";
  readonly temporaryId: number;
}

export interface ListExpressionPlan extends ExpressionPlanBase {
  readonly kind: "list";
  readonly elements: readonly ExpressionPlan[];
}

export interface ObjectExpressionPlan extends ExpressionPlanBase {
  readonly kind: "object";
  readonly properties: readonly PlannedProperty[];
}

export interface SetExpressionPlan extends ExpressionPlanBase {
  readonly kind: "set";
  readonly elements: readonly ExpressionPlan[];
}

/** `dict{ ... }`: each entry's key, which must be text, is evaluated before its value, in source order. */
export interface DictExpressionPlan extends ExpressionPlanBase {
  readonly kind: "dict";
  readonly entries: readonly DictEntryPlan[];
}

export interface DictEntryPlan {
  readonly key: ExpressionPlan;
  readonly value: ExpressionPlan;
  readonly span: PlanSourceLocation;
}

export interface GroupExpressionPlan extends ExpressionPlanBase {
  readonly kind: "group";
  readonly expression: ExpressionPlan;
}

export type TemplatePartPlan =
  | { readonly kind: "text"; readonly value: string; readonly span: PlanSourceLocation }
  | {
      readonly kind: "expression";
      readonly expression: ExpressionPlan;
      readonly span: PlanSourceLocation;
    };

export interface TemplateExpressionPlan extends ExpressionPlanBase {
  readonly kind: "template";
  readonly parts: readonly TemplatePartPlan[];
}

export interface PropertyExpressionPlan extends ExpressionPlanBase {
  readonly kind: "property";
  readonly object: ExpressionPlan;
  readonly name: string;
}

export interface IndexExpressionPlan extends ExpressionPlanBase {
  readonly kind: "index";
  readonly object: ExpressionPlan;
  readonly index: ExpressionPlan;
}

export type ArgumentPlan =
  | {
      readonly kind: "positional";
      readonly value: ExpressionPlan;
      readonly span: PlanSourceLocation;
    }
  | {
      readonly kind: "named";
      readonly name: string;
      readonly value: ExpressionPlan;
      readonly span: PlanSourceLocation;
    };

export interface CallExpressionPlan extends ExpressionPlanBase {
  readonly kind: "call";
  readonly callee: ExpressionPlan;
  readonly arguments: readonly ArgumentPlan[];
  /** For a list or set `add`, the check of the added element; for a dict `get`, the check of its `default:`. */
  readonly typeCheck?: TypeCheckPlan;
}

/** `value is T` or `value is not T`: whether the value fits the type, by the matcher of the runtime type checks. */
export interface TypeTestExpressionPlan extends ExpressionPlanBase {
  readonly kind: "typeTest";
  readonly value: ExpressionPlan;
  readonly type: TypePlan;
  readonly negated: boolean;
}

export interface UnaryExpressionPlan extends ExpressionPlanBase {
  readonly kind: "unary";
  readonly operator: "+" | "-" | "not";
  readonly operand: ExpressionPlan;
}

/** `in` tests whether the left value is a number within the right range; only `switch` range cases compile to it. */
export interface BinaryExpressionPlan extends ExpressionPlanBase {
  readonly kind: "binary";
  readonly operator:
    "*" | "/" | "%" | "+" | "-" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or" | "in";
  readonly left: ExpressionPlan;
  readonly right: ExpressionPlan;
}

export interface RangeExpressionPlan extends ExpressionPlanBase {
  readonly kind: "range";
  readonly start: ExpressionPlan;
  readonly end: ExpressionPlan;
  readonly inclusive: boolean;
}

/** The span of `main.tease`: the location of a plan-level fact that belongs to no single instruction. */
export function mainSourceSpan(plan: Pick<InstructionPlan, "files">): PlanSourceLocation {
  return plan.files[0]!.sourceSpan;
}

/** The globals and speakers that the start of `main.tease` sets up, in order (ADR 0022 §6). */
export function startupDeclarations(plan: {
  readonly instructions: readonly (Instruction | undefined)[];
}): readonly (DeclareGlobalInstruction | DeclareSpeakerInstruction)[] {
  const declarations: (DeclareGlobalInstruction | DeclareSpeakerInstruction)[] = [];
  for (const instruction of plan.instructions) {
    if (instruction?.kind !== "declareGlobal" && instruction?.kind !== "declareSpeaker") break;
    declarations.push(instruction);
  }
  return declarations;
}

/**
 * The project file whose source the location of an instruction is in: the file whose block holds it, or for a start
 * value the file it comes from.
 */
export function instructionSourcePath(
  plan: Pick<InstructionPlan, "files"> & {
    readonly instructions: readonly (Instruction | undefined)[];
  },
  index: number,
): string {
  const instruction = plan.instructions[index];
  if (instruction?.kind === "declareGlobal" || instruction?.kind === "declareSpeaker")
    return plan.files[instruction.file]!.path;
  return (
    plan.files.find((file) => index >= file.startInstruction && index < file.endInstruction) ??
    plan.files[0]!
  ).path;
}
