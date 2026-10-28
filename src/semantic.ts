import {
  argumentCountMessage,
  missingDefaultMessage,
  unknownNamedArgumentMessage,
} from "./argument-rules.js";
import type {
  AssignmentTarget,
  Block,
  Expression,
  FileTarget,
  FunctionDeclaration,
  Identifier,
  LetStatement,
  MediaParts,
  Program,
  RegexLiteral,
  SayParts,
  ShowButtonParts,
  ShowPermanentButtonParts,
  Statement,
  TagQueryExpression,
  TimerParts,
} from "./ast.js";
import { isAskImageCall, isLockCall, isTakePhotoCall } from "./capture-call.js";
import { compileChild, runCompileTask, type CompileTask } from "./compiler/continuation.js";
import type { Diagnostic } from "./diagnostics.js";
import { changesEntries } from "./dict-operations.js";
import {
  askOperands,
  askParts,
  expressionChildren,
  mediaHandlerBlocks,
  mediaOperands,
  sayOperands,
  showButtonOptions,
  tagQueryOperands,
  timerOperands,
} from "./expression-children.js";
import {
  COMMANDS,
  CORE_RUNTIME_BUILTINS,
  FOREIGN_FORMS,
  KEYWORD_TOKENS,
  PLATFORM_STANDARD_LIBRARY_PRELUDE,
  PROTECTED_NAME_CODE,
  protectedNameMessage,
  RENAMED_BUILTINS,
  RENAMED_METHODS,
  RENAMED_VALUES,
  TEASESCRIPT_GRAMMAR_KEYWORDS,
  TEASESCRIPT_PROTECTED_NAMES,
} from "./language-facts.js";
import { changesElements, reordersList } from "./list-methods.js";
import { duplicateEntryMessage } from "./object-properties.js";
import { noteSharing, rootName, type Sharing } from "./operation-checks.js";
import { isPathGlob, MAIN_FILE_PATH, type UnreadablePackageFile } from "./project-paths.js";
import type { StatementFlow } from "./reachability.js";
import { canonicalRegexFlags, compileRegex, regexFlagProblem } from "./regex.js";
import {
  validateAskImageArguments,
  validateDistinctNamedArguments,
  validateExportTextArguments,
  validateFunctionCall,
  validateOpenUrlArguments,
  validateShowPopupArguments,
} from "./semantic/call-arguments.js";
import { semanticCode, type NamePassCode } from "./semantic/diagnostics.js";
import { literalText, unwrapParentheses } from "./semantic/expressions.js";
import { checkInitialization, type FlowContext } from "./semantic/initialization.js";
import { ProjectNames } from "./semantic/project-names.js";
import {
  SemanticScope,
  type Binding,
  type BindingKind,
  type VariableSite,
} from "./semantic/scope.js";
import { validateStartValue } from "./semantic/start-values.js";
import {
  reportUnreadableFiles,
  taggedCandidates,
  validateScriptReference,
  validateTransferTarget,
} from "./semantic/transfers.js";
import { createSourcePosition, createSourceSpan, type SourceSpan } from "./source.js";
import { PLAYER, SPEAKER_NAME_LISTS } from "./speaker-terms.js";
import { validateSwitchCases } from "./switch-cases.js";
import type { Tag } from "./tags.js";

export interface SemanticValidationOptions {
  readonly globals?: readonly string[];
  readonly builtins?: readonly string[];
  /** The package files and folders that the host could not load (#595); a path written out that names one is an error. */
  readonly unreadableFiles?: readonly UnreadablePackageFile[];
}

export interface SemanticValidationResult {
  readonly diagnostics: readonly Diagnostic[];
}

/** Validates one source as the `main.tease` of a single-file project. */
export function validateSemantics(
  program: Program,
  options: SemanticValidationOptions = {},
): SemanticValidationResult {
  return Object.freeze({
    diagnostics: validateProjectSemantics([{ path: MAIN_FILE_PATH, program }], options)[0]!
      .diagnostics,
  });
}

/** The name checks of one file; the transfer and initialization checks wait for the flow of the type check. */
export interface FileSemanticResult {
  readonly diagnostics: readonly Diagnostic[];
  /** The files each glob target may pick, in project order. */
  readonly picks: ReadonlyMap<FileTarget, readonly string[]>;
  /** The files the host could not load that a path or glob written out in the file names (see `reportUnreadableFiles`). */
  readonly unreadableNamed: ReadonlySet<string>;
  /** The files each `goto tagged` or `call tagged` may pick, by the tags of their headers (see `taggedCandidates`). */
  readonly taggedPicks: ReadonlyMap<Statement, readonly string[]>;
  /** How each `call` of a file names it, for the check of the running file that follows the plan. */
  readonly fileCalls: ReadonlyMap<Statement, FileCallTarget>;
  /**
   * The files that the script references of the whole project may name, by its `script(...)` calls and
   * `findScripts(...)` lists, or `null` for any file (see `ProjectNames.referencedScripts`).
   */
  readonly referencedScripts: ReadonlySet<string> | null;
  /** The variables each timer, media, or button block shares with the code that created it (V30 §14). */
  readonly captures: ReadonlyMap<Block, readonly string[]>;
  /** The declarations of the shared variables that a block assigns or changes in place, with how. */
  readonly sharedWrites: ReadonlyMap<VariableSite, Sharing>;
  /** The `let` declarations whose variables some code assigns, stores into, or changes or reorders in place. */
  readonly writtenLets: ReadonlySet<LetStatement>;
  /** The globals that some code of the file assigns, stores into, or changes or reorders in place. */
  readonly writtenGlobals: ReadonlySet<string>;
  /** The speaker that each `speaker` names: the one a message names with `as`, or whose properties use it. */
  readonly speakers: ReadonlyMap<Identifier, string>;
  /** Checks the uses of top-level variables after labels that a goto may reach before their `let` ran. */
  checkInitialization(flow: StatementFlow): readonly Diagnostic[];
}

/**
 * How a `call` names the file it starts (V30 §29): a path written out, also in `script(...)`, a glob, a tagged pick, or
 * another computed target. `paths` holds the files it may start: the one it names, those the glob may pick, those the
 * tagged pick may match by `taggedPicks`, or `null` for a computed target, which may start any file a reference names.
 */
export interface FileCallTarget {
  readonly form: "path" | "glob" | "tagged" | "computed";
  readonly paths: readonly string[] | null;
  /** The tagged pick, whose bounds and computed lists the check that follows the plan reads by their known values. */
  readonly query: TagQueryExpression | null;
  readonly span: SourceSpan;
}

/** A file of a project by its package path, in project order: `main.tease` first, then the others by path. */
export interface ProjectProgram {
  readonly path: string;
  readonly program: Program;
  /**
   * The tags of the file's header, which a `call tagged` matches; `null` for a file of declarations only, and
   * `undefined` when the tags are not known.
   */
  readonly tags?: readonly Tag[] | null;
}

/**
 * Validates the names of a project's files together. Globals, global functions, and speakers belong to the whole
 * project (ADR 0022 §3, §6); every other name belongs to its file. `validate` selects the files whose statements are
 * validated; the others only contribute their project names, for example while they have syntax errors. `onFile` hears
 * of each file before it is validated.
 */
export function validateProjectSemantics(
  files: readonly ProjectProgram[],
  options: SemanticValidationOptions = {},
  validate: (file: number) => boolean = () => true,
  onFile: (file: number) => void = () => {},
): readonly FileSemanticResult[] {
  const project = new ProjectNames(files, options);
  const validators = files.map((file, index) => {
    if (!validate(index)) return null;
    onFile(index);
    const validator = new SemanticValidator(options, project, index);
    validator.validate(file.program);
    return validator;
  });
  return project.diagnostics.map((diagnostics, index) =>
    Object.freeze({
      diagnostics: Object.freeze([...diagnostics]),
      picks: validators[index]?.picks ?? new Map<FileTarget, readonly string[]>(),
      unreadableNamed: validators[index]?.unreadableNamed ?? new Set<string>(),
      taggedPicks: validators[index]?.taggedPicks ?? new Map<Statement, readonly string[]>(),
      fileCalls: validators[index]?.fileCalls ?? new Map<Statement, FileCallTarget>(),
      referencedScripts: project.referencedScripts,
      captures: validators[index]?.captures ?? new Map<Block, readonly string[]>(),
      sharedWrites: validators[index]?.sharedWrites ?? new Map<VariableSite, Sharing>(),
      writtenLets: validators[index]?.writtenLets ?? new Set<LetStatement>(),
      writtenGlobals: validators[index]?.writtenGlobals ?? new Set<string>(),
      speakers: validators[index]?.speakers ?? new Map<Identifier, string>(),
      checkInitialization: (flow: StatementFlow) =>
        validators[index]?.checkInitialization(files[index]!.program, flow) ?? [],
    }),
  );
}

/**
 * The names that a host may not configure, as a global or a built-in, because the language gives them a meaning of its
 * own: the grammar keywords, such as `if` and `load`, and `wait`, which the lexer reads as a token of its own; the
 * commands and asks, which the parser reads by name; `takePhoto` and `askImage`, whose calls wait for the Player;
 * `pi`, which the parser reads as the number it names; and `debugMode`, which the engine reads from the session.
 */
const UNCONFIGURABLE_NAMES: ReadonlySet<string> = new Set([
  ...TEASESCRIPT_GRAMMAR_KEYWORDS,
  ...KEYWORD_TOKENS.keys(),
  ...Object.keys(COMMANDS),
  "takePhoto",
  "askImage",
  "pi",
  "debugMode",
]);

/** How a message names the resource whose block is validated. */
const HANDLER_NAMES = { timer: "timer", media: "media", button: "button" } as const;

/** A timer expiry block, media cue block, or permanent button block, validated after the function bodies. */
interface PendingHandler {
  readonly block: Block;
  readonly owner: "timer" | "media" | "button";
  readonly selfHandle: string | null;
  /**
   * The locals of the code that created the block, as they are visible where it does: the block shares these variables
   * with that code (V30 §14). Its parent holds the file's names, or the project's alone.
   */
  readonly scope: SemanticScope;
  /** The block whose code created this one, or `null` when a function or a file's top level did. */
  readonly parent: PendingHandler | null;
  /** The global function the block is in, directly or through other blocks. */
  readonly globalFunction: FunctionDeclaration | null;
  /** Where the block runs, for the initialization check: in `origin`, when `created` runs. */
  readonly origin: FlowContext;
  readonly created: Statement;
}

/** The public members serve `validateProjectSemantics` and `semantic/`, and are internal to the compiler. */
export class SemanticValidator {
  readonly #builtins: ReadonlySet<string>;

  readonly #protectedNames: ReadonlySet<string>;

  /** The file's own names: its top-level variables and functions, under the project's names. */
  readonly #root: SemanticScope;

  /** The functions of this file to validate. */
  readonly #functions = new Map<string, FunctionDeclaration>();

  /**
   * The global function whose body, parameter defaults, or timer and media blocks are being validated. They are
   * validated under the project's names alone, without the file's own (ADR 0022 §3).
   */
  #globalFunction: FunctionDeclaration | null = null;

  public get globalFunction(): FunctionDeclaration | null {
    return this.#globalFunction;
  }

  readonly #invalidConfiguredNames: readonly string[];

  #functionDepth = 0;

  /**
   * Timer expiry blocks and media cue blocks are validated after all top-level names are known, like function bodies.
   * A media block may bind the handle of its own `let` declaration.
   */
  readonly #pendingHandlers: PendingHandler[] = [];

  #context: FlowContext = { kind: "root", statement: 0 };

  /** Reads and writes of top-level variables, with where they run. */
  readonly rootAccesses: {
    readonly name: string;
    readonly span: SourceSpan;
    readonly context: FlowContext;
    readonly statement: Statement;
  }[] = [];

  /** The innermost statement being checked, which decides whether what it holds can run. */
  #statement: Statement | null = null;
  /** The value of each `say` statement, whose call of an unknown `skippable` or `unskippable` gets a hint. */
  readonly #sayStatementValues = new WeakSet<Expression>();
  /** The questions of asks, whose call of an unknown `prose` or `bubble` is a mode written with its question. */
  readonly #askQuestions = new WeakSet<Expression>();

  /** The `script(...)` call that a transfer statement being checked names directly, as in `goto script("a.tease")`. */
  #directTarget: {
    readonly call: Expression;
    readonly statement: Extract<Statement, { kind: "gotoStatement" | "callFileStatement" }>;
  } | null = null;

  public get directTarget(): {
    readonly call: Expression;
    readonly statement: Extract<Statement, { kind: "gotoStatement" | "callFileStatement" }>;
  } | null {
    return this.#directTarget;
  }

  readonly gotos: {
    readonly label: string;
    readonly context: FlowContext;
    readonly statement: Statement;
  }[] = [];

  readonly calls: {
    readonly name: string;
    readonly context: FlowContext;
    readonly statement: Statement;
  }[] = [];

  public constructor(
    options: SemanticValidationOptions,
    readonly project: ProjectNames,
    readonly file: number,
  ) {
    this.#root = new SemanticScope(project.scope);
    this.#invalidConfiguredNames = Object.freeze(
      [...(options.globals ?? []), ...(options.builtins ?? [])].filter((name) =>
        UNCONFIGURABLE_NAMES.has(name),
      ),
    );
    this.#builtins = new Set([
      ...CORE_RUNTIME_BUILTINS,
      ...PLATFORM_STANDARD_LIBRARY_PRELUDE,
      ...(options.builtins ?? []),
    ]);
    this.#protectedNames = new Set([...TEASESCRIPT_PROTECTED_NAMES, ...(options.builtins ?? [])]);
  }

  /** The files each glob target may pick. */
  readonly picks = new Map<FileTarget, readonly string[]>();

  /** The files the host could not load that a path or glob written out in this file names. */
  readonly unreadableNamed = new Set<string>();

  public validate(program: Program): void {
    // The configuration belongs to the project, so its problems are reported once, in main.tease.
    for (const name of this.file === 0 ? new Set(this.#invalidConfiguredNames) : []) {
      this.report(
        semanticCode.duplicateDeclaration,
        `Configured name '${name}' conflicts with a protected TeaseScript name.`,
        program.span,
      );
    }
    for (const statement of program.statements) {
      if (statement.kind !== "functionDeclaration") continue;
      if (statement.global) {
        if (this.#protectedNames.has(statement.name.name))
          this.#declare(statement.name.name, "function", statement.name.span, this.#root);
        else if (this.project.owns(statement)) this.#functions.set(statement.name.name, statement);
        continue;
      }
      if (this.#functions.has(statement.name.name)) {
        this.report(
          semanticCode.duplicateFunction,
          `Duplicate function declaration '${statement.name.name}'.`,
          statement.name.span,
        );
        continue;
      }
      if (
        this.#declare(statement.name.name, "function", statement.name.span, this.#root, statement)
      ) {
        this.#functions.set(statement.name.name, statement);
      }
    }
    for (const statement of program.statements) {
      if (statement.kind !== "labelStatement") continue;
      const name = statement.name.name;
      if (this.#protectedNames.has(name)) {
        this.report(PROTECTED_NAME_CODE, protectedNameMessage(name, "label"), statement.name.span);
      } else if (this.labels.has(name)) {
        this.report(
          semanticCode.invalidLabel,
          `This file already has a label '${name}'. Give each label in a file its own name.`,
          statement.name.span,
        );
      } else {
        this.labels.add(name);
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
      const handler = this.#pendingHandlers[index]!;
      this.#context = { kind: "handler", origin: handler.origin, created: handler.created };
      this.#handler = handler;
      this.#validateHandler(handler);
    }
    this.#handler = null;
    this.#collectCaptures();
  }

  /**
   * A handler block sees top-level names, the locals of the code that created it, and its own locals. A media block's
   * self-handle is a local of the handler scope, so it shadows any outer name of the same spelling.
   */
  #validateHandler(handler: PendingHandler): void {
    this.#functionDepth += 1;
    this.#handlerDepth += 1;
    this.#handlerOwner = handler.owner;
    this.#globalFunction = handler.globalFunction;
    try {
      const scope = new SemanticScope(handler.scope);
      if (handler.selfHandle !== null) {
        scope.bindings.set(handler.selfHandle, { kind: "variable" });
      }
      runCompileTask(this.#validateStatements(handler.block.statements, scope, 0));
    } finally {
      this.#functionDepth -= 1;
      this.#handlerDepth -= 1;
      this.#globalFunction = null;
    }
  }

  /** The scope a function body or handler block starts under: the file's names, or the project's alone. */
  #outerScope(): SemanticScope {
    return this.#globalFunction === null ? this.#root : this.project.scope;
  }

  /** The block whose statements are being validated, or `null` outside blocks. */
  #handler: PendingHandler | null = null;

  /**
   * The locals by which a block created here shares variables with this code: those visible now, so not one declared
   * later in the same scope, under the file's or the project's names.
   */
  #captureScope(scope: SemanticScope): SemanticScope {
    const outer = this.#outerScope();
    const captures = new SemanticScope(outer, true);
    for (let current: SemanticScope | null = scope; current !== null && current !== outer;) {
      for (const [name, binding] of current.bindings)
        if (!captures.bindings.has(name)) captures.bindings.set(name, binding);
      current = current.parent;
    }
    return captures;
  }

  #pendHandler(
    block: Block,
    owner: PendingHandler["owner"],
    selfHandle: string | null,
    scope: SemanticScope,
  ): void {
    this.#pendingHandlers.push({
      block,
      owner,
      selfHandle,
      scope: scope.captured === null ? this.#captureScope(scope) : scope,
      parent: this.#handler,
      globalFunction: this.#globalFunction,
      origin: this.#context,
      created: this.#statement!,
    });
  }

  /** The variables each block shares with the code that created it, by its block, for the lowering. */
  readonly captures = new Map<Block, readonly string[]>();

  /**
   * The declarations of the variables that a block shares and assigns or changes in place, so a suspension may change
   * them (V30 §13).
   */
  readonly sharedWrites = new Map<VariableSite, Sharing>();

  /** The speaker that each `speaker` names, where a message names it with `as` or its properties use it. */
  readonly speakers = new Map<Identifier, string>();

  /** The `let` declarations whose variables some code assigns, stores into, or changes or reorders in place. */
  readonly writtenLets = new Set<LetStatement>();

  /** The globals that some code of this file assigns, stores into, or changes or reorders in place. */
  readonly writtenGlobals = new Set<string>();

  /**
   * Records that code assigns, stores into, or changes or reorders in place the variable `name` (the root of a place),
   * wherever the code is and whether or not it can run.
   */
  #recordWrite(name: string | null, scope: SemanticScope): void {
    const binding = name === null ? undefined : scope.lookup(name);
    if (binding?.site?.kind === "letStatement") this.writtenLets.add(binding.site);
    else if (binding?.project?.description === "global") this.writtenGlobals.add(name!);
  }

  /** Records that the running block assigns or changes `name`, when that is a variable it shares. */
  #recordSharedWrite(name: string | null, scope: SemanticScope, how: Sharing): void {
    const site = name === null ? undefined : scope.sharedSite(name);
    if (site !== undefined) noteSharing(this.sharedWrites, site, how);
  }

  /**
   * A block that creates another one also shares the variables the inner block uses from outside the outer one. Inner
   * blocks come after the block that created them, so walking backwards completes each block before its creator.
   */
  #collectCaptures(): void {
    for (let index = this.#pendingHandlers.length - 1; index >= 0; index -= 1) {
      const handler = this.#pendingHandlers[index]!;
      const captured = handler.scope.captured!;
      const parent = handler.parent;
      if (parent !== null)
        for (const name of captured) {
          const binding = parent.scope.bindings.get(name);
          if (binding !== undefined && binding === handler.scope.bindings.get(name))
            parent.scope.captured!.add(name);
        }
      this.captures.set(handler.block, [...captured]);
    }
  }

  #handlerDepth = 0;

  /** The labels of the file, which stand only in its outer scope. */
  readonly labels = new Set<string>();

  #handlerOwner: "timer" | "media" | "button" = "timer";

  #validateTimer(timer: TimerParts, scope: SemanticScope, valuePosition: boolean): void {
    for (const operand of timerOperands(timer)) this.validateExpression(operand, scope, null);
    if (!timer.async) {
      const invalid = timer.handler ?? (timer.repeat || timer.persist ? timer : null);
      if (invalid !== null) {
        this.report(
          semanticCode.invalidTimer,
          "Only an async timer may have an expiry block, repeat, or persist.",
          invalid.span,
        );
      }
      if (valuePosition) {
        this.report(
          semanticCode.invalidTimer,
          "A blocking timer returns no handle. Use 'timer async ...' to keep one.",
          timer.span,
        );
      }
    }
    if (timer.handler !== null) this.#pendHandler(timer.handler, "timer", null, scope);
  }

  /** The button text is checked like any shown text; the click action runs later, like a timer expiry block. */
  *#validatePermanentButtonTask(
    button: ShowPermanentButtonParts,
    scope: SemanticScope,
  ): CompileTask<void> {
    yield* compileChild(this.#validateExpressionTask(button.text, scope, null));
    this.#pendHandler(button.handler, "button", null, scope);
  }

  /** The names and form of a play command; the type check checks its values. */
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
    this.#reportUnreadableMedia(media.file);
    if (!media.async && valuePosition) {
      this.report(
        semanticCode.invalidMediaForm,
        `Blocking media returns no handle. Use '${command} async ...' to keep one.`,
        media.span,
      );
    }
    if (media.handlers?.kind === "cues") {
      let finishes = 0;
      for (const cue of media.handlers.cues) {
        if (cue.kind === "finish") {
          finishes += 1;
          if (finishes > 1) {
            this.report(
              semanticCode.invalidMediaForm,
              "A media block may declare 'finish' only once.",
              cue.keywordSpan,
            );
          }
        }
      }
    }
    // The blocks of one media share its variables.
    const captures = this.#captureScope(scope);
    for (const block of mediaHandlerBlocks(media))
      this.#pendHandler(block, "media", media.async ? selfHandle : null, captures);
  }

  *#validateStatements(
    statements: readonly Statement[],
    scope: SemanticScope,
    loopDepth: number,
  ): CompileTask<void> {
    for (const statement of statements) {
      yield* compileChild(this.#validateStatement(statement, scope, loopDepth));
    }
  }

  *#validateStatement(
    statement: Statement,
    scope: SemanticScope,
    loopDepth: number,
  ): CompileTask<void> {
    const outer = this.#statement;
    this.#statement = statement;
    try {
      yield* compileChild(this.#validateStatementKind(statement, scope, loopDepth));
    } finally {
      this.#statement = outer;
    }
  }

  *#validateStatementKind(
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
          this.validateExpression(statement.initializer, scope, null);
        }
        if (this.#declare(statement.name.name, "variable", statement.name.span, scope)) {
          scope.bindings.get(statement.name.name)!.site = statement;
        }
        return;
      }
      case "speakerDeclaration": {
        // Speakers belong to the project, which declared them already.
        if (statement.name.name === PLAYER)
          this.report(
            PROTECTED_NAME_CODE,
            protectedNameMessage(PLAYER, "speaker"),
            statement.name.span,
          );
        const declared =
          statement.name.name === PLAYER
            ? false
            : this.#protectedNames.has(statement.name.name)
              ? this.#declare(statement.name.name, "speaker", statement.name.span, scope)
              : this.project.owns(statement);
        const names = new Set<string>();
        for (const property of statement.properties) {
          if (names.has(property.name.name)) {
            this.report(
              semanticCode.duplicateProperty,
              duplicateEntryMessage("speaker", property.name.name),
              property.name.span,
            );
          }
          names.add(property.name.name);
          validateStartValue(
            this,
            property.value,
            scope,
            statement,
            declared ? statement.name.name : null,
          );
        }
        return;
      }
      case "globalStatement":
        if (this.#protectedNames.has(statement.name.name))
          this.#declare(statement.name.name, "variable", statement.name.span, scope);
        // The assignment runs exactly when the declaration does, so what it uses keeps the declaration as its statement.
        if (statement.assignment !== null)
          yield* compileChild(this.#validateStatementKind(statement.assignment, scope, loopDepth));
        validateStartValue(this, statement.initial, scope, statement, null);
        return;
      case "speakerSetterStatement":
        this.#validateSpeakerReference(statement.speaker.name, statement.speaker.span, scope);
        return;
      case "sayStatement":
        yield* compileChild(this.#validateSayTask(statement, scope, true));
        return;
      case "showButtonStatement":
        yield* compileChild(this.#validateShowButtonTask(statement, scope));
        return;
      case "waitStatement":
        this.validateExpression(statement.duration, scope, null);
        return;
      case "timerStatement":
        this.#validateTimer(statement, scope, false);
        return;
      case "showPermanentButtonStatement":
        yield* compileChild(this.#validatePermanentButtonTask(statement, scope));
        return;
      case "playMediaStatement":
        yield* compileChild(this.#validateMediaTask(statement, scope, false, null));
        return;
      case "showImageStatement":
        this.validateExpression(statement.image, scope, null);
        this.#reportUnreadableMedia(statement.image);
        return;
      case "hideImageStatement":
      case "showCameraStatement":
      case "hideCameraStatement":
      case "stopAudioStatement":
        return;
      case "showPopupStatement":
        validateShowPopupArguments(this, statement);
        for (const argument of statement.arguments)
          this.validateExpression(argument.value, scope, null);
        return;
      case "openUrlStatement":
        validateOpenUrlArguments(this, statement);
        for (const argument of statement.arguments)
          this.validateExpression(argument.value, scope, null);
        return;
      case "exportTextStatement":
        validateExportTextArguments(this, statement);
        for (const argument of statement.arguments)
          this.validateExpression(argument.value, scope, null);
        return;
      case "saveStatement":
        this.validateExpression(statement.value, scope, null);
        this.validateExpression(statement.key, scope, null);
        return;
      case "deleteStatement":
        this.validateExpression(statement.key, scope, null);
        return;
      case "assignmentStatement":
        this.#validateAssignmentTarget(statement.target, scope);
        this.validateExpression(statement.value, scope, null);
        return;
      case "expressionStatement":
        this.validateExpression(statement.expression, scope, null);
        return;
      case "ifStatement":
        this.validateExpression(statement.condition, scope, null);
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
        this.validateExpression(statement.subject, scope, null);
        validateSwitchCases(
          statement,
          (name) => scope.resolve(name)?.kind === "speaker",
          (code, message, span) => this.report(code, message, span),
        );
        for (const switchCase of statement.cases) {
          yield* compileChild(this.#validateBlock(switchCase.body, scope, loopDepth));
        }
        if (statement.defaultBlock !== null) {
          yield* compileChild(this.#validateBlock(statement.defaultBlock, scope, loopDepth));
        }
        return;
      case "repeatStatement":
        this.validateExpression(statement.count, scope, null);
        yield* compileChild(this.#validateBlock(statement.body, scope, loopDepth + 1));
        return;
      case "forStatement": {
        this.validateExpression(statement.iterable, scope, null);
        const loopScope = new SemanticScope(scope);
        if (this.#declare(statement.variable.name, "variable", statement.variable.span, loopScope))
          loopScope.bindings.get(statement.variable.name)!.site = statement;
        if (
          statement.valueVariable !== null &&
          this.#declare(
            statement.valueVariable.name,
            "variable",
            statement.valueVariable.span,
            loopScope,
          )
        )
          loopScope.bindings.get(statement.valueVariable.name)!.site = statement.valueVariable;
        yield* compileChild(
          this.#validateStatements(statement.body.statements, loopScope, loopDepth + 1),
        );
        return;
      }
      case "whileStatement":
        this.validateExpression(statement.condition, scope, null);
        yield* compileChild(this.#validateBlock(statement.body, scope, loopDepth + 1));
        return;
      case "breakStatement":
      case "continueStatement":
        if (loopDepth === 0) {
          this.report(
            semanticCode.invalidLoopControl,
            `'${statement.kind === "breakStatement" ? "break" : "continue"}' may only appear inside a loop.`,
            statement.span,
          );
        }
        return;
      case "functionDeclaration":
        this.report(
          semanticCode.nestedFunction,
          "Nested function declarations are not supported in this milestone.",
          statement.span,
        );
        return;
      case "returnStatement":
        if (this.#functionDepth === 0) {
          this.report(
            semanticCode.returnOutsideFunction,
            "'return' may only appear inside a function.",
            statement.span,
          );
        } else if (this.#handlerDepth > 0 && statement.value !== null) {
          this.report(
            semanticCode.invalidTimer,
            this.#handlerOwner === "timer"
              ? "A timer expiry block may use 'return' only without a value."
              : this.#handlerOwner === "media"
                ? "A media block may use 'return' only without a value."
                : "A button block may use 'return' only without a value.",
            statement.value.span,
          );
        }
        if (statement.value !== null) {
          this.validateExpression(statement.value, scope, null);
        }
        return;
      case "exitStatement":
      case "endStatement":
        return;
      case "labelStatement":
        if (scope !== this.#root || this.#functionDepth > 0) {
          this.report(
            semanticCode.invalidLabel,
            `A label stands only in the outer level of a file, not inside a block, loop, function, or handler. Move 'label ${statement.name.name}' out of the block. A goto may still jump to it from anywhere in the file.`,
            statement.span,
          );
        }
        return;
      case "gotoStatement":
      case "callFileStatement": {
        const target = statement.target;
        if (target.kind === "scriptTarget") {
          const expression = unwrapParentheses(target.expression);
          this.#directTarget = { call: expression, statement };
          this.validateExpression(target.expression, scope, null);
          this.#directTarget = null;
          if (expression.kind === "tagQueryExpression" && expression.catalog === "scripts") {
            const candidates = taggedCandidates(this, expression);
            this.taggedPicks.set(statement, candidates);
            if (statement.kind === "callFileStatement")
              this.fileCalls.set(statement, {
                form: "tagged",
                paths: candidates,
                query: expression,
                span: target.span,
              });
          } else if (statement.kind === "callFileStatement" && !this.fileCalls.has(statement))
            this.fileCalls.set(statement, {
              form: "computed",
              paths: null,
              query: null,
              span: target.span,
            });
          return;
        }
        if (!validateTransferTarget(this, target, statement.kind)) return;
        if (target.kind === "fileTarget") {
          if (statement.kind === "callFileStatement")
            this.fileCalls.set(statement, {
              form: isPathGlob(target.path) ? "glob" : "path",
              paths: this.picks.get(target) ?? [target.path],
              query: null,
              span: target.pathSpan,
            });
        } else {
          // A goto to a label of the same file keeps the file's variables.
          this.gotos.push({
            label: target.label.name,
            context: this.#context,
            statement: this.#statement!,
          });
        }
        return;
      }
    }
  }

  /** A media or image file written out names it, not a glob. */
  #reportUnreadableMedia(file: Expression): void {
    const path = literalText(file);
    if (path !== undefined) reportUnreadableFiles(this, path, file.span, false);
  }

  /** The files that each `goto tagged` or `call tagged` may pick, by its tag tests and literal tag lists. */
  readonly taggedPicks = new Map<Statement, readonly string[]>();

  /** How each `call` of a file names it (see `FileSemanticResult.fileCalls`). */
  readonly fileCalls = new Map<Statement, FileCallTarget>();

  #validateFunction(declaration: FunctionDeclaration): void {
    this.#globalFunction = declaration.global ? declaration : null;
    try {
      this.#validateFunctionParts(declaration);
    } finally {
      this.#globalFunction = null;
    }
  }

  #validateFunctionParts(declaration: FunctionDeclaration): void {
    const names = new Set<string>();
    let sawDefault = false;
    const bodyScope = new SemanticScope(this.#outerScope());
    for (const parameter of declaration.parameters) {
      const duplicate = names.has(parameter.name.name);
      if (duplicate) {
        this.report(
          semanticCode.duplicateParameter,
          `Duplicate function parameter '${parameter.name.name}'.`,
          parameter.name.span,
        );
      }
      names.add(parameter.name.name);
      if (parameter.defaultValue === null && sawDefault) {
        this.report(
          semanticCode.requiredAfterDefault,
          "Required parameters must precede parameters with defaults.",
          parameter.span,
        );
      }
      sawDefault ||= parameter.defaultValue !== null;
      if (
        !duplicate &&
        this.#declare(parameter.name.name, "variable", parameter.name.span, bodyScope)
      ) {
        bodyScope.bindings.get(parameter.name.name)!.site = parameter;
      }
    }

    const defaultScope = new SemanticScope(this.#outerScope());
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
          this.report(
            semanticCode.unsupportedBlockingContext,
            blockingInteraction.kind === "playMediaExpression"
              ? "Media playback is not supported in function parameter defaults."
              : blockingInteraction.kind === "showCameraExpression"
                ? "Camera views are not supported in function parameter defaults."
                : blockingInteraction.kind === "sayExpression"
                  ? "A say is not supported in function parameter defaults."
                  : isTakePhotoCall(blockingInteraction)
                    ? "Camera capture is not supported in function parameter defaults."
                    : isLockCall(blockingInteraction) &&
                        blockingInteraction.kind === "callExpression" &&
                        blockingInteraction.callee.kind === "identifier"
                      ? `${blockingInteraction.callee.name}(...) is not supported in function parameter defaults, because it may ask the player. Call it in the function's body.`
                      : "Blocking interactions are not supported in function parameter defaults.",
            blockingInteraction.span,
          );
        }
        this.#reportLaterParameterReferences(parameter.defaultValue, laterNameCounts);
        this.validateExpression(parameter.defaultValue, defaultScope, null);
      }
      defaultScope.declare(name, { kind: "variable", site: parameter });
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
    this.#recordWrite(rootName(target), scope);
    // A store into an element or property changes the variable that holds it in place.
    this.#recordSharedWrite(
      rootName(target),
      scope,
      target.kind === "identifier" ? "assigns" : "changes",
    );
    if (target.kind === "identifier") {
      if (target.name === "debugMode") {
        this.report(
          semanticCode.invalidAssignment,
          "Cannot assign to 'debugMode', which is read-only.",
          target.span,
        );
        return;
      }
      if (target.name === "playerProfile") {
        this.#reportPlayerProfileChange(target, true);
        return;
      }
      const binding = scope.resolve(target.name);
      this.#recordRootAccess(target.name, binding, target.span);
      if (binding === undefined) {
        if (!this.#reportFileName(target.name, target.span))
          this.report(
            semanticCode.unknownAssignment,
            `Cannot assign to unknown variable '${target.name}'.`,
            target.span,
          );
      } else if (binding.kind === "function") {
        this.report(
          semanticCode.functionAssignment,
          `Cannot assign to function '${target.name}'.`,
          target.span,
        );
      } else if (binding.kind !== "variable") {
        this.report(
          semanticCode.invalidAssignment,
          `Cannot replace ${binding.kind} '${target.name}'.`,
          target.span,
        );
      }
      return;
    }

    if (rootName(target) === "playerProfile") {
      this.#reportPlayerProfileChange(target, true);
      return;
    }
    this.validateExpression(target.object, scope, null);
    if (target.kind === "indexExpression") {
      this.validateExpression(target.index, scope, null);
    }
  }

  /**
   * Reports a store into the player profile at `place` (`store`), or a change of one of its lists through it: a script
   * changes the profile only through `askProfileChange(...)` (V30 §37).
   */
  #reportPlayerProfileChange(place: Expression, store: boolean): void {
    let field = unwrapParentheses(place);
    while (
      (field.kind === "propertyAccessExpression" || field.kind === "indexExpression") &&
      unwrapParentheses(field.object).kind !== "identifier"
    )
      field = unwrapParentheses(field.object);
    const name = field.kind === "propertyAccessExpression" ? field.property.name : null;
    // An assignment of the profile or one of its fields itself, as opposed to a change inside it.
    const assigned =
      store && field === unwrapParentheses(place) && (name !== null || field.kind === "identifier");
    const label = name === null ? "playerProfile" : `playerProfile.${name}`;
    const instead =
      name !== null ? `'player.${name}'` : assigned ? "the player's fields" : "its field";
    this.report(
      semanticCode.invalidAssignment,
      `Cannot ${assigned ? "assign to" : "change"} '${label}': the player profile changes only through 'askProfileChange(...)', which the player approves. Copy it into the player with 'player.copyFrom(playerProfile)' and ${assigned ? "assign" : "change"} ${instead} instead.`,
      place.span,
    );
  }

  validateExpression(
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
    while (
      expression.kind === "parenthesizedExpression" ||
      expression.kind === "unaryExpression" ||
      expression.kind === "unitExpression" ||
      expression.kind === "angleExpression"
    ) {
      expression =
        expression.kind === "parenthesizedExpression" ? expression.expression : expression.operand;
    }
    switch (expression.kind) {
      case "booleanLiteral":
      case "nullLiteral":
      case "numberLiteral":
      case "durationLiteral":
        return;
      case "regexLiteral":
        this.#validateRegexLiteral(expression);
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
          if (expression.question !== null) this.#askQuestions.add(expression.question);
          for (const operand of askOperands(expression))
            yield* compileChild(this.#validateExpressionTask(operand, scope, contextualSpeaker));
        }
        return;
      }
      case "identifier":
        if (expression.name === "speaker" && contextualSpeaker !== null) {
          if (contextualSpeaker !== "speaker") this.speakers.set(expression, contextualSpeaker);
          // Without `as`, a message has the default speaker, which a script that never sets one cannot have.
          else if (!this.project.setsDefaultSpeaker)
            this.report(
              semanticCode.noSpeaker,
              "This message has no speaker, so 'speaker' has no value: it names none with 'as', and the script never sets a default speaker. Give it one with 'as name', or set a default speaker with 'speaker name'.",
              expression.span,
            );
          return;
        }
        // Protected, so never a binding: the engine reads it from the session.
        if (expression.name === "debugMode") return;
        if (expression.name === "playerProfile") {
          this.report(
            semanticCode.functionValue,
            "'playerProfile' is not a value of its own. Read one of its fields, as in 'playerProfile.firstName', or copy it into the player with 'player.copyFrom(playerProfile)'.",
            expression.span,
          );
          return;
        }
        const binding = scope.resolve(expression.name);
        this.#recordRootAccess(expression.name, binding, expression.span);
        if (binding === undefined) {
          if (
            this.#builtins.has(expression.name) ||
            expression.name === "takePhoto" ||
            expression.name === "askImage" ||
            expression.name === "showPopup" ||
            expression.name === "openUrl" ||
            expression.name === "exportText"
          ) {
            this.report(
              semanticCode.functionValue,
              `Builtin '${expression.name}' is not a first-class runtime value.`,
              expression.span,
            );
          } else if (
            !this.#reportFileName(expression.name, expression.span) &&
            !this.#reportForeignName(expression.name, expression.span)
          ) {
            const renamed = RENAMED_VALUES.get(expression.name);
            this.report(
              semanticCode.unknownVariable,
              `Unknown variable '${expression.name}'.${renamed === undefined ? "" : ` Use '${renamed}'.`}`,
              expression.span,
            );
          }
        } else if (binding.kind === "function") {
          this.report(
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
      case "dictLiteral":
        for (const entry of expression.entries) {
          yield* compileChild(this.#validateExpressionTask(entry.key, scope, contextualSpeaker));
          yield* compileChild(this.#validateExpressionTask(entry.value, scope, contextualSpeaker));
        }
        return;
      case "propertyAccessExpression":
        // The player profile is read by its fields, which the type check knows.
        if (isPlayerProfile(expression.object)) return;
        yield* compileChild(
          this.#validateExpressionTask(expression.object, scope, contextualSpeaker),
        );
        return;
      case "showButtonExpression":
        yield* compileChild(this.#validateShowButtonTask(expression, scope));
        return;
      case "showPopupExpression":
        validateShowPopupArguments(this, expression);
        for (const argument of expression.arguments)
          yield* compileChild(this.#validateExpressionTask(argument.value, scope, null));
        return;
      case "timerExpression":
        this.#validateTimer(expression, scope, true);
        return;
      case "showPermanentButtonExpression":
        yield* compileChild(this.#validatePermanentButtonTask(expression, scope));
        return;
      case "playMediaExpression":
        yield* compileChild(this.#validateMediaTask(expression, scope, true, null));
        return;
      case "showCameraExpression":
        return;
      case "loadExpression":
        yield* compileChild(this.#validateExpressionTask(expression.key, scope, contextualSpeaker));
        if (expression.defaultValue === null) {
          const key = literalText(expression.key);
          this.report(
            semanticCode.argumentCount,
            missingDefaultMessage(
              `load(${key === undefined ? "key" : JSON.stringify(key)}, default: value)`,
              "for a key that has not been saved",
              "Add one, such as 'default: 0', or 'default: null' to check for a missing value with '!= null'.",
            ),
            expression.span,
            true,
          );
        } else {
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
        return;
      case "callExpression": {
        const authorFunction =
          expression.callee.kind === "identifier" &&
          scope.resolve(expression.callee.name)?.declaration !== undefined;
        // Only an author function's parameters are known here; for every other callee a repeated name is still an error.
        if (!authorFunction) validateDistinctNamedArguments(this, expression);
        // Grouping a method does not detach it from its receiver: `(text.trim)()` calls `text.trim()`.
        const method = unwrapParentheses(expression.callee);
        // A list or dict of the player profile changes in place as one of anything else does, also when a list is
        // reordered; a text of the player profile reverses into a new text.
        const changes =
          method.kind === "propertyAccessExpression" &&
          (changesElements(method.property.name) || changesEntries(method.property.name));
        if (
          method.kind === "propertyAccessExpression" &&
          rootName(method.object) === "playerProfile" &&
          (changes || (reordersList(method.property.name) && isPlayerProfileList(method.object)))
        ) {
          this.#reportPlayerProfileChange(method.object, false);
          return;
        }
        if (method.kind === "propertyAccessExpression" && changes)
          this.#recordSharedWrite(rootName(method.object), scope, "changes");
        if (
          method.kind === "propertyAccessExpression" &&
          (changes || reordersList(method.property.name))
        )
          this.#recordWrite(rootName(method.object), scope);
        if (expression.callee.kind === "identifier") {
          const name = expression.callee.name;
          const binding = scope.resolve(name);
          if (isTakePhotoCall(expression)) {
            const positional = expression.arguments.filter(
              (argument) => argument.kind === "positionalArgument",
            ).length;
            if (positional > 0)
              this.report(
                semanticCode.argumentCount,
                argumentCountMessage(
                  "takePhoto",
                  "no arguments without a name",
                  positional,
                  `Name its tags, as in 'takePhoto(tags: ["bedroom"])'.`,
                ),
                expression.span,
              );
            for (const argument of expression.arguments)
              if (argument.kind === "namedArgument" && argument.name.name !== "tags")
                this.report(
                  semanticCode.unknownNamedArgument,
                  unknownNamedArgumentMessage("takePhoto", argument.name.name, ["tags"]),
                  argument.name.span,
                );
          } else if (isAskImageCall(expression)) {
            validateAskImageArguments(this, expression);
            // `askImage` has no `as`, so the default speaker asks: `speaker` in its mode and in every argument is that
            // speaker, as in a basic ask.
            if (expression.presentation !== undefined)
              yield* compileChild(
                this.#validateExpressionTask(expression.presentation, scope, "speaker"),
              );
          } else if (name === "openUrl" || name === "exportText") {
            // A statement of its own is an `openUrlStatement` or an `exportTextStatement`.
            this.report(
              semanticCode.functionValue,
              `${name}(...) gives no value, so it can only be a statement of its own.`,
              expression.callee.span,
            );
          } else if (binding?.declaration !== undefined) {
            // The initialization check follows the calls of this file's functions.
            if (this.#functions.get(name) === binding.declaration)
              this.calls.push({ name, context: this.#context, statement: this.#statement! });
            validateFunctionCall(this, expression, binding.declaration);
          } else if (this.#builtins.has(name)) {
            // The type check checks the arguments of the core built-ins it knows.
            if (name === "script") validateScriptReference(this, expression);
          } else if (binding !== undefined) {
            this.report(
              semanticCode.nonCallable,
              `'${name}' is a ${binding.kind}, not a callable function.`,
              expression.callee.span,
            );
          } else if (name === "removePermanentButton") {
            // A permanent button removes itself, as a timer stops itself (#836).
            const [button] = expression.arguments;
            const unwrapped = button === undefined ? undefined : unwrapParentheses(button.value);
            this.report(
              semanticCode.unknownFunction,
              `removePermanentButton(...) is replaced by the button's own remove(), like stop() on a timer. ${
                unwrapped?.kind === "identifier" && expression.arguments.length === 1
                  ? `Write '${unwrapped.name}.remove()'.`
                  : "Call remove() on the button that showPermanentButton gave, as in 'button.remove()'."
              }`,
              expression.callee.span,
            );
          } else if (RENAMED_BUILTINS.has(name)) {
            this.report(
              semanticCode.unknownFunction,
              `Unknown function '${name}'. Use '${RENAMED_BUILTINS.get(name)}'.`,
              expression.callee.span,
            );
          } else if (unboundValue(name, contextualSpeaker) !== null) {
            this.report(
              semanticCode.nonCallable,
              `'${name}' is ${unboundValue(name, contextualSpeaker)}, not a callable function.`,
              expression.callee.span,
            );
          } else if (
            !this.#reportFileName(name, expression.callee.span) &&
            !this.#reportForeignName(name, expression.callee.span, true)
          ) {
            // A statement reads `say unskippable("Hi")` as a call, as before parentheses could hold a value's text, and an
            // ask reads `askText prose("Name?")` as a question that calls `prose`, as `say` does.
            const hint =
              this.#sayStatementValues.has(expression) &&
              (name === "skippable" || name === "unskippable")
                ? ` To say a message ${name}, write its text without parentheses, as in 'say ${name} "Hi"'. Only a say used as a value, such as 'let line = say ${name} ("Hi", instant)', takes its text in parentheses.`
                : this.#askQuestions.has(expression) && (name === "bubble" || name === "prose")
                  ? ` To show the question as ${name}, write the question after '${name}' without parentheses around it, as in '${name} "Name?"', or give '${name}' its own parentheses first, as in '${name}() ("Name?")'.`
                  : "";
            this.report(
              semanticCode.unknownFunction,
              `Unknown function '${name}'.${hint}`,
              expression.callee.span,
            );
          }
        } else if (method.kind === "propertyAccessExpression") {
          const object = method.object;
          // `console.log(...)` of another language, where no declaration takes `console`.
          if (!(
            object.kind === "identifier" &&
            scope.resolve(object.name) === undefined &&
            this.#root.resolve(object.name) === undefined &&
            this.#reportForeignName(`${object.name}.${method.property.name}`, method.span, true)
          ))
            yield* compileChild(this.#validateExpressionTask(object, scope, contextualSpeaker));
          // No value has a method by an earlier name, so its call names the fix whatever the value is.
          const renamed = RENAMED_METHODS.get(method.property.name);
          if (renamed !== undefined)
            this.report(
              semanticCode.unknownFunction,
              `Unknown method '${method.property.name}'. Use '${renamed}()'.`,
              method.property.span,
            );
        } else {
          yield* compileChild(
            this.#validateExpressionTask(expression.callee, scope, contextualSpeaker),
          );
          // Grouping a name does not make it callable: `(x)()` fails as `x()` does. The check of the name as a value
          // already reports a function, a built-in, or an unknown name.
          if (method.kind === "identifier") {
            const binding = scope.resolve(method.name);
            const kind =
              unboundValue(method.name, contextualSpeaker) ??
              (binding !== undefined && binding.kind !== "function" ? `a ${binding.kind}` : null);
            if (kind !== null)
              this.report(
                semanticCode.nonCallable,
                `'${method.name}' is ${kind}, not a callable function.`,
                method.span,
              );
          } else {
            // Functions are not values, so no other expression, such as `items[0]` or `pick(1)`, gives one to call.
            this.report(
              semanticCode.nonCallable,
              "Only a function or a method can be called. Call a function by its name instead.",
              method.span,
            );
          }
        }
        const argumentSpeaker = isAskImageCall(expression) ? "speaker" : contextualSpeaker;
        for (const argument of expression.arguments) {
          // `copyFrom` takes the player profile as a whole; the type check reports any other form of it.
          if (
            method.kind === "propertyAccessExpression" &&
            method.property.name === "copyFrom" &&
            isPlayerProfile(argument.value)
          )
            continue;
          yield* compileChild(this.#validateExpressionTask(argument.value, scope, argumentSpeaker));
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
          this.report(semanticCode.chainedRange, "Ranges may not be chained.", expression.span);
        }
        return;
      case "typeTestExpression":
        yield* compileChild(
          this.#validateExpressionTask(expression.value, scope, contextualSpeaker),
        );
        return;
      case "sayExpression":
        yield* compileChild(this.#validateSayTask(expression, scope, false));
        return;
      case "tagQueryExpression":
        for (const operand of tagQueryOperands(expression)) {
          yield* compileChild(this.#validateExpressionTask(operand, scope, contextualSpeaker));
        }
        if (expression.from !== null)
          reportUnreadableFiles(this, expression.from.pattern, expression.from.span);
        // `findScripts(...)` makes references to the files it may list.
        if (expression.catalog === "scripts" && expression.select === "list")
          this.project.refer(taggedCandidates(this, expression));
        return;
    }
    expression satisfies never;
  }

  /** A regex literal has valid flags, and RE2 compiles its pattern within the regex limits (V30 §8). */
  #validateRegexLiteral(literal: RegexLiteral): void {
    const flagProblem = regexFlagProblem(literal.flags);
    if (flagProblem !== null) {
      // The flags are the letters at the end of the literal's line.
      const end = literal.span.end;
      const start = createSourcePosition(
        end.offset - literal.flags.length,
        end.line,
        end.column - literal.flags.length,
      );
      this.report(semanticCode.invalidRegex, flagProblem, createSourceSpan(start, end));
      return;
    }
    const compiled = compileRegex(literal.source, canonicalRegexFlags(literal.flags));
    if (!compiled.ok) this.report(semanticCode.invalidRegex, compiled.problem, literal.span);
  }

  /** A `say`, as a statement or a value: its operands under the speaker it chooses, and its presentation and pacing. */
  *#validateSayTask(parts: SayParts, scope: SemanticScope, statement: boolean): CompileTask<void> {
    const contextualSpeaker =
      parts.speaker === null
        ? "speaker"
        : this.#validateSpeakerReference(parts.speaker.name, parts.speaker.span, scope)
          ? parts.speaker.name
          : null;
    if (parts.presentation !== null)
      yield* compileChild(
        this.#validateExpressionTask(parts.presentation, scope, contextualSpeaker),
      );
    if (statement) this.#sayStatementValues.add(parts.value);
    yield* compileChild(this.#validateExpressionTask(parts.value, scope, contextualSpeaker));
    if (parts.pacing !== null && parts.pacing !== "instant")
      yield* compileChild(this.#validateExpressionTask(parts.pacing, scope, contextualSpeaker));
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
    for (const option of showButtonOptions(parts))
      yield* compileChild(this.#validateExpressionTask(option.value, scope, contextualSpeaker));
  }

  *#validateChoiceTask(
    expression: Extract<Expression, { kind: "interactionExpression" }>,
    scope: SemanticScope,
    contextualSpeaker: string | null,
  ): CompileTask<void> {
    // The parser rejects a choice without options (TSP030). The type checker checks the options: what each button
    // shows and returns, and how many buttons a choice has.
    for (const option of expression.options)
      yield* compileChild(
        this.#validateExpressionTask(option.expression, scope, contextualSpeaker),
      );
    if (expression.prefill !== null)
      yield* compileChild(
        this.#validateExpressionTask(expression.prefill, scope, contextualSpeaker),
      );
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
          this.report(
            semanticCode.duplicateProperty,
            duplicateEntryMessage("object", property.name.name),
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

  #reportLaterParameterReferences(
    expression: Expression,
    laterNameCounts: ReadonlyMap<string, number>,
  ): void {
    visitExpression(expression, (identifier) => {
      if (!laterNameCounts.has(identifier.name)) return;
      this.report(
        semanticCode.laterParameterDefault,
        `Default expression may not reference later parameter '${identifier.name}'.`,
        identifier.span,
      );
    });
  }

  #declare(
    name: string,
    kind: BindingKind,
    span: SourceSpan,
    scope: SemanticScope,
    declaration?: FunctionDeclaration,
  ): boolean {
    if (this.#protectedNames.has(name)) {
      this.report(PROTECTED_NAME_CODE, protectedNameMessage(name, "other"), span);
      return false;
    }
    if (scope.declare(name, declaration === undefined ? { kind } : { kind, declaration }))
      return true;
    const project = scope.resolve(name)?.project;
    if (project !== undefined) {
      this.project.reportClash(
        name,
        {
          file: this.file,
          span,
          description:
            kind === "function"
              ? "function"
              : this.#functionDepth > 0
                ? "local variable"
                : "variable",
        },
        project,
      );
      return false;
    }
    this.report(
      semanticCode.duplicateDeclaration,
      scope.isShared(name)
        ? `'${name}' already names a variable of the code that created this ${HANDLER_NAMES[this.#handlerOwner]}, which the block shares. Rename the block's variable.`
        : `Declaration '${name}' duplicates a visible name.`,
      span,
    );
    return false;
  }

  #recordRootAccess(name: string, binding: Binding | undefined, span: SourceSpan): void {
    if (
      this.#statement !== null &&
      binding?.kind === "variable" &&
      this.#root.bindings.get(name) === binding
    ) {
      this.rootAccesses.push({ name, span, context: this.#context, statement: this.#statement });
    }
  }

  /** Checks the uses of top-level variables after labels that a goto may reach before their `let` ran. */
  checkInitialization(program: Program, flow: StatementFlow): readonly Diagnostic[] {
    return checkInitialization(this, program, flow);
  }

  /**
   * Reports a name of the file used inside a global function, which can be called from any file and so sees only the
   * project's names (ADR 0022 §3). Returns whether it did.
   */
  #reportFileName(name: string, span: SourceSpan): boolean {
    const fn = this.#globalFunction;
    const binding = fn === null ? undefined : this.#root.resolve(name);
    if (fn === null || binding === undefined) return false;
    this.report(
      semanticCode.fileName,
      binding.kind === "function"
        ? `Global function '${fn.name.name}' can be called from any file, so it can call only global functions and built-ins, not '${name}' of this file. Make '${name}' a global function.`
        : `Global function '${fn.name.name}' can be called from any file, so it cannot use '${name}' of this file. Make '${name}' a global, or pass it as a parameter.`,
      span,
    );
    return true;
  }

  /**
   * Reports a name of another language that no declaration takes, as `None`, or, where it is `called`, `range(5)`
   * (`FOREIGN_FORMS`), or returns `false`.
   */
  #reportForeignName(written: string, span: SourceSpan, called = false): boolean {
    const foreign = FOREIGN_FORMS.get(written);
    if (foreign?.name === undefined || (foreign.name === "call" && !called)) return false;
    this.report(semanticCode.foreignForm, foreign.message, span);
    return true;
  }

  #validateSpeakerReference(name: string, span: SourceSpan, scope: SemanticScope): boolean {
    if (scope.resolve(name)?.kind === "speaker") return true;
    this.report(semanticCode.unknownSpeaker, `Unknown speaker '${name}'.`, span);
    return false;
  }

  report(code: NamePassCode, message: string, span: SourceSpan, checkable = false): void {
    this.project.report(this.file, code, message, span, checkable);
  }
}

/**
 * The first interaction, media playback, or camera capture in a parameter default, which cannot pause a default's
 * evaluation.
 */
function findFirstInteraction(
  expression: Expression,
): Extract<
  Expression,
  {
    kind:
      | "interactionExpression"
      | "showButtonExpression"
      | "showPopupExpression"
      | "playMediaExpression"
      | "showCameraExpression"
      | "sayExpression"
      | "callExpression";
  }
> | null {
  const work = [expression];
  while (work.length) {
    const current = work.pop()!;
    if (
      current.kind === "interactionExpression" ||
      current.kind === "showButtonExpression" ||
      current.kind === "showPopupExpression" ||
      current.kind === "playMediaExpression" ||
      current.kind === "showCameraExpression" ||
      current.kind === "sayExpression" ||
      (current.kind === "callExpression" &&
        (isTakePhotoCall(current) || isAskImageCall(current) || isLockCall(current)))
    )
      return current;
    const children = expressionChildren(current);
    for (let i = children.length - 1; i >= 0; i--) work.push(children[i]!);
  }
  return null;
}

/** Whether `expression` is a name list of the player profile, as `playerProfile.petNames`. */
function isPlayerProfileList(expression: Expression): boolean {
  const node = unwrapParentheses(expression);
  return (
    node.kind === "propertyAccessExpression" &&
    isPlayerProfile(node.object) &&
    SPEAKER_NAME_LISTS.has(node.property.name)
  );
}

/** Whether `expression` is the protected `playerProfile`, which no binding can have as its name. */
function isPlayerProfile(expression: Expression): boolean {
  const node = unwrapParentheses(expression);
  return node.kind === "identifier" && node.name === "playerProfile";
}

/** What `speaker` is where a speaker is current, or what `debugMode` is: names that are values without a binding. */
function unboundValue(name: string, contextualSpeaker: string | null): string | null {
  if (name === "speaker" && contextualSpeaker !== null) return "the current speaker";
  return name === "debugMode" ? "a read-only value" : null;
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
      current.kind === "sayExpression"
        ? [...(current.speaker === null ? [] : [current.speaker]), ...sayOperands(current)]
        : current.kind === "interactionExpression"
          ? [...(current.speaker === null ? [] : [current.speaker]), ...askParts(current)]
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
