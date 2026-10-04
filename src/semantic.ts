import { normalizeOpaqueColor } from "./color.js";
import {
  presentationPropertyDiagnostics,
  messageColorDiagnostics,
} from "./authored-presentation.js";
import type {
  AssignmentTarget,
  Block,
  CallArgument,
  DurationUnit,
  Identifier,
  InteractionChoiceOption,
  ShowButtonParts,
  TimerParts,
  Expression,
  MediaParts,
  FunctionDeclaration,
  Program,
  Statement,
} from "./ast.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import type { SourceSpan } from "./source.js";
import {
  CORE_RUNTIME_BUILTINS,
  PLATFORM_STANDARD_LIBRARY_PRELUDE,
  TEASESCRIPT_PROTECTED_NAMES,
} from "./protected-names.js";
import {
  findVisibleOverflows,
  staticChoiceValue,
  staticNumber,
  staticQuantity,
  staticVisibleText,
} from "./static-evaluation.js";
import { runCompileTask, compileChild, type CompileTask } from "./compiler/continuation.js";
import {
  expressionChildren,
  mediaHandlerBlocks,
  mediaOperands,
  showButtonOptions,
} from "./expression-children.js";
import {
  DURATION_UNIT_MILLISECONDS,
  durationLiteralParts,
  durationParts,
  isExactDuration,
} from "./duration.js";
import { validateSwitchCases } from "./switch-cases.js";

export interface SemanticValidationOptions {
  readonly globals?: readonly string[];
  readonly builtins?: readonly string[];
}

export interface SemanticValidationResult {
  readonly diagnostics: readonly Diagnostic[];
}

type BindingKind = "variable" | "speaker" | "global" | "function";

interface Binding {
  readonly kind: BindingKind;
  /** Set while a variable statically holds an async timer or media handle. */
  handle?: "timer" | "media" | null;
}

const TIMER_HANDLE_PROPERTIES: ReadonlySet<string> = new Set([
  "remaining",
  "elapsed",
  "display",
  "label",
  "state",
  "repeatDuration",
]);
const TIMER_HANDLE_ASSIGNABLE: ReadonlySet<string> = new Set([
  "remaining",
  "display",
  "repeatDuration",
]);
const TIMER_HANDLE_METHODS: ReadonlySet<string> = new Set(["pause", "resume", "stop"]);
const TIMER_DISPLAYS: ReadonlySet<string> = new Set(["visible", "mystery", "hidden"]);
const MEDIA_HANDLE_PROPERTIES: ReadonlySet<string> = new Set([
  "position",
  "elapsed",
  "remaining",
  "duration",
  "volume",
  "state",
]);
const MEDIA_HANDLE_ASSIGNABLE: ReadonlySet<string> = new Set(["position", "remaining", "volume"]);

const semanticCode = {
  duplicateDeclaration: "TSV001",
  unknownVariable: "TSV002",
  unknownAssignment: "TSV003",
  invalidAssignment: "TSV004",
  unknownSpeaker: "TSV005",
  duplicateProperty: "TSV007",
  invalidLoopControl: "TSV008",
  chainedRange: "TSV009",
  invalidRangeOperand: "TSV010",
  invalidRepeatCount: "TSV011",
  invalidLoopSource: "TSV012",
  duplicateFunction: "TSV013",
  duplicateParameter: "TSV014",
  requiredAfterDefault: "TSV015",
  nestedFunction: "TSV016",
  returnOutsideFunction: "TSV017",
  unknownFunction: "TSV018",
  nonCallable: "TSV019",
  argumentCount: "TSV020",
  unknownNamedArgument: "TSV022",
  duplicateNamedArgument: "TSV023",
  missingNamedArgument: "TSV024",
  laterParameterDefault: "TSV025",
  functionAssignment: "TSV026",
  functionValue: "TSV028",
  invalidInteractionChoice: "TSV029",
  unsupportedBlockingContext: "TSV032",
  invalidTimer: "TSV033",
  invalidTimerHandleMember: "TSV034",
  mixedDurationOperands: "TSV035",
  invalidMedia: "TSV036",
  invalidMediaHandleMember: "TSV037",
  invalidStorageKey: "TSV038",
  invalidListIndex: "TSV045",
  visibleOverflow: "TSV050",
  invalidLabel: "TSV051",
  skippedInitialization: "TSV054",
} as const;

/** Where code runs, for the initialization check: a top-level statement, a function, or a handler and its origin. */
type FlowContext =
  | { readonly kind: "root"; readonly statement: number }
  | { readonly kind: "function"; readonly name: string }
  | { readonly kind: "handler"; readonly origin: FlowContext }
  /** Code that never runs, such as a block created after a transfer. */
  | { readonly kind: "never" };

const OVERFLOW_MESSAGES = {
  zero: "This divides by zero, so it has no result. Divide by a value other than zero.",
  number: "This calculation gives a number too large to represent. Use smaller values.",
  duration: "This calculation gives a duration too long to represent. Use a shorter duration.",
} as const;

export function validateSemantics(
  program: Program,
  options: SemanticValidationOptions = {},
): SemanticValidationResult {
  const validator = new SemanticValidator(options);
  validator.validate(program);
  return Object.freeze({ diagnostics: Object.freeze([...validator.diagnostics]) });
}

class SemanticScope {
  readonly bindings = new Map<string, Binding>();

  public constructor(readonly parent: SemanticScope | null = null) {}

  public resolve(name: string): Binding | undefined {
    let scope: SemanticScope | null = this;
    while (scope !== null) {
      const binding = scope.bindings.get(name);
      if (binding !== undefined) return binding;
      scope = scope.parent;
    }
    return undefined;
  }

  public declare(name: string, binding: Binding): boolean {
    if (this.resolve(name) !== undefined) return false;
    this.bindings.set(name, binding);
    return true;
  }
}

class SemanticValidator {
  readonly diagnostics: Diagnostic[] = [];

  readonly #builtins: ReadonlySet<string>;

  readonly #protectedNames: ReadonlySet<string>;

  readonly #root = new SemanticScope();

  readonly #functions = new Map<string, FunctionDeclaration>();

  readonly #invalidConfiguredNames: readonly string[];

  #functionDepth = 0;

  /**
   * Timer expiry blocks and media cue blocks are validated after all top-level names are known, like function bodies.
   * A media block may bind the handle of its own `let` declaration.
   */
  readonly #pendingHandlers: {
    readonly block: Block;
    readonly owner: "timer" | "media";
    readonly selfHandle: string | null;
    readonly origin: FlowContext;
  }[] = [];

  #context: FlowContext = { kind: "root", statement: 0 };

  /** Reads and writes of top-level variables, with where they run. */
  readonly #rootAccesses: {
    readonly name: string;
    readonly span: SourceSpan;
    readonly context: FlowContext;
  }[] = [];

  /** Set while checking statements that follow a transfer in their block, which never run. */
  #unreachable = false;

  readonly #gotos: { readonly label: string; readonly context: FlowContext }[] = [];

  readonly #calls: { readonly name: string; readonly context: FlowContext }[] = [];

  public constructor(options: SemanticValidationOptions) {
    this.#invalidConfiguredNames = Object.freeze(
      [...(options.globals ?? []), ...(options.builtins ?? [])].filter((name) =>
        [
          "showButton",
          "askText",
          "askNumber",
          "askInteger",
          "askDate",
          "askTime",
          "askDateTime",
          "choose",
        ].includes(name),
      ),
    );
    this.#builtins = new Set([
      ...CORE_RUNTIME_BUILTINS,
      ...PLATFORM_STANDARD_LIBRARY_PRELUDE,
      ...(options.builtins ?? []),
    ]);
    this.#protectedNames = new Set([...TEASESCRIPT_PROTECTED_NAMES, ...(options.builtins ?? [])]);
    for (const name of options.globals ?? []) {
      this.#root.declare(name, { kind: "global" });
    }
  }

  public validate(program: Program): void {
    for (const name of new Set(this.#invalidConfiguredNames)) {
      this.#report(
        semanticCode.duplicateDeclaration,
        `Configured name '${name}' conflicts with a protected TeaseScript name.`,
        program.span,
      );
    }
    for (const statement of program.statements) {
      if (statement.kind !== "functionDeclaration") continue;
      if (this.#functions.has(statement.name.name)) {
        this.#report(
          semanticCode.duplicateFunction,
          `Duplicate function declaration '${statement.name.name}'.`,
          statement.name.span,
        );
        continue;
      }
      if (this.#declare(statement.name.name, "function", statement.name.span, this.#root)) {
        this.#functions.set(statement.name.name, statement);
      }
    }
    for (const statement of program.statements) {
      if (statement.kind !== "labelStatement") continue;
      const name = statement.name.name;
      if (this.#protectedNames.has(name)) {
        this.#report(
          semanticCode.duplicateDeclaration,
          `Label '${name}' conflicts with a protected TeaseScript name. Choose another name, such as '${name}Label'.`,
          statement.name.span,
        );
      } else if (this.#labels.has(name)) {
        this.#report(
          semanticCode.invalidLabel,
          `This file already has a label '${name}'. Give each label in a file its own name.`,
          statement.name.span,
        );
      } else {
        this.#labels.add(name);
      }
    }
    program.statements.forEach((statement, index) => {
      if (statement.kind !== "functionDeclaration") {
        this.#context = { kind: "root", statement: index };
        runCompileTask(this.#validateStatement(statement, this.#root, 0));
      }
    });
    for (const statement of program.statements) {
      if (
        statement.kind === "functionDeclaration" &&
        this.#functions.get(statement.name.name) === statement
      ) {
        this.#context = { kind: "function", name: statement.name.name };
        this.#validateFunction(statement);
      }
    }
    for (let index = 0; index < this.#pendingHandlers.length; index += 1) {
      this.#context = { kind: "handler", origin: this.#pendingHandlers[index]!.origin };
      this.#validateHandler(this.#pendingHandlers[index]!);
    }
    if (this.#gotos.length > 0) this.#checkInitializationAtLabels(program);
    for (const overflow of findVisibleOverflows(program))
      this.#report(semanticCode.visibleOverflow, OVERFLOW_MESSAGES[overflow.cause], overflow.span);
  }

  /**
   * A handler block sees top-level names and its own locals, like a function body without parameters. A media block's
   * self-handle is a local of the handler scope, so it shadows any outer name of the same spelling.
   */
  #validateHandler(handler: {
    readonly block: Block;
    readonly owner: "timer" | "media";
    readonly selfHandle: string | null;
  }): void {
    this.#functionDepth += 1;
    this.#handlerDepth += 1;
    this.#handlerOwner = handler.owner;
    try {
      const scope = new SemanticScope(this.#root);
      if (handler.selfHandle !== null) {
        scope.bindings.set(handler.selfHandle, { kind: "variable", handle: "media" });
      }
      runCompileTask(this.#validateStatements(handler.block.statements, scope, 0));
    } finally {
      this.#functionDepth -= 1;
      this.#handlerDepth -= 1;
    }
  }

  #handlerDepth = 0;

  /** The labels of the file, which stand only in its outer scope. */
  readonly #labels = new Set<string>();

  #handlerOwner: "timer" | "media" = "timer";

  #validateTimer(timer: TimerParts, scope: SemanticScope, valuePosition: boolean): void {
    if (typeof timer.display === "object" && timer.display !== null) {
      this.#validateExpression(timer.display, scope, null);
      const display = staticVisibleText(timer.display);
      if (
        (display !== undefined && !TIMER_DISPLAYS.has(display)) ||
        isDefinitelyNonText(timer.display)
      ) {
        this.#report(
          semanticCode.invalidTimer,
          'Timer display must be "visible", "mystery", or "hidden".',
          timer.display.span,
        );
      }
    }
    this.#validateExpression(timer.duration, scope, null);
    if (timer.label !== null) this.#validateExpression(timer.label, scope, null);
    if (!timer.async) {
      const invalid = timer.handler ?? (timer.repeat || timer.persist ? timer : null);
      if (invalid !== null) {
        this.#report(
          semanticCode.invalidTimer,
          "Only an async timer may have an expiry block, repeat, or persist.",
          invalid.span,
        );
      }
      if (valuePosition) {
        this.#report(
          semanticCode.invalidTimer,
          "A blocking timer returns no handle; use 'timer async ...' to keep one.",
          timer.span,
        );
      }
    }
    const duration = unwrapParentheses(timer.duration);
    if (timer.unit !== null && duration.kind === "durationLiteral") {
      this.#report(
        semanticCode.invalidTimer,
        "This duration already has a unit.",
        timer.duration.span,
      );
    }
    if (duration.kind === "rangeExpression") {
      const start = staticNumber(duration.start);
      const end = staticNumber(duration.end);
      if (timer.unit !== null && timer.unit !== "s") {
        this.#report(
          semanticCode.invalidRangeOperand,
          "A timer range counts whole seconds; other units are not supported for ranges yet.",
          timer.duration.span,
        );
      } else if (!isKnownInteger(duration.start) || !isKnownInteger(duration.end)) {
        this.#report(
          semanticCode.invalidRangeOperand,
          "A statically known timer range must have integer second bounds.",
          duration.span,
        );
      } else if (start !== undefined && start < (timer.repeat ? 1 : 0)) {
        this.#report(
          semanticCode.invalidRangeOperand,
          timer.repeat
            ? "A repeating timer range must start at one second or more."
            : "A timer range must not start below zero seconds.",
          duration.span,
        );
      } else if (
        start !== undefined &&
        end !== undefined &&
        (duration.inclusive ? end < start : end <= start)
      ) {
        this.#report(
          semanticCode.invalidRangeOperand,
          "A timer range must contain at least one whole second.",
          duration.span,
        );
      } else if (
        start !== undefined &&
        !(start * DURATION_UNIT_MILLISECONDS.s <= Number.MAX_SAFE_INTEGER)
      ) {
        // Every draw is at least the lower bound.
        this.#report(
          semanticCode.invalidRepeatCount,
          "This timer is too long for scene time to reach. Use a shorter duration.",
          duration.span,
        );
      }
    } else {
      const known =
        duration.kind === "durationLiteral" ? duration.amount.value : staticNumber(duration);
      if (known !== undefined && (known < 0 || (timer.repeat && known === 0))) {
        this.#report(
          semanticCode.invalidRepeatCount,
          timer.repeat
            ? "A repeating timer duration must be greater than zero."
            : "Timer duration must not be negative.",
          timer.duration.span,
        );
      } else if (beyondSceneTime(timer.duration, timer.unit)) {
        this.#report(
          semanticCode.invalidRepeatCount,
          "This timer is too long for scene time to reach. Use a shorter duration.",
          timer.duration.span,
        );
      }
    }
    if (timer.handler !== null)
      this.#pendingHandlers.push({
        block: timer.handler,
        owner: "timer",
        selfHandle: null,
        origin: this.#unreachable ? { kind: "never" } : this.#context,
      });
  }

  /** Static checks of a play command; runtime validates the values that are not literals. */
  *#validateMediaTask(
    media: MediaParts,
    scope: SemanticScope,
    valuePosition: boolean,
    selfHandle: string | null,
  ): CompileTask<void> {
    const command = media.media === "audio" ? "playAudio" : "playVideo";
    for (const operand of mediaOperands(media)) {
      yield* compileChild(this.#validateExpressionTask(operand, scope, null));
    }
    if (isDefinitelyNonFileReference(media.file)) {
      this.#report(
        semanticCode.invalidMedia,
        `${command} needs a media file reference or null.`,
        media.file.span,
      );
    }
    if (!media.async && valuePosition) {
      this.#report(
        semanticCode.invalidMedia,
        `Blocking media returns no handle; use '${command} async ...' to keep one.`,
        media.span,
      );
    }
    const repeat = media.repeat;
    if (
      repeat?.kind === "indefinite" ||
      (repeat?.kind === "value" && isTrueLiteral(repeat.value))
    ) {
      if (!media.async) {
        this.#report(
          semanticCode.invalidMedia,
          `Blocking media cannot repeat indefinitely; use '${command} async', a count such as 'repeat: 3 times', or a duration such as 'repeat: 60 s'.`,
          repeat.span,
        );
      }
    } else if (repeat?.kind === "value") {
      const kind = literalKind(repeat.value);
      if (kind === "numberLiteral") {
        this.#report(
          semanticCode.invalidMedia,
          "Write a repeat count with 'times', such as 'repeat: 3 times', or a duration such as 'repeat: 60 s'.",
          repeat.value.span,
        );
      } else if (kind === "durationLiteral") {
        // A calendar duration has no fixed length; the type check reports it as such (V30 §35).
        const milliseconds = staticDurationMs(repeat.value);
        if (milliseconds !== undefined && !(milliseconds > 0)) {
          this.#report(
            semanticCode.invalidMedia,
            "A repeat duration must be greater than zero.",
            repeat.value.span,
          );
        }
      } else if (kind !== "booleanLiteral" && isDefinitelyNonDuration(repeat.value)) {
        this.#report(
          semanticCode.invalidMedia,
          "Repeat must be true, false, a count such as '3 times', or a duration such as '60 s'.",
          repeat.value.span,
        );
      }
    } else if (repeat?.kind === "times") {
      const count = staticNumber(repeat.count);
      if (
        (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) ||
        isDefinitelyNonNumeric(repeat.count)
      ) {
        this.#report(
          semanticCode.invalidMedia,
          "A repeat count must be a whole number of at least 1, such as '3 times'.",
          repeat.count.span,
        );
      }
    }
    const startMs = this.#validateMediaPosition(media.startAt, "startAt");
    const endMs = this.#validateMediaPosition(media.endAt, "endAt");
    // An omitted startAt is the start of the file.
    const effectiveStartMs = media.startAt === null ? 0 : startMs;
    if (effectiveStartMs !== undefined && endMs !== undefined && endMs <= effectiveStartMs) {
      this.#report(
        semanticCode.invalidMedia,
        "endAt must be later than startAt.",
        media.endAt!.span,
      );
    }
    if (media.volume !== null) {
      const volume = staticNumber(media.volume);
      if (
        (volume !== undefined && !(volume >= 0 && volume <= 1)) ||
        isDefinitelyNonNumeric(media.volume)
      ) {
        this.#report(
          semanticCode.invalidMedia,
          "Volume must be a number from 0 through 1.",
          media.volume.span,
        );
      }
    }
    if (media.handlers?.kind === "cues") {
      let finishes = 0;
      for (const cue of media.handlers.cues) {
        if (cue.kind === "finish") {
          finishes += 1;
          if (finishes > 1) {
            this.#report(
              semanticCode.invalidMedia,
              "A media block may declare 'finish' only once.",
              cue.keywordSpan,
            );
          }
          if (media.repeat?.kind === "indefinite" || isIndefiniteRepeatValue(media.repeat)) {
            this.#report(
              semanticCode.invalidMedia,
              "'finish' never runs for media that repeats indefinitely; stop() does not run it.",
              cue.keywordSpan,
            );
          }
          continue;
        }
        this.#validateMediaPosition(cue.offset, cue.kind);
      }
    }
    for (const block of mediaHandlerBlocks(media)) {
      this.#pendingHandlers.push({
        block,
        owner: "media",
        selfHandle: media.async ? selfHandle : null,
        origin: this.#unreachable ? { kind: "never" } : this.#context,
      });
    }
  }

  /**
   * A media position is a duration or a number of seconds that is not negative. Returns its static value in
   * milliseconds when known.
   */
  #validateMediaPosition(expression: Expression | null, name: string): number | undefined {
    if (expression === null) return undefined;
    const known = staticDurationMs(expression);
    if (known !== undefined && known < 0) {
      this.#report(semanticCode.invalidMedia, `${name} must not be negative.`, expression.span);
    } else if (
      known === undefined &&
      literalKind(expression) !== "durationLiteral" &&
      isDefinitelyNonNumeric(expression)
    ) {
      this.#report(
        semanticCode.invalidMedia,
        `${name} must be a duration such as '30 s' or a number of seconds.`,
        expression.span,
      );
    }
    return known;
  }

  /** Rejects unknown members of a variable that statically holds an async timer handle. */
  #validateTimerHandleMember(
    object: Expression,
    name: Identifier,
    scope: SemanticScope,
    use: "read" | "assign" | "call",
    value?: Expression,
    callArguments?: readonly CallArgument[],
    compound = false,
  ): void {
    object = unwrapParentheses(object);
    if (object.kind !== "identifier") return;
    const handle = scope.resolve(object.name)?.handle;
    if (handle === "media") {
      this.#validateMediaHandleMember(name, use, value, callArguments, compound);
      return;
    }
    if (handle !== "timer") return;
    // Timer compound assignments keep their runtime operand check.
    if (compound) value = undefined;
    const known =
      use === "call"
        ? TIMER_HANDLE_METHODS
        : use === "assign"
          ? TIMER_HANDLE_ASSIGNABLE
          : TIMER_HANDLE_PROPERTIES;
    if (known.has(name.name)) {
      const invalidOperand =
        use === "call"
          ? callArguments !== undefined && callArguments.length > 0
            ? `Timer ${name.name}() takes no arguments.`
            : null
          : use === "assign" && value !== undefined
            ? invalidTimerAssignment(name.name, value)
            : null;
      if (invalidOperand !== null) {
        this.#report(semanticCode.invalidTimerHandleMember, invalidOperand, name.span);
      }
      return;
    }
    this.#report(
      semanticCode.invalidTimerHandleMember,
      use === "call"
        ? `Timer handles have no method '${name.name}'; use pause(), resume(), or stop().`
        : use === "assign"
          ? `Timer handle property '${name.name}' cannot be assigned; assign remaining, display, or repeatDuration.`
          : `Timer handles have no property '${name.name}'.`,
      name.span,
    );
  }

  #validateMediaHandleMember(
    name: Identifier,
    use: "read" | "assign" | "call",
    value?: Expression,
    callArguments?: readonly CallArgument[],
    compound = false,
  ): void {
    const known =
      use === "call"
        ? TIMER_HANDLE_METHODS
        : use === "assign"
          ? MEDIA_HANDLE_ASSIGNABLE
          : MEDIA_HANDLE_PROPERTIES;
    if (!known.has(name.name)) {
      this.#report(
        semanticCode.invalidMediaHandleMember,
        use === "call"
          ? `Media handles have no method '${name.name}'; use pause(), resume(), or stop().`
          : use === "assign"
            ? `Media handle property '${name.name}' cannot be assigned; assign position, remaining, or volume.`
            : `Media handles have no property '${name.name}'.`,
        name.span,
      );
      return;
    }
    if (use === "call" && callArguments !== undefined && callArguments.length > 0) {
      this.#report(
        semanticCode.invalidMediaHandleMember,
        `Media ${name.name}() takes no arguments.`,
        name.span,
      );
    } else if (use === "assign" && value !== undefined) {
      // A compound volume operand is a change, so only its type is known statically.
      const invalid =
        name.name === "volume"
          ? isDefinitelyNonNumeric(value) ||
            (!compound &&
              staticNumber(value) !== undefined &&
              !(staticNumber(value)! >= 0 && staticNumber(value)! <= 1))
          : literalKind(value) !== "durationLiteral" && isDefinitelyNonDuration(value);
      if (invalid) {
        this.#report(
          semanticCode.invalidMediaHandleMember,
          name.name === "volume"
            ? "Media volume must be a number from 0 through 1."
            : `Media ${name.name} must be assigned a duration such as 10 s.`,
          name.span,
        );
      }
    }
  }

  *#validateStatements(
    statements: readonly Statement[],
    scope: SemanticScope,
    loopDepth: number,
  ): CompileTask<void> {
    const unreachable = this.#unreachable;
    for (const statement of statements) {
      yield* compileChild(this.#validateStatement(statement, scope, loopDepth));
      // Later statements of this block never run; a label in the outer scope is reached by a goto again.
      if (
        endsInTransfer(statement) ||
        statement.kind === "breakStatement" ||
        statement.kind === "continueStatement"
      )
        this.#unreachable = true;
      else if (statement.kind === "labelStatement") this.#unreachable = unreachable;
    }
    this.#unreachable = unreachable;
  }

  *#validateStatement(
    statement: Statement,
    scope: SemanticScope,
    loopDepth: number,
  ): CompileTask<void> {
    switch (statement.kind) {
      case "letStatement": {
        const initializer = unwrapParentheses(statement.initializer);
        if (initializer.kind === "playMediaExpression") {
          yield* compileChild(
            this.#validateMediaTask(initializer, scope, true, statement.name.name),
          );
        } else {
          this.#validateExpression(statement.initializer, scope, null);
        }
        if (this.#declare(statement.name.name, "variable", statement.name.span, scope)) {
          scope.bindings.get(statement.name.name)!.handle = handleKind(statement.initializer);
        }
        return;
      }
      case "speakerDeclaration": {
        const declared = this.#declare(statement.name.name, "speaker", statement.name.span, scope);
        const names = new Set<string>();
        for (const property of statement.properties) {
          if (names.has(property.name.name)) {
            this.#report(
              semanticCode.duplicateProperty,
              `Duplicate speaker property '${property.name.name}'.`,
              property.name.span,
            );
          }
          names.add(property.name.name);
          if (["presentation", "color", "bubble", "prose"].includes(property.name.name))
            this.diagnostics.push(
              ...presentationPropertyDiagnostics(property.name.name, property.value),
            );
          this.#validateExpression(property.value, scope, declared ? statement.name.name : null);
        }
        return;
      }
      case "speakerSetterStatement":
        this.#validateSpeakerReference(statement.speaker.name, statement.speaker.span, scope);
        return;
      case "sayStatement": {
        const contextualSpeaker =
          statement.speaker === null
            ? "speaker"
            : this.#validateSpeakerReference(statement.speaker.name, statement.speaker.span, scope)
              ? statement.speaker.name
              : null;
        if (statement.presentation !== null) {
          this.#validateExpression(statement.presentation, scope, contextualSpeaker);
          for (const property of statement.presentation.properties)
            this.diagnostics.push(
              ...presentationPropertyDiagnostics(property.name.name, property.value),
            );
        }
        this.diagnostics.push(...messageColorDiagnostics(statement.value));
        this.#validateExpression(statement.value, scope, contextualSpeaker);
        if (statement.pacing !== null && statement.pacing !== "instant") {
          this.#validateExpression(statement.pacing, scope, contextualSpeaker);
          const known = staticNumber(statement.pacing);
          if (known !== undefined && known < 0) {
            this.#report(
              semanticCode.invalidRepeatCount,
              "Say pacing must not be negative.",
              statement.pacing.span,
            );
          }
        }
        return;
      }
      case "showButtonStatement":
        yield* compileChild(this.#validateShowButtonTask(statement, scope));
        return;
      case "waitStatement": {
        this.#validateExpression(statement.duration, scope, null);
        if (
          statement.unit !== null &&
          unwrapParentheses(statement.duration).kind === "durationLiteral"
        ) {
          this.#report(
            semanticCode.invalidTimer,
            "This duration already has a unit.",
            statement.duration.span,
          );
        }
        const known = staticNumber(statement.duration);
        if (known !== undefined && known < 0) {
          this.#report(
            semanticCode.invalidRepeatCount,
            "Wait duration must not be negative.",
            statement.duration.span,
          );
        } else if (beyondSceneTime(statement.duration, statement.unit)) {
          this.#report(
            semanticCode.invalidRepeatCount,
            "This wait is too long for scene time to reach. Use a shorter duration.",
            statement.duration.span,
          );
        }
        return;
      }
      case "timerStatement":
        this.#validateTimer(statement, scope, false);
        return;
      case "playMediaStatement":
        yield* compileChild(this.#validateMediaTask(statement, scope, false, null));
        return;
      case "showImageStatement": {
        this.#validateExpression(statement.image, scope, null);
        if (isDefinitelyNonFileReference(statement.image)) {
          this.#report(
            semanticCode.invalidMedia,
            "showImage needs an image file reference or null.",
            statement.image.span,
          );
        }
        return;
      }
      case "hideImageStatement":
        return;
      case "saveStatement":
        this.#validateExpression(statement.value, scope, null);
        this.#validateStorageKey(statement.key, scope, "Storage key must be a string.");
        return;
      case "deleteStatement":
        this.#validateStorageKey(statement.key, scope, "Storage key must be a string.");
        return;
      case "assignmentStatement":
        this.#validateAssignmentTarget(statement.target, scope);
        this.#validateExpression(statement.value, scope, null);
        if (statement.target.kind === "identifier") {
          const binding = scope.resolve(statement.target.name);
          // Reassignment may happen on any path, so the variable is no longer known to hold a handle.
          if (binding?.kind === "variable") binding.handle = null;
        } else if (statement.target.kind === "propertyAccessExpression") {
          this.#validateTimerHandleMember(
            statement.target.object,
            statement.target.property,
            scope,
            "assign",
            statement.value,
            undefined,
            statement.operator !== "=",
          );
        }
        return;
      case "expressionStatement":
        this.#validateExpression(statement.expression, scope, null);
        return;
      case "ifStatement":
        this.#validateExpression(statement.condition, scope, null);
        yield* compileChild(this.#validateBlock(statement.thenBlock, scope, loopDepth));
        if (statement.elseBlock !== null) {
          if (statement.elseBlock.kind === "ifStatement") {
            yield* compileChild(this.#validateStatement(statement.elseBlock, scope, loopDepth));
          } else {
            yield* compileChild(this.#validateBlock(statement.elseBlock, scope, loopDepth));
          }
        }
        return;
      case "switchStatement":
        this.#validateExpression(statement.subject, scope, null);
        validateSwitchCases(
          statement,
          (name) => scope.resolve(name)?.kind === "speaker",
          (code, message, span) => this.#report(code, message, span),
        );
        for (const switchCase of statement.cases) {
          yield* compileChild(this.#validateBlock(switchCase.body, scope, loopDepth));
        }
        if (statement.defaultBlock !== null) {
          yield* compileChild(this.#validateBlock(statement.defaultBlock, scope, loopDepth));
        }
        return;
      case "repeatStatement":
        this.#validateExpression(statement.count, scope, null);
        const knownCount = staticNumber(statement.count);
        if (knownCount !== undefined && (!Number.isInteger(knownCount) || knownCount < 0)) {
          this.#report(
            semanticCode.invalidRepeatCount,
            "A statically known repeat count must be a non-negative integer.",
            statement.count.span,
          );
        } else if (isDefinitelyNonNumeric(statement.count)) {
          this.#report(
            semanticCode.invalidRepeatCount,
            "A repeat count must be an integer value.",
            statement.count.span,
          );
        }
        yield* compileChild(this.#validateBlock(statement.body, scope, loopDepth + 1));
        return;
      case "forStatement": {
        this.#validateExpression(statement.iterable, scope, null);
        if (isDefinitelyNonIterable(statement.iterable)) {
          this.#report(
            semanticCode.invalidLoopSource,
            "A for-loop source must be a list, set, or integer range.",
            statement.iterable.span,
          );
        }
        if (
          statement.iterable.kind === "rangeExpression" &&
          (!isKnownInteger(statement.iterable.start) || !isKnownInteger(statement.iterable.end))
        ) {
          this.#report(
            semanticCode.invalidRangeOperand,
            "A statically known iterated range must have integer bounds.",
            statement.iterable.span,
          );
        }
        const loopScope = new SemanticScope(scope);
        this.#declare(statement.variable.name, "variable", statement.variable.span, loopScope);
        yield* compileChild(
          this.#validateStatements(statement.body.statements, loopScope, loopDepth + 1),
        );
        return;
      }
      case "whileStatement":
        this.#validateExpression(statement.condition, scope, null);
        yield* compileChild(this.#validateBlock(statement.body, scope, loopDepth + 1));
        return;
      case "breakStatement":
      case "continueStatement":
        if (loopDepth === 0) {
          this.#report(
            semanticCode.invalidLoopControl,
            `'${statement.kind === "breakStatement" ? "break" : "continue"}' may only appear inside a loop.`,
            statement.span,
          );
        }
        return;
      case "functionDeclaration":
        this.#report(
          semanticCode.nestedFunction,
          "Nested function declarations are not supported in this milestone.",
          statement.span,
        );
        return;
      case "returnStatement":
        if (this.#functionDepth === 0) {
          this.#report(
            semanticCode.returnOutsideFunction,
            "'return' may only appear inside a function.",
            statement.span,
          );
        } else if (this.#handlerDepth > 0 && statement.value !== null) {
          this.#report(
            semanticCode.invalidTimer,
            this.#handlerOwner === "timer"
              ? "A timer expiry block may use 'return' only without a value."
              : "A media block may use 'return' only without a value.",
            statement.value.span,
          );
        }
        if (statement.value !== null) {
          this.#validateExpression(statement.value, scope, null);
        }
        return;
      case "exitStatement":
      case "endStatement":
        return;
      case "labelStatement":
        if (scope !== this.#root || this.#functionDepth > 0) {
          this.#report(
            semanticCode.invalidLabel,
            `A label stands only in the outer level of a file, not inside a block, loop, function, or handler. Move 'label ${statement.name.name}' out of the block; a goto may still jump to it from anywhere in the file.`,
            statement.span,
          );
        }
        return;
      case "gotoStatement":
        if (!this.#unreachable)
          this.#gotos.push({ label: statement.label.name, context: this.#context });
        if (!this.#labels.has(statement.label.name)) {
          this.#report(
            semanticCode.invalidLabel,
            `This file has no label '${statement.label.name}'. Add 'label ${statement.label.name}' in the outer level of the file.`,
            statement.label.span,
          );
        }
        return;
    }
  }

  #validateFunction(declaration: FunctionDeclaration): void {
    const names = new Set<string>();
    let sawDefault = false;
    const bodyScope = new SemanticScope(this.#root);
    for (const parameter of declaration.parameters) {
      const duplicate = names.has(parameter.name.name);
      if (duplicate) {
        this.#report(
          semanticCode.duplicateParameter,
          `Duplicate function parameter '${parameter.name.name}'.`,
          parameter.name.span,
        );
      }
      names.add(parameter.name.name);
      if (parameter.defaultValue === null && sawDefault) {
        this.#report(
          semanticCode.requiredAfterDefault,
          "Required parameters must precede parameters with defaults.",
          parameter.span,
        );
      }
      sawDefault ||= parameter.defaultValue !== null;
      if (!duplicate) {
        this.#declare(parameter.name.name, "variable", parameter.name.span, bodyScope);
      }
    }

    const defaultScope = new SemanticScope(this.#root);
    const laterNameCounts = new Map<string, number>();
    for (const parameter of declaration.parameters) {
      const name = parameter.name.name;
      laterNameCounts.set(name, (laterNameCounts.get(name) ?? 0) + 1);
    }
    for (const parameter of declaration.parameters) {
      const name = parameter.name.name;
      const remaining = (laterNameCounts.get(name) ?? 1) - 1;
      if (remaining === 0) {
        laterNameCounts.delete(name);
      } else {
        laterNameCounts.set(name, remaining);
      }
      if (parameter.defaultValue !== null) {
        const blockingInteraction = findFirstInteraction(parameter.defaultValue);
        if (blockingInteraction !== null) {
          this.#report(
            semanticCode.unsupportedBlockingContext,
            blockingInteraction.kind === "playMediaExpression"
              ? "Media playback is not supported in function parameter defaults."
              : "Blocking interactions are not supported in function parameter defaults.",
            blockingInteraction.span,
          );
        }
        this.#reportLaterParameterReferences(parameter.defaultValue, laterNameCounts);
        this.#validateExpression(parameter.defaultValue, defaultScope, null);
      }
      defaultScope.declare(name, { kind: "variable" });
    }

    this.#functionDepth += 1;
    try {
      runCompileTask(this.#validateStatements(declaration.body.statements, bodyScope, 0));
    } finally {
      this.#functionDepth -= 1;
    }
  }

  *#validateBlock(block: Block, parent: SemanticScope, loopDepth: number): CompileTask<void> {
    yield* compileChild(
      this.#validateStatements(block.statements, new SemanticScope(parent), loopDepth),
    );
  }

  #validateAssignmentTarget(target: AssignmentTarget, scope: SemanticScope): void {
    if (target.kind === "identifier") {
      const binding = scope.resolve(target.name);
      this.#recordRootAccess(target.name, binding, target.span);
      if (binding === undefined) {
        this.#report(
          semanticCode.unknownAssignment,
          `Cannot assign to unknown variable '${target.name}'.`,
          target.span,
        );
      } else if (binding.kind === "function") {
        this.#report(
          semanticCode.functionAssignment,
          `Cannot assign to function '${target.name}'.`,
          target.span,
        );
      } else if (binding.kind !== "variable") {
        this.#report(
          semanticCode.invalidAssignment,
          `Cannot replace ${binding.kind} '${target.name}'.`,
          target.span,
        );
      }
      return;
    }

    this.#validateExpression(target.object, scope, null);
    if (target.kind === "indexExpression") {
      this.#validateExpression(target.index, scope, null);
      this.#validateListIndex(target.index);
    }
  }

  /** Reports a list index the compiler can see is negative; the type check reports one that is not a whole number. */
  #validateListIndex(index: Expression): void {
    const known = staticNumber(index);
    if (known !== undefined && known < 0)
      this.#report(
        semanticCode.invalidListIndex,
        "A list index cannot be negative. The first element is at index 0, and the last at length - 1.",
        index.span,
      );
  }

  #validateExpression(
    expression: Expression,
    scope: SemanticScope,
    contextualSpeaker: string | null,
  ): void {
    return runCompileTask(this.#validateExpressionTask(expression, scope, contextualSpeaker));
  }

  *#validateExpressionTask(
    expression: Expression,
    scope: SemanticScope,
    contextualSpeaker: string | null,
  ): CompileTask<void> {
    while (expression.kind === "parenthesizedExpression" || expression.kind === "unaryExpression") {
      expression =
        expression.kind === "parenthesizedExpression" ? expression.expression : expression.operand;
    }
    switch (expression.kind) {
      case "booleanLiteral":
      case "nullLiteral":
      case "numberLiteral":
      case "durationLiteral":
        return;
      case "stringLiteral":
        for (const part of expression.parts) {
          if (part.kind === "stringInterpolation") {
            yield* compileChild(
              this.#validateExpressionTask(part.expression, scope, contextualSpeaker),
            );
          }
        }
        return;
      case "interactionExpression": {
        const contextualSpeaker = this.#interactionSpeaker(expression.speaker, scope);
        if (expression.interactionKind === "choice") {
          yield* compileChild(this.#validateChoiceTask(expression, scope, contextualSpeaker));
        } else {
          if (expression.hint !== null) {
            yield* compileChild(
              this.#validateExpressionTask(expression.hint, scope, contextualSpeaker),
            );
          }
          if (expression.defaultValue !== null) {
            yield* compileChild(
              this.#validateExpressionTask(expression.defaultValue, scope, contextualSpeaker),
            );
          }
        }
        return;
      }
      case "identifier":
        if (expression.name === "speaker" && contextualSpeaker !== null) return;
        const binding = scope.resolve(expression.name);
        this.#recordRootAccess(expression.name, binding, expression.span);
        if (binding === undefined) {
          if (this.#builtins.has(expression.name)) {
            this.#report(
              semanticCode.functionValue,
              `Builtin '${expression.name}' is not a first-class runtime value.`,
              expression.span,
            );
          } else {
            this.#report(
              semanticCode.unknownVariable,
              `Unknown variable '${expression.name}'.`,
              expression.span,
            );
          }
        } else if (binding.kind === "function") {
          this.#report(
            semanticCode.functionValue,
            `Function '${expression.name}' is not a first-class runtime value.`,
            expression.span,
          );
        }
        return;
      case "listLiteral":
      case "setLiteral":
        yield* compileChild(
          this.#validateCollectionExpressionTask(expression, scope, contextualSpeaker),
        );
        return;
      case "objectLiteral":
        yield* compileChild(
          this.#validateCollectionExpressionTask(expression, scope, contextualSpeaker),
        );
        return;
      case "dictLiteral": {
        // Keys the source shows must differ; keys known only at runtime replace earlier entries instead.
        const keys = new Set<string>();
        for (const entry of expression.entries) {
          yield* compileChild(this.#validateExpressionTask(entry.key, scope, contextualSpeaker));
          const key = staticChoiceValue(entry.key)?.value;
          if (typeof key === "string") {
            if (keys.has(key))
              this.#report(
                semanticCode.duplicateProperty,
                `Duplicate dict key ${JSON.stringify(key)}. Each key appears once; remove one of the entries.`,
                entry.key.span,
              );
            keys.add(key);
          }
          yield* compileChild(this.#validateExpressionTask(entry.value, scope, contextualSpeaker));
        }
        return;
      }
      case "propertyAccessExpression":
        yield* compileChild(
          this.#validateExpressionTask(expression.object, scope, contextualSpeaker),
        );
        this.#validateTimerHandleMember(expression.object, expression.property, scope, "read");
        return;
      case "showButtonExpression":
        yield* compileChild(this.#validateShowButtonTask(expression, scope));
        return;
      case "timerExpression":
        this.#validateTimer(expression, scope, true);
        return;
      case "playMediaExpression":
        yield* compileChild(this.#validateMediaTask(expression, scope, true, null));
        return;
      case "loadExpression":
        yield* compileChild(this.#validateExpressionTask(expression.key, scope, contextualSpeaker));
        if (isDefinitelyNonString(expression.key)) {
          this.#report(semanticCode.invalidStorageKey, LOAD_KEY_MESSAGE, expression.key.span);
        }
        if (expression.defaultValue !== null) {
          yield* compileChild(
            this.#validateExpressionTask(expression.defaultValue, scope, contextualSpeaker),
          );
        }
        return;
      case "indexExpression":
        yield* compileChild(
          this.#validateExpressionTask(expression.object, scope, contextualSpeaker),
        );
        yield* compileChild(
          this.#validateExpressionTask(expression.index, scope, contextualSpeaker),
        );
        this.#validateListIndex(expression.index);
        return;
      case "callExpression": {
        const authorFunction =
          expression.callee.kind === "identifier" &&
          scope.resolve(expression.callee.name)?.kind === "function" &&
          this.#functions.has(expression.callee.name);
        // Only an author function's parameters are known here; for every other callee a repeated name is still an error.
        if (!authorFunction) this.#validateDistinctNamedArguments(expression);
        // Grouping a method does not detach it from its receiver: `(text.trim)()` calls `text.trim()`.
        const method = unwrapParentheses(expression.callee);
        if (expression.callee.kind === "identifier") {
          const name = expression.callee.name;
          const binding = scope.resolve(name);
          const declaration = this.#functions.get(name);
          if (declaration !== undefined && binding?.kind === "function") {
            if (!this.#unreachable) this.#calls.push({ name, context: this.#context });
            this.#validateFunctionCall(expression, declaration);
          } else if (this.#builtins.has(name)) {
            // The type check checks the arguments of the core built-ins it knows.
          } else if (binding !== undefined) {
            this.#report(
              semanticCode.nonCallable,
              `'${name}' is a ${binding.kind}, not a callable function.`,
              expression.callee.span,
            );
          } else {
            this.#report(
              semanticCode.unknownFunction,
              `Unknown function '${name}'.`,
              expression.callee.span,
            );
          }
        } else if (method.kind === "propertyAccessExpression") {
          yield* compileChild(
            this.#validateExpressionTask(method.object, scope, contextualSpeaker),
          );
          this.#validateTimerHandleMember(
            method.object,
            method.property,
            scope,
            "call",
            undefined,
            expression.arguments,
          );
        } else {
          yield* compileChild(
            this.#validateExpressionTask(expression.callee, scope, contextualSpeaker),
          );
        }
        for (const argument of expression.arguments) {
          yield* compileChild(
            this.#validateExpressionTask(argument.value, scope, contextualSpeaker),
          );
        }
        if (
          method.kind === "propertyAccessExpression" &&
          method.property.name === "removeAt" &&
          expression.arguments.length === 1 &&
          expression.arguments[0]!.kind === "positionalArgument"
        )
          this.#validateListIndex(expression.arguments[0]!.value);
        if (
          expression.callee.kind === "identifier" &&
          expression.callee.name === "randomInteger" &&
          expression.arguments.length === 1
        ) {
          const argument = expression.arguments[0]!.value;
          if (
            argument.kind === "rangeExpression" &&
            (!isKnownInteger(argument.start) || !isKnownInteger(argument.end))
          ) {
            this.#report(
              semanticCode.invalidRangeOperand,
              "A statically known randomInteger range must have integer bounds.",
              argument.span,
            );
          }
        }
        return;
      }
      case "binaryExpression": {
        yield* compileChild(
          this.#validateExpressionTask(expression.left, scope, contextualSpeaker),
        );
        yield* compileChild(
          this.#validateExpressionTask(expression.right, scope, contextualSpeaker),
        );
        const left = literalKind(expression.left);
        const right = literalKind(expression.right);
        const mixed =
          (left === "numberLiteral" && right === "durationLiteral") ||
          (left === "durationLiteral" && right === "numberLiteral");
        // Durations scale by numbers (`d * n`, `n * d`, `d / n`); every other mixed operator has no meaning.
        const scaling =
          expression.operator === "*" ||
          (expression.operator === "/" && left === "durationLiteral") ||
          ["==", "!=", "and", "or"].includes(expression.operator);
        if (mixed && !scaling) {
          this.#report(
            semanticCode.mixedDurationOperands,
            "A number and a duration cannot be combined with this operator; give both a unit, or group a number before its unit as in '(1 + 2) s'.",
            expression.span,
          );
        }
        return;
      }
      case "rangeExpression":
        yield* compileChild(
          this.#validateExpressionTask(expression.start, scope, contextualSpeaker),
        );
        yield* compileChild(this.#validateExpressionTask(expression.end, scope, contextualSpeaker));
        if (
          expression.start.kind === "rangeExpression" ||
          expression.end.kind === "rangeExpression"
        ) {
          this.#report(semanticCode.chainedRange, "Ranges may not be chained.", expression.span);
        }
        if (isDefinitelyNonNumeric(expression.start) || isDefinitelyNonNumeric(expression.end)) {
          this.#report(
            semanticCode.invalidRangeOperand,
            "Range bounds must be numeric values.",
            expression.span,
          );
        }
        return;
      case "typeTestExpression":
        yield* compileChild(
          this.#validateExpressionTask(expression.value, scope, contextualSpeaker),
        );
        return;
    }
    expression satisfies never;
  }

  #validateStorageKey(key: Expression, scope: SemanticScope, message: string): void {
    this.#validateExpression(key, scope, null);
    if (isDefinitelyNonString(key)) this.#report(semanticCode.invalidStorageKey, message, key.span);
  }

  #interactionSpeaker(
    speaker: Extract<Expression, { kind: "interactionExpression" }>["speaker"],
    scope: SemanticScope,
  ): string | null {
    return speaker === null
      ? "speaker"
      : this.#validateSpeakerReference(speaker.name, speaker.span, scope)
        ? speaker.name
        : null;
  }

  /** Validates the operands of a statement or expression `showButton` in source order. */
  *#validateShowButtonTask(parts: ShowButtonParts, scope: SemanticScope): CompileTask<void> {
    const contextualSpeaker = this.#interactionSpeaker(parts.speaker, scope);
    yield* compileChild(this.#validateExpressionTask(parts.label, scope, contextualSpeaker));
    for (const option of showButtonOptions(parts)) {
      yield* compileChild(this.#validateExpressionTask(option.value, scope, contextualSpeaker));
      if (option.name === "background") this.#validateButtonBackground(option.value);
      else this.#validateButtonTimeout(option.value);
    }
  }

  /**
   * When the compiler can fully evaluate a timeout, it reports every failure the runtime would hit: a value of zero or
   * less, or one scene time cannot reach; an overflowing step is a visible-overflow error like anywhere else. The type
   * checker requires a number or a duration, and the runtime checks the values the compiler cannot know.
   */
  #validateButtonTimeout(expression: Expression): void {
    const milliseconds = knownMilliseconds(expression, null);
    if (milliseconds !== undefined && milliseconds <= 0)
      this.#report(
        semanticCode.invalidRepeatCount,
        "The showButton timeout must be greater than zero. Remove 'timeout:' to wait for the click without a time limit.",
        expression.span,
      );
    else if (beyondSceneTime(expression, null))
      this.#report(
        semanticCode.invalidRepeatCount,
        "The showButton timeout is too long for scene time to reach. Use a shorter timeout, or remove 'timeout:' to wait without a time limit.",
        expression.span,
      );
  }

  #validateButtonBackground(expression: Expression): void {
    // The type checker checks that the colour is text; a known text must name an opaque colour.
    const text = staticVisibleText(expression);
    if (text !== undefined && normalizeOpaqueColor(text) === null)
      this.#report(
        semanticCode.invalidInteractionChoice,
        "Expected an opaque CSS button background colour.",
        expression.span,
      );
  }

  *#validateChoiceTask(
    expression: Extract<Expression, { kind: "interactionExpression" }>,
    scope: SemanticScope,
    contextualSpeaker: string | null,
  ): CompileTask<void> {
    if (expression.options.length === 0) {
      this.#report(
        semanticCode.invalidInteractionChoice,
        "A choice requires at least one option.",
        expression.span,
      );
      return;
    }
    // The type checker checks what each button shows and returns, and how many buttons a choice has. Values of
    // different types, such as an identifier and a number before ':', make a union (#511 C2).
    let empty = true;
    for (const option of expression.options) {
      yield* compileChild(
        this.#validateExpressionTask(option.expression, scope, contextualSpeaker),
      );
      const content = unwrapParentheses(option.expression);
      if (content.kind !== "listLiteral" && content.kind !== "setLiteral") {
        empty = false;
        this.#validateChoiceObject(content, option.value);
        continue;
      }
      if (content.elements.length > 0) empty = false;
      for (const element of content.elements)
        this.#validateChoiceObject(unwrapParentheses(element), option.value);
    }
    if (empty)
      this.#report(
        semanticCode.invalidInteractionChoice,
        "A choice needs at least one button, but its option lists are empty.",
        expression.span,
      );
  }

  /**
   * Checks the properties of a choice object that gives one button. `value` is the value written before the option's
   * `:`, which every button of a list or set option returns.
   */
  #validateChoiceObject(entry: Expression, value: InteractionChoiceOption["value"]): void {
    if (entry.kind !== "objectLiteral") return;
    if (!entry.properties.some((property) => property.name.name === "text"))
      this.#report(
        semanticCode.invalidInteractionChoice,
        "A choice object requires text.",
        entry.span,
      );
    for (const property of entry.properties) {
      const name = property.name.name;
      if (name === "background") this.#validateButtonBackground(property.value);
      else if (name === "text") continue;
      else if (name === "value" && value !== null)
        this.#report(
          semanticCode.invalidInteractionChoice,
          "This choice option has two values, one before ':' and one in its value property. Keep one.",
          property.name.span,
        );
      else if (name !== "value")
        this.#report(
          semanticCode.invalidInteractionChoice,
          "Choice objects support value, text, and background only.",
          property.name.span,
        );
    }
  }

  *#validateCollectionExpressionTask(
    root: Extract<Expression, { kind: "listLiteral" | "setLiteral" | "objectLiteral" }>,
    scope: SemanticScope,
    contextualSpeaker: string | null,
  ): CompileTask<void> {
    if (root.kind === "objectLiteral") {
      const names = new Set<string>();
      for (const property of root.properties) {
        if (names.has(property.name.name))
          this.#report(
            semanticCode.duplicateProperty,
            `Duplicate object property '${property.name.name}'.`,
            property.name.span,
          );
        names.add(property.name.name);
        yield* compileChild(this.#validateExpressionTask(property.value, scope, contextualSpeaker));
      }
      return;
    }
    for (const element of root.elements)
      yield* compileChild(this.#validateExpressionTask(element, scope, contextualSpeaker));
  }

  /**
   * Positional arguments fill parameters from left to right; named arguments that follow them fill parameters by name.
   * Each parameter receives at most one value, and every parameter without a default needs one.
   */
  #validateFunctionCall(
    expression: Extract<Expression, { kind: "callExpression" }>,
    declaration: FunctionDeclaration,
  ): void {
    const positional = expression.arguments.filter(
      (argument) => argument.kind === "positionalArgument",
    );
    const named = expression.arguments.filter((argument) => argument.kind === "namedArgument");
    const functionName = declaration.name.name;
    const parameterNames = declaration.parameters.map((parameter) => parameter.name.name);
    const required = declaration.parameters.filter(
      (parameter) => parameter.defaultValue === null,
    ).length;
    if (positional.length > parameterNames.length) {
      this.#report(
        semanticCode.argumentCount,
        `Function '${functionName}' takes ${argumentRange(required, parameterNames)}, received ${positional.length} positional argument${positional.length === 1 ? "" : "s"}. Remove the extra positional arguments.`,
        expression.span,
      );
      return;
    }
    if (named.length === 0) {
      if (positional.length < required)
        this.#report(
          semanticCode.argumentCount,
          `Function '${functionName}' takes ${argumentRange(required, parameterNames)}, received ${positional.length}. Add the missing arguments.`,
          expression.span,
        );
      return;
    }
    const indexes = new Map(parameterNames.map((name, index) => [name, index]));
    const supplied = new Set(parameterNames.slice(0, positional.length));
    for (const argument of named) {
      const name = argument.name.name;
      const index = indexes.get(name);
      if (index === undefined) {
        this.#report(
          semanticCode.unknownNamedArgument,
          `Function '${functionName}' has no parameter '${name}'. ${parameterNames.length === 0 ? "It takes no arguments." : `Its parameters are ${parameterNames.join(", ")}.`}`,
          argument.name.span,
        );
      } else if (index < positional.length) {
        this.#report(
          semanticCode.duplicateNamedArgument,
          `Parameter '${name}' already receives positional argument ${index + 1}. Remove one of the two.`,
          argument.name.span,
        );
      } else if (supplied.has(name)) {
        this.#report(
          semanticCode.duplicateNamedArgument,
          `Argument '${name}' is given twice. Remove one of them.`,
          argument.name.span,
        );
      }
      supplied.add(name);
    }
    for (const parameter of declaration.parameters) {
      if (parameter.defaultValue === null && !supplied.has(parameter.name.name)) {
        this.#report(
          semanticCode.missingNamedArgument,
          `Function '${functionName}' needs a value for '${parameter.name.name}'. Add it by position or as '${parameter.name.name}: ...'.`,
          expression.span,
        );
      }
    }
  }

  /** Reports a parameter name given twice in a call whose parameters only the callee knows. */
  #validateDistinctNamedArguments(
    expression: Extract<Expression, { kind: "callExpression" }>,
  ): void {
    const names = new Set<string>();
    for (const argument of expression.arguments) {
      if (argument.kind !== "namedArgument") continue;
      if (names.has(argument.name.name))
        this.#report(
          semanticCode.duplicateNamedArgument,
          `Argument '${argument.name.name}' is given twice. Remove one of them.`,
          argument.name.span,
        );
      names.add(argument.name.name);
    }
  }

  #reportLaterParameterReferences(
    expression: Expression,
    laterNameCounts: ReadonlyMap<string, number>,
  ): void {
    visitExpression(expression, (identifier) => {
      if (!laterNameCounts.has(identifier.name)) return;
      this.#report(
        semanticCode.laterParameterDefault,
        `Default expression may not reference later parameter '${identifier.name}'.`,
        identifier.span,
      );
    });
  }

  #declare(name: string, kind: BindingKind, span: SourceSpan, scope: SemanticScope): boolean {
    if (this.#protectedNames.has(name)) {
      this.#report(
        semanticCode.duplicateDeclaration,
        `Declaration '${name}' conflicts with a protected TeaseScript name. Choose another name, such as '${name}Value'.`,
        span,
      );
      return false;
    }
    if (scope.declare(name, { kind })) return true;
    this.#report(
      semanticCode.duplicateDeclaration,
      `Declaration '${name}' duplicates a visible name.`,
      span,
    );
    return false;
  }

  #recordRootAccess(name: string, binding: Binding | undefined, span: SourceSpan): void {
    if (
      !this.#unreachable &&
      binding?.kind === "variable" &&
      this.#root.bindings.get(name) === binding
    ) {
      this.#rootAccesses.push({ name, span, context: this.#context });
    }
  }

  /**
   * A goto can reach a label without running the top-level `let`s between the place it starts and the label. A use of
   * a variable of the file is an error when a goto can make it miss its `let`: it has a value on every way there
   * without gotos, but not on every way with them. A goto has run what came before the statement it stands in, or
   * before the call of its function or the start of its handler. Other early uses, such as a function called before
   * the `let`, are checked when they run.
   */
  #checkInitializationAtLabels(program: Program): void {
    const withGotos = this.#initializedVariables(program, true);
    const withoutGotos = this.#initializedVariables(program, false);
    const reported = new Set<string>();
    for (const access of this.#rootAccesses) {
      const known = withGotos(access.context);
      const knownWithoutGotos = withoutGotos(access.context);
      if (
        known === null ||
        known.has(access.name) ||
        (knownWithoutGotos !== null && !knownWithoutGotos.has(access.name))
      )
        continue;
      const key = `${access.span.start.offset}:${access.name}`;
      if (reported.has(key)) continue;
      reported.add(key);
      this.#report(
        semanticCode.skippedInitialization,
        `A goto can reach this line without running 'let ${access.name}' first, so ${access.name} may have no value here. Move the label that the goto jumps to before 'let ${access.name}', or set ${access.name} on every way here.`,
        access.span,
      );
    }
  }

  /**
   * The top-level variables that have a value wherever code of a context runs, following gotos or not. `null` stands
   * for "every variable": no way there is known, so nothing is missing.
   */
  #initializedVariables(
    program: Program,
    followGotos: boolean,
  ): (context: FlowContext) => ReadonlySet<string> | null {
    type Known = ReadonlySet<string> | null;
    const statements = program.statements;
    const meet = (left: Known, right: Known): Known =>
      left === null
        ? right
        : right === null
          ? left
          : new Set([...left].filter((name) => right.has(name)));
    const before: Known[] = statements.map((_, index) => (index === 0 ? new Set() : null));
    const after = (index: number): Known => {
      const known = before[index]!;
      const statement = statements[index]!;
      return known !== null && statement.kind === "letStatement"
        ? new Set([...known, statement.name.name])
        : known;
    };
    const functionStart = new Map<string, Known>();
    const atContext = (context: FlowContext): Known =>
      context.kind === "root"
        ? before[context.statement]!
        : context.kind === "function"
          ? (functionStart.get(context.name) ?? null)
          : context.kind === "handler"
            ? atContext(context.origin)
            : null;
    for (let changed = true; changed;) {
      changed = false;
      // A function starts with what every call of it has run; one never called adds nothing.
      for (let functionsChanged = true; functionsChanged;) {
        functionsChanged = false;
        const starts = new Map<string, Known>();
        for (const call of this.#calls) {
          starts.set(
            call.name,
            starts.has(call.name)
              ? meet(starts.get(call.name)!, atContext(call.context))
              : atContext(call.context),
          );
        }
        for (const [name, known] of starts) {
          if (!sameKnown(functionStart.get(name) ?? null, known)) {
            functionStart.set(name, known);
            functionsChanged = true;
          }
        }
      }
      for (let index = 1; index < statements.length; index += 1) {
        let known: Known = continuesAfter(statements[index - 1]!) ? after(index - 1) : null;
        const statement = statements[index]!;
        if (followGotos && statement.kind === "labelStatement") {
          for (const goto of this.#gotos) {
            if (goto.label === statement.name.name) known = meet(known, atContext(goto.context));
          }
        }
        if (!sameKnown(before[index]!, known)) {
          before[index] = known;
          changed = true;
        }
      }
    }
    return atContext;
  }

  #validateSpeakerReference(name: string, span: SourceSpan, scope: SemanticScope): boolean {
    if (scope.resolve(name)?.kind === "speaker") return true;
    this.#report(semanticCode.unknownSpeaker, `Unknown speaker '${name}'.`, span);
    return false;
  }

  #report(code: string, message: string, span: SourceSpan): void {
    this.diagnostics.push(createDiagnostic(DiagnosticSeverity.Error, code, message, span));
  }
}

/** The literal kind of an operand, looking through parentheses and unary signs. */
function literalKind(expression: Expression): Expression["kind"] {
  let current = unwrapParentheses(expression);
  while (current.kind === "unaryExpression" && current.operator !== "not") {
    current = unwrapParentheses(current.operand);
  }
  return current.kind;
}

/** "2 arguments (a, b)" or "1 to 3 arguments (a, b, c)", naming the parameters so the author sees what is expected. */
function argumentRange(required: number, parameterNames: readonly string[]): string {
  const total = parameterNames.length;
  const count =
    required === total
      ? `${total} argument${total === 1 ? "" : "s"}`
      : `${required} to ${total} arguments`;
  return total === 0 ? "no arguments" : `${count} (${parameterNames.join(", ")})`;
}

/** The handle kind statically held by a variable initialized from `expression`. */
function handleKind(expression: Expression): "timer" | "media" | null {
  expression = unwrapParentheses(expression);
  if (expression.kind === "timerExpression" && expression.async) return "timer";
  if (expression.kind === "playMediaExpression" && expression.async) return "media";
  return null;
}

function isTrueLiteral(expression: Expression): boolean {
  expression = unwrapParentheses(expression);
  return expression.kind === "booleanLiteral" && expression.value;
}

function isIndefiniteRepeatValue(repeat: MediaParts["repeat"]): boolean {
  return repeat?.kind === "value" && isTrueLiteral(repeat.value);
}

/** A statically known media position in milliseconds: a duration literal or a number of seconds. */
function staticDurationMs(expression: Expression): number | undefined {
  let current = unwrapParentheses(expression);
  let sign = 1;
  while (current.kind === "unaryExpression" && current.operator !== "not") {
    if (current.operator === "-") sign = -sign;
    current = unwrapParentheses(current.operand);
  }
  if (current.kind === "durationLiteral") {
    // A calendar duration has no fixed length, so it gives no media position.
    const parts = durationLiteralParts(current);
    return typeof parts === "string" || !isExactDuration(parts)
      ? undefined
      : sign * parts.milliseconds;
  }
  const seconds = staticNumber(expression);
  return seconds === undefined ? undefined : seconds * 1_000;
}

/** A statically evident wrong value for an assignable timer handle property. */
function invalidTimerAssignment(name: string, value: Expression): string | null {
  if (name === "display") {
    const text = staticVisibleText(value);
    return isDefinitelyNonText(value) || (text !== undefined && !TIMER_DISPLAYS.has(text))
      ? 'Timer display must be "visible", "mystery", or "hidden".'
      : null;
  }
  return literalKind(value) !== "durationLiteral" && isDefinitelyNonDuration(value)
    ? `Timer ${name} must be assigned a duration such as 10 s.`
    : null;
}

function isDefinitelyNonDuration(expression: Expression): boolean {
  const kind = literalKind(expression);
  return (
    kind === "numberLiteral" ||
    kind === "stringLiteral" ||
    kind === "booleanLiteral" ||
    kind === "nullLiteral" ||
    kind === "listLiteral" ||
    kind === "setLiteral" ||
    kind === "objectLiteral" ||
    kind === "dictLiteral" ||
    kind === "rangeExpression"
  );
}

/** A literal that can never be a file reference string or `null`. */
function isDefinitelyNonFileReference(expression: Expression): boolean {
  const kind = literalKind(expression);
  return (
    kind === "numberLiteral" ||
    kind === "durationLiteral" ||
    kind === "booleanLiteral" ||
    kind === "listLiteral" ||
    kind === "setLiteral" ||
    kind === "objectLiteral" ||
    kind === "dictLiteral" ||
    kind === "rangeExpression" ||
    kind === "showButtonExpression" ||
    kind === "timerExpression" ||
    kind === "playMediaExpression" ||
    kind === "unaryExpression"
  );
}

function isDefinitelyNonText(expression: Expression): boolean {
  expression = unwrapParentheses(expression);
  return (
    expression.kind === "numberLiteral" ||
    expression.kind === "durationLiteral" ||
    expression.kind === "booleanLiteral" ||
    expression.kind === "nullLiteral" ||
    expression.kind === "listLiteral" ||
    expression.kind === "setLiteral" ||
    expression.kind === "objectLiteral" ||
    expression.kind === "dictLiteral" ||
    expression.kind === "rangeExpression"
  );
}

/**
 * The milliseconds of a known wait, timer, or timeout duration: a number counts seconds, or `unit`, and a duration its
 * own milliseconds. `undefined` when the value is not known or not a finite quantity.
 */
function knownMilliseconds(expression: Expression, unit: DurationUnit | null): number | undefined {
  const known = staticQuantity(expression);
  if (known === undefined) return undefined;
  if (typeof known === "number") return known * DURATION_UNIT_MILLISECONDS[unit ?? "s"];
  // A duration with a trailing unit is a type error of its own, and a calendar duration has no fixed length.
  return unit === null && isExactDuration(durationParts(known)) ? known.milliseconds : undefined;
}

/** Scene time is at most `Number.MAX_SAFE_INTEGER` milliseconds, so a known longer duration can never be reached. */
function beyondSceneTime(expression: Expression, unit: DurationUnit | null): boolean {
  const milliseconds = knownMilliseconds(expression, unit);
  return milliseconds !== undefined && !(milliseconds <= Number.MAX_SAFE_INTEGER);
}

function isKnownInteger(expression: Expression): boolean {
  const value = staticNumber(expression);
  return value === undefined || Number.isInteger(value);
}

/** The first interaction or media playback in a parameter default, which cannot pause a default's evaluation. */
function findFirstInteraction(
  expression: Expression,
): Extract<
  Expression,
  { kind: "interactionExpression" | "showButtonExpression" | "playMediaExpression" }
> | null {
  const work = [expression];
  while (work.length) {
    const current = work.pop()!;
    if (
      current.kind === "interactionExpression" ||
      current.kind === "showButtonExpression" ||
      current.kind === "playMediaExpression"
    )
      return current;
    const children = expressionChildren(current);
    for (let i = children.length - 1; i >= 0; i--) work.push(children[i]!);
  }
  return null;
}

function unwrapParentheses(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}

function isDefinitelyNonNumeric(expression: Expression): boolean {
  expression = unwrapParentheses(expression);
  if (expression.kind === "interactionExpression") {
    if (expression.interactionKind === "number" || expression.interactionKind === "integer")
      return false;
    if (expression.interactionKind !== "choice") return true;
    // A choice returns the type its values share, which the type checker knows.
    return false;
  }
  return (
    expression.kind === "stringLiteral" ||
    expression.kind === "booleanLiteral" ||
    expression.kind === "nullLiteral" ||
    expression.kind === "listLiteral" ||
    expression.kind === "setLiteral" ||
    expression.kind === "objectLiteral" ||
    expression.kind === "dictLiteral" ||
    expression.kind === "rangeExpression" ||
    expression.kind === "durationLiteral" ||
    expression.kind === "showButtonExpression" ||
    expression.kind === "timerExpression" ||
    expression.kind === "playMediaExpression"
  );
}

const LOAD_KEY_MESSAGE =
  "Storage key must be a string. To compare the loaded value, write '(load \"k\") == null'.";

const NON_STRING_OPERATORS: ReadonlySet<string> = new Set([
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "and",
  "or",
]);

/** A storage key that can never evaluate to a string, such as the comparison in `load "k" == null`. */
function isDefinitelyNonString(expression: Expression): boolean {
  expression = unwrapParentheses(expression);
  if (expression.kind === "binaryExpression") return NON_STRING_OPERATORS.has(expression.operator);
  return (
    expression.kind === "numberLiteral" ||
    expression.kind === "durationLiteral" ||
    expression.kind === "booleanLiteral" ||
    expression.kind === "nullLiteral" ||
    expression.kind === "listLiteral" ||
    expression.kind === "setLiteral" ||
    expression.kind === "objectLiteral" ||
    expression.kind === "dictLiteral" ||
    expression.kind === "rangeExpression" ||
    expression.kind === "unaryExpression" ||
    expression.kind === "showButtonExpression" ||
    expression.kind === "timerExpression" ||
    expression.kind === "playMediaExpression"
  );
}

function isDefinitelyNonIterable(expression: Expression): boolean {
  expression = unwrapParentheses(expression);
  return (
    expression.kind === "stringLiteral" ||
    expression.kind === "booleanLiteral" ||
    expression.kind === "nullLiteral" ||
    expression.kind === "numberLiteral" ||
    expression.kind === "objectLiteral" ||
    expression.kind === "interactionExpression" ||
    expression.kind === "showButtonExpression"
  );
}

function visitExpression(
  expression: Expression,
  visitor: (identifier: Extract<Expression, { kind: "identifier" }>) => void,
): void {
  const work = [expression];
  while (work.length) {
    const current = work.pop()!;
    if (current.kind === "identifier") visitor(current);
    const children =
      current.kind === "interactionExpression"
        ? [
            ...(current.speaker === null ? [] : [current.speaker]),
            ...(current.hint === null ? [] : [current.hint]),
            ...(current.defaultValue === null ? [] : [current.defaultValue]),
            ...current.options.map((option) => option.expression),
          ]
        : current.kind === "showButtonExpression"
          ? [
              ...(current.speaker === null ? [] : [current.speaker]),
              current.label,
              ...showButtonOptions(current).map((option) => option.value),
            ]
          : expressionChildren(current);
    for (let i = children.length - 1; i >= 0; i--) work.push(children[i]!);
  }
}

function sameKnown(left: ReadonlySet<string> | null, right: ReadonlySet<string> | null): boolean {
  if (left === null || right === null) return left === right;
  return left.size === right.size && [...left].every((name) => right.has(name));
}

/** Whether execution can continue after a top-level statement; a transfer, or an `if` whose branches all transfer, ends it. */
function continuesAfter(statement: Statement): boolean {
  return !endsInTransfer(statement);
}

function endsInTransfer(statement: Statement | Block): boolean {
  switch (statement.kind) {
    case "gotoStatement":
    case "exitStatement":
    case "endStatement":
    case "returnStatement":
      return true;
    case "block":
      return statement.statements.length > 0 && endsInTransfer(statement.statements.at(-1)!);
    case "ifStatement":
      return (
        statement.elseBlock !== null &&
        endsInTransfer(statement.thenBlock) &&
        endsInTransfer(statement.elseBlock)
      );
    default:
      return false;
  }
}
